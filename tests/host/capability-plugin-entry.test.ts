import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createChatServer } from '../support/fake-provider.ts'
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { AddressInfo } from 'node:net'
import type { PlayerView } from '@harness-world/frontend'
import { expect, it } from 'vitest'

it('loads capability plugins through both source and bundled host entries and exposes real player actions', async () => {
  const pack = 'plugin-capabilities-demo',
    plugin = 'demo-device'
  await mkdir('.tmp', { recursive: true })
  const directory = await mkdtemp(resolve('.tmp/capability-plugin-entry-'))
  const model = createChatServer((request, response) => {
    request.resume()
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ message: { content: '{"decision":"abstain"}' } }))
    })
  })
  model.listen(0, '127.0.0.1')
  await once(model, 'listening')
  try {
    const entry = join(directory, 'backend.mjs')
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
    for (const layout of ['source', 'built']) {
      const child = spawn(
        process.execPath,
        [
          ...(layout === 'source' ? ['--import', 'tsx', resolve('desktop/host/web-entry.ts')] : [entry]),
          '--memory-native',
          '--pack',
          resolve('examples/world-packs/' + pack),
          '--data-dir',
          join(directory, layout),
        ],
        {
          cwd: resolve('.'),
          windowsHide: true,
          stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
          env: {
            ...process.env,
            PERSPECTRA_ROLE_MODELS: undefined,
            PERSPECTRA_MODEL_KEYS: undefined,
            PERSPECTRA_PRESET_ROOT: undefined,
            PERSPECTRA_MODEL_ENDPOINT:
              'http://127.0.0.1:' + (model.address() as AddressInfo).port + '/v1/chat/completions',
            PERSPECTRA_MODEL: 'fixture',
            PERSPECTRA_HOST_PLUGINS: JSON.stringify([
              { id: plugin, enabled: true, path: resolve('examples/host-plugins/' + plugin + '.mjs') },
              // A broken, unrelated plugin is skipped; the world still opens because it does not need it.
              { id: 'missing-file', enabled: true, path: join(directory, 'missing.mjs') },
            ]),
          },
        },
      )
      let errors = ''
      child.stderr!.on('data', chunk => {
        errors += String(chunk)
      })
      try {
        const ready = await new Promise<{ port: number; token: string; skippedPlugins: unknown }>((done, reject) => {
          const timer = setTimeout(() => reject(new Error('Host startup timed out: ' + errors.slice(-1000))), 30_000)
          child.once('error', error => {
            clearTimeout(timer)
            reject(error)
          })
          child.once('exit', () => {
            clearTimeout(timer)
            reject(new Error('Host exited before ready: ' + errors.slice(-1000)))
          })
          child.on('message', value => {
            const message = value as {
              type: string
              port: number
              token: string
              message?: string
              skippedPlugins: unknown
            }
            if (message.type === 'ready') {
              clearTimeout(timer)
              done(message)
            }
            if (message.type === 'startup-error') {
              clearTimeout(timer)
              reject(new Error(message.message))
            }
          })
        })
        expect(ready.skippedPlugins).toEqual([{ id: 'missing-file', reason: 'import' }])
        const url = 'http://127.0.0.1:' + ready.port
        const headers = { 'x-playtest-token': ready.token, 'content-type': 'application/json' }
        const view = async () => {
          const response = await fetch(url + '/frontend-api/v1/view', { headers, signal: AbortSignal.timeout(10000) })
          expect(response.status).toBe(200)
          return (await response.json()) as PlayerView
        }
        const initial = await view()
        const init = await fetch(url + '/frontend-api/v1/init', { headers }).then(r => r.json())
        expect(init.canSave).toBe(false)
        expect(init.capabilities).not.toContain('regenerate')
        const option = initial.actions.find(a => a.label === '请求设备确认')!
        expect(option).toBeDefined()
        const performed = await fetch(url + '/api/perform', {
          method: 'POST',
          headers,
          body: JSON.stringify(option.action),
          signal: AbortSignal.timeout(20000),
        })
        expect(performed.status).toBe(200)
        const next = await view()
        expect(JSON.stringify(next)).toContain('设备已确认你的招呼')
        expect(JSON.stringify(next)).not.toContain('character:friend 的确认次数')
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          const exited = once(child, 'exit')
          child.send({ type: 'shutdown' })
          await exited
        }
      }
    }
  } finally {
    model.closeAllConnections()
    await new Promise<void>(done => model.close(() => done()))
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }
}, 90_000)
