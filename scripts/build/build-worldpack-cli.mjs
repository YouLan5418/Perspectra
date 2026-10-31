import { build } from 'esbuild'
import { cp, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Bundle the same creator entry used in source mode, with no repository imports at runtime. */
export async function buildWorldPackCli(output) {
  const runtime = join(output, 'runtime')
  await mkdir(runtime, { recursive: true })
  const options = {
    write: false,
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'esm',
    external: ['jieba-wasm'],
    legalComments: 'eof',
    metafile: true,
    banner: {
      js: "import {createRequire as __createRequire} from 'node:module'; const require=__createRequire(import.meta.url);",
    },
  }
  const result = await build({
    ...options,
    entryPoints: ['packages/world-pack/process/cli-entry.ts'],
    outfile: join(runtime, 'worldpack.mjs'),
  })
  await writeFile(join(runtime, 'worldpack.mjs'), result.outputFiles[0].contents)
  // The read-only pack lens for AI agents (`worldpack lens ...`), bundled beside the creator CLI.
  const lens = await build({
    ...options,
    entryPoints: ['desktop/lens/cli.ts'],
    outfile: join(runtime, 'lens.mjs'),
  })
  await writeFile(join(runtime, 'lens.mjs'), lens.outputFiles[0].contents)
  await cp('node_modules/jieba-wasm', join(runtime, 'node_modules/jieba-wasm'), {
    recursive: true,
    dereference: true,
  })
  await cp('scripts/release/worldpack.cmd', join(output, 'worldpack.cmd'))
  await cp('scripts/release/CREATOR.zh-CN.md', join(output, '创作校验.md'))
  await cp('skills/perspectra-creator', join(output, 'skills/perspectra-creator'), {
    recursive: true,
    filter: path =>
      !path
        .split(/[\\/]/u)
        .some(part => part === '__pycache__' || part.endsWith('.pyc') || part.toLowerCase() === 'nul'),
  })
  return result
}
