import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'

it('imports SDK and RPG through their declared exports without core, model or Python implementations', async () => {
  for (const entry of ['@perspectra/sdk', '@perspectra/plugins/rpg']) {
    const result = await build({
      stdin: { contents: `export * from '${entry}'`, resolveDir: resolve('apps/host') },
      bundle: true,
      write: false,
      metafile: true,
      platform: 'node',
      format: 'esm',
    })
    const inputs = Object.keys(result.metafile!.inputs)
    expect(inputs.some(path => path.includes('packages/sdk/src/'))).toBe(true)
    expect(
      inputs.filter(path => /packages\/(?:core|providers|memory-core|jev-audit)\/|apps\/|node_modules/.test(path)),
    ).toEqual([])
    const exports = await import(
      'data:text/javascript;base64,' + Buffer.from(result.outputFiles[0]!.contents).toString('base64')
    )
    expect(Object.keys(exports).length).toBeGreaterThan(0)
  }
})

it('validates the search pack with model and Python modules unavailable', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'perspectra-static-'))
  try {
    const guard = join(directory, 'guard.mjs')
    await writeFile(
      guard,
      `import {registerHooks} from 'node:module';
      registerHooks({resolve(specifier, context, next) {
        const resolved = next(specifier, context);
        if (/packages\\/(?:memory-core|jev-audit)\\/|packages\\/providers\\/src\\/(?:llm|chat\\/(?:provider|pi-model))|node_modules\\/(?:@earendil-works|@anthropic-ai|openai|@google)/.test(resolved.url)) throw Error('optional runtime loaded: ' + resolved.url);
        return resolved;
      }});`,
    )
    const output = execFileSync(
      process.execPath,
      [
        '--import',
        pathToFileURL(guard).href,
        '--import',
        'tsx',
        resolve('apps/host/src/cli/worldpack.ts'),
        'validate',
        resolve('examples/world-packs/investigation'),
      ],
      {
        encoding: 'utf8',
        timeout: 30_000,
        env: {
          ...process.env,
          HCW_HINDSIGHT_PYTHON: '/unavailable/python',
          PERSPECTRA_MODEL_API_KEY: '',
          PERSPECTRA_MODEL_KEYS: '',
          PERSPECTRA_ROLE_MODELS: '',
          OPENROUTER_JEV_KEY: '',
        },
      },
    )
    expect(JSON.parse(output)).toMatchObject({ command: 'validate', status: 'valid' })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it('runs the bundled CLI and search assertions outside the checkout', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'perspectra-cli-layout-'))
  try {
    const entry = join(directory, 'worldpack.mjs')
    const bundled = await build({
      write: false,
      entryPoints: ['apps/host/src/cli/worldpack.ts'],
      outfile: entry,
      bundle: true,
      platform: 'node',
      target: 'node24',
      format: 'esm',
      banner: {
        js: "import {createRequire as __createRequire} from 'node:module'; const require=__createRequire(import.meta.url);",
      },
    })
    await writeFile(entry, bundled.outputFiles[0]!.contents)
    const pack = resolve('examples/world-packs/investigation')
    const options = {
      cwd: directory,
      encoding: 'utf8' as const,
      timeout: 30_000,
      env: {
        ...process.env,
        PERSPECTRA_RUNTIME_ROOT: directory,
        HCW_HINDSIGHT_PYTHON: '/unavailable/python',
        PERSPECTRA_MODEL_API_KEY: '',
        PERSPECTRA_MODEL_KEYS: '',
        PERSPECTRA_ROLE_MODELS: '',
        OPENROUTER_JEV_KEY: '',
      },
    }
    // Static validation works before any Python resource payload has been copied.
    expect(JSON.parse(execFileSync(process.execPath, [entry, 'validate', pack], options))).toMatchObject({
      status: 'valid',
    })
    // Dynamic Host identity includes the distributed source resources; no Python process is started.
    execFileSync(process.execPath, [
      '--input-type=module',
      '-e',
      `const {copyMemoryRuntime}=await import(${JSON.stringify(new URL('../../scripts/build/copy-memory-runtime.mjs', import.meta.url).href)}); await copyMemoryRuntime(${JSON.stringify(directory)})`,
    ])
    await cp('packages/frontend/assets', join(directory, 'frontend-assets'), { recursive: true })
    const result = JSON.parse(
      execFileSync(process.execPath, [entry, 'simulate', pack, join(pack, 'scenario.json')], options),
    )
    expect(result.passed).toBe(true)
    expect(result.steps.map((step: { resolutions: { accepted: boolean }[] }) => step.resolutions[0]?.accepted)).toEqual(
      [true, true, false],
    )
    expect(result.steps[2].resolutions[0].rejection.code).toBe('INSUFFICIENT_ENERGY')
    console.info('isolated CLI timing (ms)', result.timings)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 60_000)

it('loads the shared Launcher settings as browser-only public exports', async () => {
  for (const name of ['play-settings', 'plugin-settings']) {
    const result = await build({
      stdin: { contents: `export * from '@perspectra/host/${name}'`, resolveDir: resolve('apps/launcher') },
      bundle: true,
      write: false,
      metafile: true,
      platform: 'browser',
      format: 'esm',
    })
    expect(Object.keys(result.metafile!.inputs).filter(path => path !== '<stdin>')).toEqual([
      name === 'play-settings' ? 'apps/host/src/play-settings.ts' : 'apps/host/src/host-plugin-settings.ts',
    ])
  }
})
