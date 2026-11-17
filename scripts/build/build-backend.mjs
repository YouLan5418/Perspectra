import { build } from 'esbuild'
import { copyMemoryAssets, copyMemoryRuntime } from './copy-memory-runtime.mjs'

await build({
  entryPoints: ['apps/host/src/runtime/web-entry.ts'],
  outfile: 'dist/backend/playtest.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
})
await copyMemoryRuntime('dist/backend')
await copyMemoryAssets('dist/backend')
