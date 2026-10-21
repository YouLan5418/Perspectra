import { build } from 'esbuild'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'

it('boots the built backend from a source checkout and an isolated installed layout', async () => {
  await mkdir('.tmp', { recursive: true })
  const directory = await mkdtemp(resolve('.tmp/host-entry-'))
  const entry = join(directory, 'backend.mjs'),
    runtime = join(directory, 'runtime')
  try {
    await build({
      entryPoints: ['desktop/host/web-entry.ts'],
      outfile: entry,
      bundle: true,
      platform: 'node',
      target: 'node24',
      format: 'esm',
      external: ['jieba-wasm'],
      logLevel: 'silent',
    })
    await cp('packages/frontend/assets', join(directory, 'frontend-assets'), { recursive: true })
    // Exercise the same payload copier used by the bundled backend and portable release builds.
    execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `const {copyMemoryRuntime}=await import(${JSON.stringify(pathToFileURL(resolve('scripts/build/copy-memory-runtime.mjs')).href)});await copyMemoryRuntime(${JSON.stringify(runtime)})`,
      ],
      { windowsHide: true },
    )
    await cp(entry, join(runtime, 'backend.mjs'))
    await cp('packages/frontend/assets', join(runtime, 'frontend-assets'), { recursive: true })
    for (const layout of ['typescript', 'built-source', 'installed']) {
      const installed = layout === 'installed'
      const command =
        layout === 'typescript'
          ? ['--import', 'tsx', resolve('desktop/host/web-entry.ts')]
          : [installed ? join(runtime, 'backend.mjs') : entry]
      const child = spawn(
        process.execPath,
        [
          ...command,
          '--memory-native',
          '--pack',
          resolve('examples/world-packs/prototype-g1'),
          '--data-dir',
          join(directory, layout + '-world'),
        ],
        {
          cwd: installed ? runtime : resolve('.'),
          windowsHide: true,
          stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
          env: { ...process.env, PERSPECTRA_RUNTIME_ROOT: installed ? runtime : undefined },
        },
      )
      let errors = ''
      child.stderr!.on('data', chunk => {
        errors += String(chunk)
      })
      try {
        const ready = await new Promise<{ port: number; token: string }>((done, reject) => {
          const timer = setTimeout(() => reject(new Error('Backend startup timed out: ' + errors.slice(-1000))), 30_000)
          child.once('error', error => {
            clearTimeout(timer)
            reject(error)
          })
          child.once('exit', () => {
            clearTimeout(timer)
            reject(new Error('Backend exited before ready: ' + errors.slice(-1000)))
          })
          child.on('message', value => {
            const message = value as { type: string; port: number; token: string; message?: string }
            if (message.type === 'ready') {
              clearTimeout(timer)
              done(message)
            } else if (message.type === 'startup-error') {
              clearTimeout(timer)
              reject(new Error(message.message))
            }
          })
        })
        const response = await fetch(`http://127.0.0.1:${ready.port}/api/state`, {
          headers: { 'x-playtest-token': ready.token },
          signal: AbortSignal.timeout(10_000),
        })
        expect(response.status).toBe(200)
        expect(((await response.json()) as { debug: { memoryMode: string } }).debug.memoryMode).toBe('native')
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          const exited = once(child, 'exit')
          child.kill()
          await exited
        }
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 60_000)
