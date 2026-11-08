import { build } from 'esbuild'
import { inlineAdjacentScripts } from './inline-adjacent-scripts.mjs'

await build({
  entryPoints: ['desktop/host/web-entry.ts'],
  outfile: 'dist/backend/playtest.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  plugins: [inlineAdjacentScripts],
})
