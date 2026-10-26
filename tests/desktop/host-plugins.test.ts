import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { once } from 'node:events'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it, vi } from 'vitest'
import { FrontendServices, loadHostPlugins, type HostPlugins } from '../../desktop/host-plugins.ts'
import { hostPluginSettings } from '../../desktop/host-plugin-settings.ts'

const roots: string[] = [],
  sessions: HostPlugins[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  for (const session of sessions.splice(0)) await session.close()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

it('runs the optional HTTP speech plugin against a local service without persisting provider credentials', async () => {
  const received: unknown[] = [],
    authorizations: (string | undefined)[] = []
  const server = createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk
    received.push(JSON.parse(body))
    authorizations.push(request.headers.authorization)
    response.writeHead(200, { 'content-type': 'audio/wav' })
    response.end(audio.bytes)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  vi.stubEnv('PERSPECTRA_TTS_ENDPOINT', `http://127.0.0.1:${(server.address() as AddressInfo).port}/speech`)
  vi.stubEnv('PERSPECTRA_TTS_API_KEY', 'fixture-only-key')
  try {
    const session = await loadHostPlugins([
      {
        id: 'http-tts',
        enabled: true,
        path: fileURLToPath(new URL('../../examples/host-plugins/http-speech.mjs', import.meta.url)),
      },
    ])
    sessions.push(session)
    expect(await session.services.synthesizeSpeech!(paragraph, new AbortController().signal)).toEqual(audio)
    expect(received).toEqual([paragraph])
    expect(authorizations).toEqual(['Bearer fixture-only-key'])
    await session.close()
  } finally {
    server.closeAllConnections()
    await new Promise<void>(done => server.close(() => done()))
  }
})
async function moduleFile(source: string) {
  const root = await mkdtemp(join(tmpdir(), 'perspectra-host-plugin-'))
  roots.push(root)
  const path = join(root, 'plugin.mjs')
  await writeFile(path, source)
  return { root, path }
}
const paragraph = { seq: 7, segmentIndex: 0, text: '你好。', type: 'speech' as const }
const audio = { contentType: 'audio/wav' as const, bytes: new Uint8Array([82, 73, 70, 70]) }

it('does not even import disabled modules and loads an enabled Cordis speech service', async () => {
  const disabled = await moduleFile(`throw new Error('disabled module executed')`)
  const file = await moduleFile(`export default function(ctx) {
    if ('worldRuntimeRegistry' in ctx || 'worldKernel' in ctx) throw new Error('unexpected world services');
    ctx.effect(() => ctx.frontendServices.registerSpeech(async input => ({
      contentType: 'audio/wav', bytes: new TextEncoder().encode(input.text)
    })));
  }`)
  const empty = await loadHostPlugins([{ id: 'disabled', path: disabled.path, enabled: false }])
  sessions.push(empty)
  expect(empty.services.synthesizeSpeech).toBeUndefined()
  const session = await loadHostPlugins([{ id: 'tts', path: file.path, enabled: true }])
  sessions.push(session)
  const result = await session.services.synthesizeSpeech!(paragraph, new AbortController().signal)
  expect(new TextDecoder().decode(result.bytes)).toBe(paragraph.text)
  await session.close()
  expect(session.services.synthesizeSpeech).toBeUndefined()
})

it('skips a failing plugin, unwinds only its own registrations and keeps the rest running', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  const file = await moduleFile(`import { writeFileSync } from 'node:fs';
    export default function(ctx) {
      ctx.effect(() => () => writeFileSync(new URL('./disposed', import.meta.url), 'yes'));
    }`)
  // Registers a capability, then fails: Cordis must take the registration back with the plugin.
  const failed = await moduleFile(`export default function(ctx) {
    ctx.effect(() => ctx.capabilities.register({ id: 'half-done', version: '1', methods: {
      ping: { arguments: { type: 'object' }, result: { type: 'object' }, effect: 'read' } },
      async open() { return { async invoke() { return { completion: 'completed', data: {} } }, async close() {} } } }));
    throw new Error('PRIVATE_PLUGIN_SECRET')
  }`)
  const missing = await moduleFile(`export const notDefault = 1`)
  const session = await loadHostPlugins([
    { id: 'first', path: file.path, enabled: true },
    { id: 'broken', path: failed.path, enabled: true },
    { id: 'no-export', path: missing.path, enabled: true },
    { id: 'absent', path: join(file.root, 'absent.mjs'), enabled: true },
  ])
  sessions.push(session)
  expect(session.skipped).toEqual([
    { id: 'broken', reason: 'apply' },
    { id: 'no-export', reason: 'import' },
    { id: 'absent', reason: 'import' },
  ])
  expect(JSON.stringify(session.skipped)).not.toContain('PRIVATE_PLUGIN_SECRET')
  expect(session.capabilities.list()).toEqual([])
  await expect(readFile(join(file.root, 'disposed'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  // The detailed cause goes to the host log, labelled with the plugin ID.
  expect(error.mock.calls.some(([label]) => String(label).includes('[宿主插件 broken] 初始化失败'))).toBe(true)
  error.mockRestore()
  await session.close()
  sessions.splice(sessions.indexOf(session), 1)
  expect(await readFile(join(file.root, 'disposed'), 'utf8')).toBe('yes')
})

it('keeps the first synthesizer and skips a second plugin that tries to register another', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const source = `export default function(ctx) {
    ctx.effect(() => ctx.frontendServices.registerSpeech(async () => ({contentType:'audio/wav',bytes:new Uint8Array([1])})));
  }`
  const first = await moduleFile(source),
    second = await moduleFile(source)
  const session = await loadHostPlugins([
    { id: 'one', path: first.path, enabled: true },
    { id: 'two', path: second.path, enabled: true },
  ])
  sessions.push(session)
  expect(session.skipped).toEqual([{ id: 'two', reason: 'apply' }])
  expect(session.services.synthesizeSpeech).toBeDefined()
  vi.restoreAllMocks()
})

it('still fails the whole launch for invalid plugin settings', async () => {
  await expect(
    loadHostPlugins([{ id: 'bad', path: 'https://example.com/plugin.mjs', enabled: true }]),
  ).rejects.toThrow()
})

it('aborts outstanding synthesis and rejects late audio when its owner is disposed', async () => {
  const root = new Context(),
    services = new FrontendServices(root)
  let release!: () => void, requestSignal: AbortSignal | undefined
  const provider = vi.fn(async (_input, signal: AbortSignal) => {
    requestSignal = signal
    await new Promise<void>(done => {
      release = done
    })
    return audio
  })
  const fiber = root.plugin(ctx => {
    ctx.effect(() => services.registerSpeech(provider))
  })
  await fiber
  const pending = services.synthesizeSpeech!(paragraph, new AbortController().signal)
  const rejected = expect(pending).rejects.toThrow()
  await fiber.dispose()
  expect(requestSignal?.aborted).toBe(true)
  expect(services.synthesizeSpeech).toBeUndefined()
  release()
  await rejected
  await root.fiber.dispose()
})

it('validates local module settings without allowing extra credential fields', () => {
  expect(hostPluginSettings([])).toEqual([])
  expect(hostPluginSettings([{ id: 'tts', path: '', enabled: false }])).toEqual([
    { id: 'tts', path: '', enabled: false },
  ])
  for (const item of [
    { id: 'tts', path: '', enabled: true },
    { id: 'tts', path: 'https://example.com/tts.mjs', enabled: true },
    { id: 'tts', path: 'relative.mjs', enabled: true },
    { id: 'tts', path: 'C:/tts.ts', enabled: true },
    { id: 'tts', path: 'C:/tts.mjs', enabled: true, apiKey: 'secret' },
  ])
    expect(() => hostPluginSettings([item])).toThrow()
  expect(() =>
    hostPluginSettings([
      { id: 'tts', path: '', enabled: false },
      { id: 'tts', path: '', enabled: false },
    ]),
  ).toThrow()
})
