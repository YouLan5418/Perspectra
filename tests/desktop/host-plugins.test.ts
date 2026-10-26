import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { once } from 'node:events'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it, vi } from 'vitest'
import {
  FrontendServices,
  PlayerFeed,
  loadHostPlugins,
  type HostPlugins,
  type PlayerFeedEvent,
} from '../../desktop/host-plugins.ts'
import { hostPluginSettings } from '../../desktop/host-plugin-settings.ts'
import { HOST_API_VERSION, hostApiCompatible } from '@harness-world/plugin-sdk'

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
  try {
    // The endpoint is a saved setting; the key arrives as a secret, as the launcher hands it over at launch.
    const session = await loadHostPlugins(
      [
        {
          id: 'http-tts',
          enabled: true,
          path: fileURLToPath(new URL('../../examples/host-plugins/http-speech.mjs', import.meta.url)),
          config: { endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}/speech` },
        },
      ],
      { 'http-tts': { apiKey: 'fixture-only-key' } },
    )
    sessions.push(session)
    expect(session.skipped).toEqual([])
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
  // Plugins under test declare the current host API unless the test is about that declaration.
  await writeFile(path, source.includes('hostApi') ? source : `export const hostApi = '1.0';\n${source}`)
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

it('feeds only changes to the player transcript, isolates listeners and stops after unsubscribe', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  const root = new Context(),
    feed = new PlayerFeed(root),
    received: PlayerFeedEvent[] = []
  const delivered = () => new Promise<void>(done => setImmediate(done))
  const line = (seq: number, text: string) => ({ seq, speaker: '澄', text, player: false })
  feed.subscribe(() => {
    throw new Error('broken listener')
  })
  feed.subscribe(async () => {
    throw new Error('broken async listener')
  })
  const unsubscribe = feed.subscribe(event => {
    received.push(event)
    // A listener mutating its copy must not change what the feed compares against next.
    ;(event.lines as unknown as { text: string }[]).forEach(entry => (entry.text = 'changed'))
  })
  const transcript = [line(1, '你好。')]
  feed.publish(transcript)
  feed.publish(transcript)
  feed.publish([...transcript, line(2, '要出发了吗？')])
  feed.publish([line(1, '你好。'), line(3, '另一条候选。')])
  await delivered()
  expect(received.map(event => event.kind)).toEqual(['reset', 'append', 'reset'])
  expect(received[1]!.lines).toHaveLength(1)
  expect(error).toHaveBeenCalledTimes(6)
  unsubscribe()
  feed.publish([line(1, '你好。'), line(3, '另一条候选。'), line(4, '退订后。')])
  await delivered()
  expect(received).toHaveLength(3)
  await root.fiber.dispose()
  expect(() => feed.subscribe(() => {})).toThrow('关闭')
  error.mockRestore()
})

it('mirrors appends and resets into a file through the example transcript plugin', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perspectra-transcript-'))
  roots.push(root)
  const file = join(root, 'transcript.txt')
  const session = await loadHostPlugins([
    {
      id: 'transcript',
      path: fileURLToPath(new URL('../../examples/host-plugins/transcript-file.mjs', import.meta.url)),
      enabled: true,
      config: { file },
    },
  ])
  sessions.push(session)
  expect(session.skipped).toEqual([])
  const line = (seq: number, speaker: string, text: string) => ({ seq, speaker, text, player: false })
  const settled = async (expected: string) => {
    for (let i = 0; i < 50; i++) {
      if ((await readFile(file, 'utf8').catch(() => '')) === expected) return
      await new Promise(done => setTimeout(done, 10))
    }
    expect(await readFile(file, 'utf8')).toBe(expected)
  }
  session.playerFeed.publish([line(1, '玩家', '你好。')])
  session.playerFeed.publish([line(1, '玩家', '你好。'), line(2, '澄', '早。')])
  await settled('玩家：你好。\n澄：早。\n')
  session.playerFeed.publish([line(1, '玩家', '你好。'), line(3, '澄', '另一种回答。')])
  await settled('玩家：你好。\n澄：另一种回答。\n')
})

it('accepts a plugin only for the same host API major and a minor this host already has', () => {
  expect(hostApiCompatible('1.0', '1.0')).toBe(true)
  expect(hostApiCompatible('1.2', '1.3')).toBe(true)
  expect(hostApiCompatible('1.4', '1.3')).toBe(false)
  expect(hostApiCompatible('2.0', '1.3')).toBe(false)
  expect(hostApiCompatible('0.9', '1.3')).toBe(false)
  for (const malformed of [undefined, 1, '1', '1.0.0', 'v1.0', '01.0', ''])
    expect(hostApiCompatible(malformed, '1.0')).toBe(false)
})

it('skips plugins that need a newer host API or do not declare one, before their apply runs', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  const root = await mkdtemp(join(tmpdir(), 'perspectra-host-api-'))
  roots.push(root)
  const body = (marker: string) => `import { writeFileSync } from 'node:fs';
    export default function(ctx) { writeFileSync(new URL('./${marker}', import.meta.url), 'ran') }`
  const write = async (name: string, source: string) => {
    const path = join(root, name)
    await writeFile(path, source)
    return path
  }
  const session = await loadHostPlugins([
    {
      id: 'newer',
      path: await write(
        'newer.mjs',
        `export const hostApi = '${HOST_API_VERSION.split('.')[0]}.99';\n${body('newer-ran')}`,
      ),
      enabled: true,
    },
    { id: 'undeclared', path: await write('undeclared.mjs', body('undeclared-ran')), enabled: true },
    {
      id: 'current',
      path: await write('current.mjs', `export const hostApi = '${HOST_API_VERSION}';\n${body('current-ran')}`),
      enabled: true,
    },
  ])
  sessions.push(session)
  expect(session.skipped).toEqual([
    { id: 'newer', reason: 'version' },
    { id: 'undeclared', reason: 'version' },
  ])
  await expect(readFile(join(root, 'newer-ran'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(readFile(join(root, 'undeclared-ran'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readFile(join(root, 'current-ran'), 'utf8')).toBe('ran')
  expect(error.mock.calls.some(([label]) => String(label).includes('（未声明 hostApi）'))).toBe(true)
  error.mockRestore()
})

it('checks the manifest and config before importing, and hands the merged config to the plugin', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  const root = await mkdtemp(join(tmpdir(), 'perspectra-plugin-config-'))
  roots.push(root)
  const plugin = async (name: string, manifest?: unknown) => {
    const path = join(root, name + '.mjs')
    await writeFile(
      path,
      `import { writeFileSync } from 'node:fs';
      writeFileSync(new URL('./${name}-imported', import.meta.url), 'yes');
      export const hostApi = '1.0';
      export default function(ctx, config) { writeFileSync(new URL('./${name}-config', import.meta.url), JSON.stringify(config)) }`,
    )
    if (manifest !== undefined)
      await writeFile(
        join(root, name + '.plugin.json'),
        typeof manifest === 'string' ? manifest : JSON.stringify(manifest),
      )
    return path
  }
  const manifest = {
    name: '配置示例',
    version: '1.0.0',
    services: [],
    config: {
      endpoint: { type: 'string', title: '服务地址', required: true },
      voice: { type: 'string', title: '音色', default: '温柔' },
      apiKey: { type: 'string', title: 'API Key', secret: true },
    },
  }
  const session = await loadHostPlugins(
    [
      { id: 'configured', path: await plugin('configured', manifest), enabled: true, config: { endpoint: 'http://x' } },
      { id: 'unfilled', path: await plugin('unfilled', manifest), enabled: true },
      { id: 'broken-manifest', path: await plugin('broken-manifest', '{ not json'), enabled: true },
      { id: 'no-manifest', path: await plugin('no-manifest'), enabled: true },
    ],
    { configured: { apiKey: 'fixture-secret' } },
  )
  sessions.push(session)
  expect(session.skipped).toEqual([
    { id: 'unfilled', reason: 'config', detail: '请先填写：服务地址。' },
    { id: 'broken-manifest', reason: 'manifest', detail: '插件清单不是有效的 JSON。' },
  ])
  expect(JSON.parse(await readFile(join(root, 'configured-config'), 'utf8'))).toEqual({
    endpoint: 'http://x',
    voice: '温柔',
    apiKey: 'fixture-secret',
  })
  expect(JSON.parse(await readFile(join(root, 'no-manifest-config'), 'utf8'))).toEqual({})
  // Skipped before import: neither module's top-level code ran.
  for (const name of ['unfilled', 'broken-manifest'])
    await expect(readFile(join(root, name + '-imported'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  expect(JSON.stringify(error.mock.calls)).not.toContain('fixture-secret')
  error.mockRestore()
})
