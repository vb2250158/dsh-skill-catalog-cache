import assert from 'node:assert/strict'
import test from 'node:test'
import { CatalogCache } from '../src/catalog-cache.mjs'

test('shares concurrent producer work and retains the same complete array', async () => {
  const cache = new CatalogCache(2)
  const gate = Promise.withResolvers()
  const catalog = [{ name: 'same-skill' }]
  let calls = 0
  const first = cache.read('same', () => { calls += 1; return gate.promise })
  const second = cache.read('same', () => { throw new Error('Duplicate producer') })
  assert.equal(first, second)
  gate.resolve(catalog)
  assert.equal(await first, catalog)
  assert.equal(await second, catalog)
  assert.equal(await cache.read('same', () => { throw new Error('Cached producer') }), catalog)
  assert.equal(calls, 1)
})

test('evicts the least recently read completed catalog', async () => {
  const cache = new CatalogCache(2)
  const a = [{ name: 'a' }], b = [{ name: 'b' }], c = [{ name: 'c' }]
  await cache.read('a', () => a)
  await cache.read('b', () => b)
  assert.equal(await cache.read('a', () => { throw new Error('Expected cached A') }), a)
  await cache.read('c', () => c)
  assert.equal(await cache.read('a', () => { throw new Error('Expected retained A') }), a)
  assert.equal(await cache.read('c', () => { throw new Error('Expected retained C') }), c)
  const nextB = [{ name: 'replacement-b' }]
  assert.equal(await cache.read('b', () => nextB), nextB)
})

test('clear removes completed values and prevents older work from replacing a fresh catalog', async () => {
  const cache = new CatalogCache(2)
  const stale = [{ name: 'stale' }], fresh = [{ name: 'fresh' }]
  await cache.read('cached', () => stale)
  const gate = Promise.withResolvers()
  const old = cache.read('pending', () => gate.promise)
  cache.clear()
  assert.equal(await cache.read('cached', () => fresh), fresh)
  assert.equal(await cache.read('pending', () => fresh), fresh)
  gate.resolve(stale)
  assert.equal(await old, stale)
  assert.equal(await cache.read('pending', () => { throw new Error('Expected fresh catalog') }), fresh)
})

test('an older completion does not remove a newer in-flight producer', async () => {
  const cache = new CatalogCache(1)
  const older = Promise.withResolvers(), newer = Promise.withResolvers()
  const old = cache.read('same', () => older.promise)
  cache.clear()
  const next = cache.read('same', () => newer.promise)
  older.resolve([])
  await old
  const joined = cache.read('same', () => { throw new Error('New producer was removed') })
  assert.equal(joined, next)
  const fresh = [{ name: 'fresh' }]
  newer.resolve(fresh)
  assert.equal(await joined, fresh)
})

test('an asynchronous failure allows the next read to retry', async () => {
  const cache = new CatalogCache(1)
  const failure = new Error('Read failed')
  await assert.rejects(cache.read('same', () => Promise.reject(failure)), error => error === failure)
  const fresh = []
  assert.equal(await cache.read('same', () => fresh), fresh)
})

test('a synchronous producer throw becomes a rejected promise and allows retry', async () => {
  const cache = new CatalogCache(1)
  const failure = new Error('Producer failed synchronously')
  let pending
  assert.doesNotThrow(() => { pending = cache.read('same', () => { throw failure }) })
  await assert.rejects(pending, error => error === failure)
  const fresh = []
  assert.equal(await cache.read('same', () => fresh), fresh)
})

test('incomplete observations are returned but retried on the next read', async () => {
  const cache = new CatalogCache(1)
  const partial = { candidates: [{ name: 'partial' }], complete: false }
  const complete = { candidates: [{ name: 'complete' }], complete: true }
  assert.equal(await cache.read('same', () => partial), partial)
  assert.equal(await cache.read('same', () => complete), complete)
  assert.equal(await cache.read('same', () => { throw new Error('Expected complete cache') }), complete)
})

test('values outside the provider catalog forms do not enter the cache', async () => {
  const cache = new CatalogCache(1)
  for (const value of [undefined, null, {}, { candidates: 'invalid' }]) {
    assert.equal(await cache.read('same', () => value), value)
    const fresh = []
    assert.equal(await cache.read('same', () => fresh), fresh)
    cache.clear()
  }
})

test('rejects invalid completed-catalog bounds', () => {
  for (const maxEntries of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => new CatalogCache(maxEntries), RangeError)
  }
})
