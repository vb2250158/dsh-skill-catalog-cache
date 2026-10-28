import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('../', import.meta.url))
const harness = process.env.DSH_SOURCE_ROOT
if (!harness) throw new Error('Set DSH_SOURCE_ROOT to the development Harness checkout for esbuild')
const require = createRequire(resolve(harness, 'package.json'))
const { build } = createRequire(require.resolve('tsx/package.json'))('esbuild')
await build({
  entryPoints: [resolve(root, 'src/index.ts')], outfile: resolve(root, 'lib/index.js'),
  bundle: true, packages: 'external', format: 'esm', platform: 'node', target: 'node24',
  legalComments: 'inline', sourcemap: false,
})
console.log('Built dsh-skill-catalog-cache')
