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
    legalComments: 'eof',
    metafile: true,
    banner: {
      js: "import {createRequire as __createRequire} from 'node:module'; const require=__createRequire(import.meta.url);",
    },
  }
  const result = await build({
    ...options,
    entryPoints: ['apps/host/src/cli/worldpack.ts'],
    outfile: join(runtime, 'worldpack.mjs'),
  })
  await writeFile(join(runtime, 'worldpack.mjs'), result.outputFiles[0].contents)
  // The read-only pack lens for AI agents (`worldpack lens ...`), bundled beside the creator CLI.
  const lens = await build({
    ...options,
    entryPoints: ['apps/host/src/lens/cli.ts'],
    outfile: join(runtime, 'lens.mjs'),
  })
  await writeFile(join(runtime, 'lens.mjs'), lens.outputFiles[0].contents)
  await cp('scripts/release/worldpack.cmd', join(output, 'worldpack.cmd'))
  await cp('scripts/release/CREATOR.zh-CN.md', join(output, '创作校验.md'))
  await cp('skills/perspectra-creator', join(output, 'skills/perspectra-creator'), {
    recursive: true,
    filter: path => {
      const parts = path.split(/[\\/]/u),
        name = parts.at(-1)?.toLowerCase() ?? ''
      return (
        !parts.some(
          part =>
            ['__pycache__', '__tests__', 'test', 'tests'].includes(part.toLowerCase()) || part.toLowerCase() === 'nul',
        ) &&
        !name.endsWith('.py') &&
        !name.endsWith('.pyc') &&
        !/\.(?:test|spec)\.(?:[cm]?[jt]s|tsx?)$/u.test(name)
      )
    },
  })
  return result
}
