import { build } from 'esbuild'

await build({
  entryPoints: ['desktop/host/web-entry.ts'],
  outfile: 'dist/backend/playtest.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
})
