import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, rmdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Skills from '@deepseek-ai/dsh-skill'
import * as Plugin from '../lib/index.js'

const harness = process.env.DSH_SOURCE_ROOT
if (!harness) throw new Error('Set DSH_SOURCE_ROOT to the built Harness checkout')
const { default: LocalFileSystem } = await import(pathToFileURL(resolve(harness, 'packages/fs/fs-local/lib/index.js')).href)
const owned = []
afterEach(async () => {
  for (const { ctx, root } of owned.splice(0)) {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

async function fixture(options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-catalog-provider-'))
  const ctx = new Context()
  owned.push({ ctx, root })
  const skills = join(root, 'skills')
  await mkdir(skills)
  await put(skills, 'alpha', 'Alpha')
  await ctx.plugin(Skills)
  const fsFiber = await ctx.plugin(LocalFileSystem)
  let listCalls = 0
  const originalList = ctx.fs.listDir.bind(ctx.fs)
  ctx.fs.listDir = async (...args) => { listCalls += 1; return await originalList(...args) }
  const fiber = await ctx.plugin(Plugin, {
    includeDefaultRoots: false, customSkillDirs: [skills], watch: true,
    watchStabilityThresholdMs: 20, watchPollIntervalMs: 10, ...options,
  })
  return { ctx, root, skills, fiber, fsFiber, calls: () => listCalls }
}
async function put(root, name, description, body = 'Instructions.') {
  const directory = join(root, name)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`)
}
async function change(ctx, action) {
  const changed = Promise.withResolvers()
  const release = ctx.on('skills/change', () => changed.resolve())
  const timer = setTimeout(() => changed.reject(new Error('Watcher did not invalidate')), 10000)
  try { await action(); await changed.promise }
  finally { clearTimeout(timer); release() }
}

test('different session scopes reuse the same complete filesystem catalog', async () => {
  const f = await fixture()
  const first = await f.ctx.skills.snapshot({ cwd: f.root, scope: {} })
  const calls = f.calls()
  assert.ok(calls > 0)
  const second = await f.ctx.skills.snapshot({ cwd: f.root, scope: {} })
  assert.deepEqual(second, first)
  assert.equal(f.calls(), calls)
})

test('cancelling one concurrent session does not cancel another session catalog', async () => {
  const f = await fixture()
  const entered = Promise.withResolvers()
  const release = Promise.withResolvers()
  const list = f.ctx.fs.listDir.bind(f.ctx.fs)
  f.ctx.fs.listDir = async (...args) => {
    entered.resolve()
    await release.promise
    return await list(...args)
  }
  const abort = new AbortController()
  const first = f.ctx.skills.snapshot({ cwd: f.root, scope: {}, signal: abort.signal })
  const firstRejected = assert.rejects(first, /cancel first/)
  await entered.promise
  const second = f.ctx.skills.snapshot({ cwd: f.root, scope: {}, signal: new AbortController().signal })
  abort.abort(new Error('cancel first'))
  release.resolve()
  await firstRejected
  assert.equal((await second).skills[0].name, 'alpha')
  assert.equal(f.calls(), 1)
})

test('external edits invalidate every session cache and body loading reads current text', async () => {
  const f = await fixture()
  await f.ctx.skills.snapshot({ cwd: f.root, scope: {} })
  await change(f.ctx, () => put(f.skills, 'alpha', 'Changed', 'Changed body.'))
  const updated = await f.ctx.skills.snapshot({ cwd: f.root, scope: {} })
  assert.equal(updated.skills[0].description, 'Changed')
  assert.equal((await f.ctx.skills.get('alpha', { cwd: f.root })).content, 'Changed body.')
  await change(f.ctx, () => put(f.skills, 'beta', 'Beta'))
  assert.deepEqual((await f.ctx.skills.list({ cwd: f.root, scope: {} })).map(s => s.name), ['alpha', 'beta'])
  await change(f.ctx, () => rm(join(f.skills, 'beta'), { recursive: true }))
  assert.deepEqual((await f.ctx.skills.list({ cwd: f.root, scope: {} })).map(s => s.name), ['alpha'])
})

test('watch disabled does not share catalogs across new session scopes', async () => {
  const f = await fixture({ watch: false })
  await f.ctx.skills.snapshot({ cwd: f.root, scope: {} })
  const calls = f.calls()
  await f.ctx.skills.snapshot({ cwd: f.root, scope: {} })
  assert.ok(f.calls() > calls)
})

for (const watch of [false, true]) for (const operation of ['listDir', 'readText']) {
  test(`a root ${operation} failure preserves other roots and retries with watch=${watch}`, async () => {
    const f = await fixture({ watch })
    await f.fiber.dispose()
    const preferred = join(f.root, 'preferred')
    await put(preferred, 'alpha', 'Preferred')
    await f.ctx.plugin(Plugin, {
      includeDefaultRoots: false, customSkillDirs: [preferred, f.skills], watch,
      watchStabilityThresholdMs: 20, watchPollIntervalMs: 10,
    })
    const original = f.ctx.fs[operation].bind(f.ctx.fs)
    let failing = true, attempts = 0
    f.ctx.fs[operation] = async (...args) => {
      if (args[0].displayPath.startsWith(preferred)) {
        attempts += 1
        if (failing) throw Object.assign(new Error('fixture root denied'), { code: 'EACCES' })
      }
      return await original(...args)
    }
    for (let i = 0; i < 2; i++) {
      const snapshot = await f.ctx.skills.snapshot({ cwd: f.root, scope: {} })
      assert.equal(snapshot.complete, false)
      assert.deepEqual(snapshot.skills.map(s => [s.name, s.description]), [['alpha', 'Alpha']])
    }
    assert.equal(attempts, 2, 'failed roots must not enter the shared cache')
    failing = false
    const restored = await f.ctx.skills.snapshot({ cwd: f.root, scope: {} })
    assert.equal(restored.complete, true)
    assert.deepEqual(restored.skills.map(s => [s.name, s.description]), [['alpha', 'Preferred']])
  })
}

test('different working directories sharing roots reuse their catalogs', async () => {
  const f = await fixture({ catalogCacheMaxEntries: 1 })
  await f.ctx.skills.snapshot({ cwd: join(f.root, 'one'), scope: {} })
  await f.ctx.skills.snapshot({ cwd: join(f.root, 'two'), scope: {} })
  const calls = f.calls()
  await f.ctx.skills.snapshot({ cwd: join(f.root, 'one'), scope: {} })
  assert.equal(f.calls(), calls)
})

test('root catalog eviction respects the configured bound', async () => {
  const f = await fixture({ catalogCacheMaxEntries: 1 })
  await f.fiber.dispose()
  const other = join(f.root, 'other')
  await put(other, 'beta', 'Beta')
  await f.ctx.plugin(Plugin, { includeDefaultRoots: false, customSkillDirs: [f.skills, other], catalogCacheMaxEntries: 1 })
  await f.ctx.skills.snapshot({ cwd: f.root, scope: {} })
  const calls = f.calls()
  await f.ctx.skills.snapshot({ cwd: f.root, scope: {} })
  assert.ok(f.calls() > calls)
})

test('unloading removes the provider and closes its watchers', async () => {
  const f = await fixture()
  await f.ctx.skills.snapshot({ cwd: f.root })
  await f.fiber.dispose()
  assert.deepEqual(await f.ctx.skills.list(), [])
  await put(f.skills, 'beta', 'Beta')
  assert.deepEqual(await f.ctx.skills.list(), [])
})

test('directory junctions preserve current bodies and discovered resource paths', async () => {
  const f = await fixture()
  const external = join(f.root, 'external')
  await put(external, 'linked', 'Linked')
  const alias = join(f.skills, 'linked')
  await symlink(join(external, 'linked'), alias, process.platform === 'win32' ? 'junction' : 'dir')
  const catalog = await f.ctx.skills.snapshot({ cwd: f.root })
  assert.equal(catalog.skills.length, 2)
  const body = await f.ctx.skills.get('linked', { cwd: f.root })
  assert.equal(body.resourceBase.path, alias)
  assert.equal(await readFile(body.path, 'utf8'), await readFile(join(alias, 'SKILL.md'), 'utf8'))
})

test('an unmapped execution filesystem does not retain a shared host catalog', async () => {
  const f = await fixture()
  f.ctx.fs.processPathFromHostPath = () => undefined
  await f.ctx.skills.snapshot({ cwd: f.root, scope: {} })
  const calls = f.calls()
  await f.ctx.skills.snapshot({ cwd: f.root, scope: {} })
  assert.ok(f.calls() > calls)
})

test('retargeting a watched root junction refreshes the shared catalog', async () => {
  const f = await fixture()
  await f.fiber.dispose()
  const first = join(f.root, 'first')
  const second = join(f.root, 'second')
  await put(first, 'linked', 'First target')
  await put(second, 'linked', 'Second target')
  const alias = join(f.root, 'alias')
  await symlink(first, alias, process.platform === 'win32' ? 'junction' : 'dir')
  await f.ctx.plugin(Plugin, { includeDefaultRoots: false, customSkillDirs: [alias] })
  assert.equal((await f.ctx.skills.list({ cwd: f.root, scope: {} }))[0].description, 'First target')
  await rmdir(alias)
  await symlink(second, alias, process.platform === 'win32' ? 'junction' : 'dir')
  assert.equal((await f.ctx.skills.list({ cwd: f.root, scope: {} }))[0].description, 'Second target')
})

test('changing the nearest git root changes the shared catalog identity', async () => {
  const f = await fixture()
  await f.fiber.dispose()
  const nested = join(f.root, 'nested')
  await mkdir(join(f.root, '.git'))
  await mkdir(nested)
  await put(join(f.root, '.dsh/skills'), 'outer', 'Outer')
  await put(join(nested, '.dsh/skills'), 'inner', 'Inner')
  await f.ctx.plugin(Plugin, { dshHome: join(f.root, 'empty-home'), agentsHome: join(f.root, 'empty-agents') })
  assert.deepEqual((await f.ctx.skills.list({ cwd: nested, scope: {} })).map(s => s.name), ['outer'])
  await mkdir(join(nested, '.git'))
  assert.deepEqual((await f.ctx.skills.list({ cwd: nested, scope: {} })).map(s => s.name), ['inner'])
})

test('replacing the filesystem dependency rebuilds the plugin catalog', async () => {
  const f = await fixture()
  await f.ctx.skills.snapshot({ cwd: f.root, scope: {} })
  await f.fsFiber.dispose()
  await change(f.ctx, () => f.ctx.plugin(LocalFileSystem))
  let reads = 0
  const read = f.ctx.fs.listDir.bind(f.ctx.fs)
  f.ctx.fs.listDir = async (...args) => { reads += 1; return await read(...args) }
  assert.equal((await f.ctx.skills.list({ cwd: f.root, scope: {} }))[0].name, 'alpha')
  assert.ok(reads > 0)
})

test('activates before the optional filesystem service is available', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-catalog-startup-'))
  const ctx = new Context()
  owned.push({ctx,root})
  await put(join(root,'skills'),'early','Early')
  await ctx.plugin(Skills)
  await ctx.plugin(Plugin,{includeDefaultRoots:false,customSkillDirs:[join(root,'skills')]})
  assert.equal((await ctx.skills.list())[0].name,'early')
  await change(ctx,()=>ctx.plugin(LocalFileSystem))
  assert.equal((await ctx.skills.list({scope:{}}))[0].name,'early')
})
