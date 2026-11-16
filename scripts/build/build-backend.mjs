import { build } from 'esbuild'

await build({
  entryPoints: ['apps/host/src/runtime/web-entry.ts'],
  outfile: 'dist/backend/playtest.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
})
