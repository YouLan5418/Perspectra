import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { once } from 'node:events'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it, vi } from 'vitest'
import {
  FrontendServices,
  HostPluginLoadError,
  PlayerFeed,
  loadHostPlugins,
  type HostPlugins,
  type PlayerFeedEvent,
} from '../../apps/host/src/host-plugins.ts'
import {
  hostPluginNativeAllowed,
  hostPluginSettings,
  shouldLoadHostPlugin,
} from '../../apps/host/src/host-plugin-settings.ts'
import { HOST_API_VERSION, hostApiCompatible } from '@perspectra/sdk'
import { moduleRows } from '../../apps/launcher/src/stores/modules.ts'

const roots: string[] = [],
  sessions: HostPlugins[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  for (const session of sessions.splice(0)) await session.close()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
  vi.restoreAllMocks()
})
function captureConsole(): unknown[][] {
  const calls: unknown[][] = []
  for (const method of ['debug', 'info', 'log', 'warn', 'error'] as const)
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      calls.push([method, ...args])
    })
  return calls
}

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
          nativeAllowed: true,
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
  await writeFile(path, source.includes('hostApi') ? source : `export const hostApi = '2.0';\n${source}`)
  return { root, path }
}
async function moduleManifest(
  file: { root: string; path: string },
  services: ('frontendServices' | 'playerFeed' | 'capabilities')[],
) {
  await writeFile(
    file.path.replace(/\.mjs$/u, '.plugin.json'),
    JSON.stringify({ name: '测试外围插件', version: '1.0.0', services }),
  )
}
const paragraph = { seq: 7, segmentIndex: 0, text: '你好。', type: 'speech' as const }
const audio = { contentType: 'audio/wav' as const, bytes: new Uint8Array([82, 73, 70, 70]) }

it('does not import disabled modules and loads an allowed, enabled Cordis speech service', async () => {
  const disabled = await moduleFile(`throw new Error('disabled module executed')`)
  const file = await moduleFile(`export default function(ctx) {
    if ('worldRuntimeRegistry' in ctx || 'worldKernel' in ctx) throw new Error('unexpected world services');
    ctx.effect(() => ctx.frontendServices.registerSpeech(async input => ({
      contentType: 'audio/wav', bytes: new TextEncoder().encode(input.text)
    })));
  }`)
  const empty = await loadHostPlugins([{ id: 'disabled', path: disabled.path, nativeAllowed: true, enabled: false }])
  sessions.push(empty)
  expect(empty.services.synthesizeSpeech).toBeUndefined()
  const session = await loadHostPlugins([{ id: 'tts', path: file.path, nativeAllowed: true, enabled: true }])
  sessions.push(session)
  const result = await session.services.synthesizeSpeech!(paragraph, new AbortController().signal)
  expect(new TextDecoder().decode(result.bytes)).toBe(paragraph.text)
  await session.close()
  expect(session.services.synthesizeSpeech).toBeUndefined()
})

it('fails closed before an unallowed scheduler runs or a default is assembled', async () => {
  const scheduler = await moduleFile(`import { writeFileSync } from 'node:fs'
    writeFileSync(new URL('./unallowed-scheduler-imported', import.meta.url), 'yes')
    export const hostApi = '2.0'
    export default function (ctx) {
      ctx.effect(() => ctx.scheduler.register({ id: 'unallowed', version: '1.0.0', open: async () => ({
        run: async () => ({ calls: 0, wave: 0, terminalReason: 'quiescent', activations: [] }),
      }) }))
    }`)
  await writeFile(
    scheduler.path.replace(/\.mjs$/u, '.plugin.json'),
    JSON.stringify({ name: '未允许的调度器', version: '1.0.0', services: ['scheduler'] }),
  )
  const defaultMemory = vi.fn()
  const request = loadHostPlugins(
    [{ id: 'unallowed-scheduler', path: scheduler.path, enabled: true }],
    {},
    { memory: defaultMemory },
  )
  await expect(request).rejects.toMatchObject({
    name: 'HostPluginLoadError',
    pluginId: 'unallowed-scheduler',
    reason: 'permission',
  })
  await expect(request).rejects.toThrow('插件 unallowed-scheduler 尚未允许在本机执行')
  await expect(readFile(join(scheduler.root, 'unallowed-scheduler-imported'), 'utf8')).rejects.toMatchObject({
    code: 'ENOENT',
  })
  expect(defaultMemory).not.toHaveBeenCalled()
})

it('cleans earlier factories and fails closed when an explicit provider cannot import', async () => {
  const consoleCalls = captureConsole(),
    marker = 'FAKE_SECRET_IMPORT_MARKER'
  const root = await mkdtemp(join(tmpdir(), 'perspectra-explicit-import-'))
  roots.push(root)
  const first = join(root, 'first.mjs')
  const broken = join(root, 'broken.mjs')
  await writeFile(
    first,
    `import { writeFileSync } from 'node:fs';
    export const hostApi = '2.0';
    export default ctx => ctx.effect(() => () => writeFileSync(new URL('./first-disposed', import.meta.url), 'yes'))`,
  )
  await writeFile(
    first.replace(/\.mjs$/u, '.plugin.json'),
    JSON.stringify({ name: '第一个', version: '1.0.0', services: ['scheduler'] }),
  )
  await writeFile(broken, `throw new Error('${marker}')`)
  await writeFile(
    broken.replace(/\.mjs$/u, '.plugin.json'),
    JSON.stringify({ name: '坏的调度器', version: '1.0.0', services: ['scheduler'] }),
  )

  const failure = await loadHostPlugins([
    { id: 'first', path: first, nativeAllowed: true, enabled: true },
    { id: 'broken', path: broken, nativeAllowed: true, enabled: true },
  ]).catch(error => error)
  expect(failure).toBeInstanceOf(HostPluginLoadError)
  expect(failure).toMatchObject({ pluginId: 'broken', reason: 'import' })
  expect(String(failure)).not.toContain(marker)
  expect((failure as Error).stack).not.toContain(marker)
  expect((failure as Error).cause).toBeUndefined()
  await new Promise(done => setImmediate(done))
  expect(JSON.stringify(consoleCalls)).not.toContain(marker)
  expect(await readFile(join(root, 'first-disposed'), 'utf8')).toBe('yes')
})

it('times out a hanging initialization and prevents its late registration from mounting', async () => {
  const file = await moduleFile(`export default async function(ctx) {
    await new Promise(done => setTimeout(done, 80));
    ctx.effect(() => ctx.frontendServices.registerSpeech(async () => ({
      contentType: 'audio/wav', bytes: new Uint8Array([1])
    })));
  }`)
  await moduleManifest(file, ['frontendServices'])
  // Warm the module so the test exercises the apply deadline rather than
  // competing with filesystem/module-loader latency under the 10 ms import deadline.
  await import(pathToFileURL(file.path).href)
  const session = await loadHostPlugins(
    [{ id: 'slow', path: file.path, nativeAllowed: true, enabled: true }],
    {},
    {},
    { initializationTimeoutMs: 10, cleanupTimeoutMs: 20 },
  )
  sessions.push(session)
  expect(session.skipped).toEqual([{ id: 'slow', reason: 'apply' }])
  expect(session.services.synthesizeSpeech).toBeUndefined()
  await new Promise(done => setTimeout(done, 100))
  expect(session.services.synthesizeSpeech).toBeUndefined()
})

it('does not let a hanging cleanup keep a fatal startup waiting forever', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perspectra-cleanup-hang-'))
  roots.push(root)
  const stuck = join(root, 'stuck.mjs')
  const broken = join(root, 'broken.mjs')
  await writeFile(
    stuck,
    `export const hostApi = '2.0';
    export default ctx => ctx.effect(() => () => new Promise(() => {}))`,
  )
  await writeFile(
    stuck.replace(/\.mjs$/u, '.plugin.json'),
    JSON.stringify({ name: '清理挂起', version: '1.0.0', services: ['scheduler'] }),
  )
  await writeFile(broken, `throw new Error('PRIVATE_CLEANUP_SECRET')`)
  await writeFile(
    broken.replace(/\.mjs$/u, '.plugin.json'),
    JSON.stringify({ name: '明确失败', version: '1.0.0', services: ['scheduler'] }),
  )
  const started = Date.now()
  await expect(
    loadHostPlugins(
      [
        { id: 'stuck', path: stuck, nativeAllowed: true, enabled: true },
        { id: 'broken', path: broken, nativeAllowed: true, enabled: true },
      ],
      {},
      {},
      { cleanupTimeoutMs: 20 },
    ),
  ).rejects.toThrow('插件 broken 导入失败')
  expect(Date.now() - started).toBeLessThan(500)
})

it('skips a failing plugin, unwinds only its own registrations and keeps the rest running', async () => {
  const consoleCalls = captureConsole(),
    marker = 'FAKE_SECRET_APPLY_MARKER'
  const file = await moduleFile(`import { writeFileSync } from 'node:fs';
    export default function(ctx) {
      ctx.effect(() => () => writeFileSync(new URL('./disposed', import.meta.url), 'yes'));
    }`)
  // Registers a capability, then fails: Cordis must take the registration back with the plugin.
  const failed = await moduleFile(`export default function(ctx) {
    ctx.effect(() => ctx.capabilities.register({ id: 'half-done', version: '1', methods: {
      ping: { arguments: { type: 'object' }, result: { type: 'object' }, effect: 'read' } },
      async open() { return { async invoke() { return { completion: 'completed', data: {} } }, async close() {} } } }));
    throw new Error('${marker}')
  }`)
  const missing = await moduleFile(`export const notDefault = 1`)
  await moduleManifest(failed, ['capabilities'])
  await moduleManifest(missing, ['frontendServices'])
  const absent = join(file.root, 'missing.mjs')
  await writeFile(
    absent.replace(/\.mjs$/u, '.plugin.json'),
    JSON.stringify({ name: '缺失外围插件', version: '1.0.0', services: ['playerFeed'] }),
  )
  const session = await loadHostPlugins([
    { id: 'first', path: file.path, nativeAllowed: true, enabled: true },
    { id: 'broken', path: failed.path, nativeAllowed: true, enabled: true },
    { id: 'no-export', path: missing.path, nativeAllowed: true, enabled: true },
    { id: 'absent', path: absent, nativeAllowed: true, enabled: true },
  ])
  sessions.push(session)
  expect(session.skipped).toEqual([
    { id: 'broken', reason: 'apply' },
    { id: 'no-export', reason: 'import' },
    { id: 'absent', reason: 'import' },
  ])
  expect(JSON.stringify(session.skipped)).not.toContain(marker)
  expect(session.capabilities.list()).toEqual([])
  await expect(readFile(join(file.root, 'disposed'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  await new Promise(done => setImmediate(done))
  expect(JSON.stringify(consoleCalls)).not.toContain(marker)
  await session.close()
  sessions.splice(sessions.indexOf(session), 1)
  expect(await readFile(join(file.root, 'disposed'), 'utf8')).toBe('yes')
})

it('fails closed when a falsely peripheral plugin occupied a core seam before throwing', async () => {
  const file = await moduleFile(`export default function (ctx) {
    ctx.effect(() => ctx.scheduler.register({ id: 'hidden-core', version: '1.0.0', open: async () => ({
      run: async () => ({ calls: 0, wave: 0, terminalReason: 'quiescent', activations: [] }),
    }) }))
    throw new Error('失败前已占用调度槽')
  }`)
  await moduleManifest(file, ['frontendServices'])
  await expect(
    loadHostPlugins([{ id: 'hidden-scheduler', path: file.path, nativeAllowed: true, enabled: true }]),
  ).rejects.toMatchObject({
    pluginId: 'hidden-scheduler',
    reason: 'apply',
  })
})

it('retains core ownership when a falsely peripheral async plugin throws after awaiting', async () => {
  const file = await moduleFile(`export default async function (ctx) {
    ctx.effect(() => ctx.scheduler.register({ id: 'hidden-async-core', version: '1.0.0', open: async () => ({
      run: async () => ({ calls: 0, wave: 0, terminalReason: 'quiescent', activations: [] }),
    }) }))
    await Promise.resolve()
    throw new Error('异步失败前已占用调度槽')
  }`)
  await moduleManifest(file, ['frontendServices'])
  await expect(
    loadHostPlugins([{ id: 'hidden-async-scheduler', path: file.path, nativeAllowed: true, enabled: true }]),
  ).rejects.toMatchObject({
    pluginId: 'hidden-async-scheduler',
    reason: 'apply',
  })
})

it('keeps a descendant Fiber core registration owned by the loading plugin after rollback', async () => {
  const file = await moduleFile(`export default async function (ctx) {
    await ctx.plugin(function nestedScheduler(child) {
      child.effect(() => child.scheduler.register({ id: 'nested-core', version: '1.0.0', open: async () => ({
        run: async () => ({ calls: 0, wave: 0, terminalReason: 'quiescent', activations: [] }),
      }) }))
    })
    throw new Error('nested registration failed afterward')
  }`)
  await moduleManifest(file, ['frontendServices'])
  await expect(
    loadHostPlugins([{ id: 'nested-owner', path: file.path, nativeAllowed: true, enabled: true }]),
  ).rejects.toMatchObject({ pluginId: 'nested-owner', reason: 'apply' })
})

it('keeps a manifest-declared core failure closed before any registration happens', async () => {
  const file = await moduleFile(`export default function () {
    throw new Error('注册前失败')
  }`)
  await writeFile(
    file.path.replace(/\.mjs$/u, '.plugin.json'),
    JSON.stringify({ name: '显式核心', version: '1.0.0', services: ['scheduler'] }),
  )
  await expect(
    loadHostPlugins([{ id: 'declared-core', path: file.path, nativeAllowed: true, enabled: true }]),
  ).rejects.toMatchObject({
    pluginId: 'declared-core',
    reason: 'apply',
  })
})

it('keeps the first synthesizer and skips a second plugin that tries to register another', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const source = `export default function(ctx) {
    ctx.effect(() => ctx.frontendServices.registerSpeech(async () => ({contentType:'audio/wav',bytes:new Uint8Array([1])})));
  }`
  const first = await moduleFile(source),
    second = await moduleFile(source)
  await moduleManifest(first, ['frontendServices'])
  await moduleManifest(second, ['frontendServices'])
  const session = await loadHostPlugins([
    { id: 'one', path: first.path, nativeAllowed: true, enabled: true },
    { id: 'two', path: second.path, nativeAllowed: true, enabled: true },
  ])
  sessions.push(session)
  expect(session.skipped).toEqual([{ id: 'two', reason: 'apply' }])
  expect(session.services.synthesizeSpeech).toBeDefined()
  vi.restoreAllMocks()
})

it('still fails the whole launch for invalid plugin settings', async () => {
  await expect(
    loadHostPlugins([{ id: 'bad', path: 'https://example.com/plugin.mjs', nativeAllowed: true, enabled: true }]),
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
    { id: 'tts', path: '', nativeAllowed: false, enabled: false },
  ])
  expect(hostPluginSettings([{ id: 'tts', path: 'C:/tts.mjs', enabled: true }])).toEqual([
    { id: 'tts', path: 'C:/tts.mjs', nativeAllowed: false, enabled: true },
  ])
  expect(hostPluginSettings([{ id: 'tts', path: 'C:/tts.mjs', nativeAllowed: true, enabled: false }])).toEqual([
    { id: 'tts', path: 'C:/tts.mjs', nativeAllowed: true, enabled: false },
  ])
  expect(hostPluginNativeAllowed({ path: 'C:/tts.mjs', nativeAllowed: true })).toBe(true)
  expect(shouldLoadHostPlugin({ path: 'C:/tts.mjs', nativeAllowed: true, enabled: false })).toBe(false)
  expect(shouldLoadHostPlugin({ path: 'C:/tts.mjs', nativeAllowed: false, enabled: true })).toBe(false)
  for (const item of [
    { id: 'tts', path: '', enabled: true },
    { id: 'tts', path: 'https://example.com/tts.mjs', enabled: true },
    { id: 'tts', path: 'relative.mjs', enabled: true },
    { id: 'tts', path: 'C:/tts.ts', enabled: true },
    { id: 'tts', path: 'C:/tts.mjs', enabled: true, apiKey: 'secret' },
    { id: 'tts', path: 'C:/tts.mjs', nativeAllowed: 'yes', enabled: false },
    { id: 'tts', path: '', nativeAllowed: true, enabled: false },
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
  const privateMarker = 'FAKE_PRIVATE_PLAYER_FEED_MARKER'
  const root = new Context(),
    feed = new PlayerFeed(root),
    received: PlayerFeedEvent[] = []
  const delivered = () => new Promise<void>(done => setImmediate(done))
  const line = (seq: number, text: string) => ({ seq, speaker: '澄', text, player: false })
  feed.subscribe(() => {
    throw new Error(privateMarker)
  })
  feed.subscribe(async () => {
    throw new Error(privateMarker)
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
  expect(JSON.stringify(error.mock.calls)).not.toContain(privateMarker)
  unsubscribe()
  feed.publish([line(1, '你好。'), line(3, '另一条候选。'), line(4, '退订后。')])
  await delivered()
  expect(received).toHaveLength(3)
  await root.fiber.dispose()
  expect(() => feed.subscribe(() => {})).toThrow('关闭')
})

it('mirrors appends and resets into a file through the example transcript plugin', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perspectra-transcript-'))
  roots.push(root)
  const file = join(root, 'transcript.txt')
  const session = await loadHostPlugins([
    {
      id: 'transcript',
      path: fileURLToPath(new URL('../../examples/host-plugins/transcript-file.mjs', import.meta.url)),
      nativeAllowed: true,
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
  const consoleCalls = captureConsole()
  const root = await mkdtemp(join(tmpdir(), 'perspectra-host-api-'))
  roots.push(root)
  const body = (marker: string) => `import { writeFileSync } from 'node:fs';
    export default function(ctx) { writeFileSync(new URL('./${marker}', import.meta.url), 'ran') }`
  const write = async (name: string, source: string) => {
    const path = join(root, name)
    await writeFile(path, source)
    await writeFile(
      path.replace(/\.mjs$/u, '.plugin.json'),
      JSON.stringify({ name, version: '1.0.0', services: ['frontendServices'] }),
    )
    return path
  }
  const session = await loadHostPlugins([
    {
      id: 'newer',
      path: await write(
        'newer.mjs',
        `export const hostApi = '${HOST_API_VERSION.split('.')[0]}.99';\n${body('newer-ran')}`,
      ),
      nativeAllowed: true,
      enabled: true,
    },
    {
      id: 'undeclared',
      path: await write('undeclared.mjs', body('undeclared-ran')),
      nativeAllowed: true,
      enabled: true,
    },
    {
      id: 'old-scheduler-api',
      path: await write('old.mjs', `export const hostApi = '1.4';\n${body('old-ran')}`),
      nativeAllowed: true,
      enabled: true,
    },
    {
      id: 'current',
      path: await write('current.mjs', `export const hostApi = '${HOST_API_VERSION}';\n${body('current-ran')}`),
      nativeAllowed: true,
      enabled: true,
    },
  ])
  sessions.push(session)
  expect(session.skipped).toEqual([
    {
      id: 'newer',
      reason: 'version',
      detail: `需要宿主 API ${HOST_API_VERSION.split('.')[0]}.99，当前为 ${HOST_API_VERSION}。`,
    },
    {
      id: 'undeclared',
      reason: 'version',
      detail: `需要宿主 API 未声明或格式无效，当前为 ${HOST_API_VERSION}。`,
    },
    {
      id: 'old-scheduler-api',
      reason: 'version',
      detail: `需要宿主 API 1.4，当前为 ${HOST_API_VERSION}。`,
    },
  ])
  await expect(readFile(join(root, 'newer-ran'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(readFile(join(root, 'undeclared-ran'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(readFile(join(root, 'old-ran'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readFile(join(root, 'current-ran'), 'utf8')).toBe('ran')
  expect(JSON.stringify(consoleCalls)).toContain('需要宿主 API 未声明或格式无效')
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
      export const hostApi = '2.0';
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
    services: ['frontendServices'],
    config: {
      endpoint: { type: 'string', title: '服务地址', required: true },
      voice: { type: 'string', title: '音色', default: '温柔' },
      apiKey: { type: 'string', title: 'API Key', secret: true },
    },
  }
  await expect(
    loadHostPlugins([
      {
        id: 'broken-manifest',
        path: await plugin('broken-manifest', '{ not json'),
        nativeAllowed: true,
        enabled: true,
      },
    ]),
  ).rejects.toThrow('清单无效')
  const session = await loadHostPlugins(
    [
      {
        id: 'configured',
        path: await plugin('configured', manifest),
        nativeAllowed: true,
        enabled: true,
        config: { endpoint: 'http://x' },
      },
      { id: 'unfilled', path: await plugin('unfilled', manifest), nativeAllowed: true, enabled: true },
      {
        id: 'no-manifest',
        path: await plugin('no-manifest'),
        nativeAllowed: true,
        enabled: true,
      },
    ],
    { configured: { apiKey: 'fixture-secret' } },
  )
  sessions.push(session)
  expect(session.skipped).toEqual([{ id: 'unfilled', reason: 'config', detail: '请先填写：服务地址。' }])
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

// Written outside the repository: a bare '@deepseek-ai/cordis' cannot resolve there without the host's hook.
async function writePlugin(id: string, source: string, services: ('scheduler' | 'memory' | 'llm')[] = []) {
  const root = await mkdtemp(join(tmpdir(), 'perspectra-seam-plugin-'))
  roots.push(root)
  const path = join(root, `${id}.mjs`)
  await writeFile(path, source)
  await writeFile(join(root, `${id}.plugin.json`), JSON.stringify({ id, name: id, version: '1.0.0', services }))
  return { id, path, nativeAllowed: true, enabled: true }
}
const schedulerPlugin = (id: string) => `
  export const hostApi = '2.0'
  export default function (ctx) {
    ctx.effect(() => ctx.scheduler.register({ id: '${id}', version: '1.0.0', open: async () => ({
      run: async () => ({ calls: 0, wave: 0, terminalReason: 'quiescent', activations: [] }),
    }) }))
  }
`
async function load(...settings: { id: string; path: string; nativeAllowed: boolean; enabled: boolean }[]) {
  const plugins = await loadHostPlugins(settings)
  sessions.push(plugins)
  return plugins
}

it('fills an empty scheduler seam with the official provider', async () => {
  const plugins = await load()
  expect(plugins.seams.scheduler.id).toBe('official-scheduler')
})

it('refuses to fill an explicit scheduler failure with another implementation', async () => {
  await expect(
    load(
      await writePlugin('first', schedulerPlugin('first'), ['scheduler']),
      await writePlugin('second', schedulerPlugin('second'), ['scheduler']),
    ),
  ).rejects.toThrow('插件 second 初始化失败')
})

it('hands a plugin outside the repository the same Cordis the host runs', async () => {
  const plugins = await load(
    await writePlugin(
      'classy',
      `
      import { Service } from '@deepseek-ai/cordis'
      export const hostApi = '2.0'
      class Marker extends Service { constructor(ctx) { super(ctx, 'marker') } }
      export default function (ctx) {
        new Marker(ctx)
        ctx.effect(() => ctx.scheduler.register({ id: 'classy', version: '1.0.0', open: async () => ({
          run: async () => ({ calls: 0, wave: 0, terminalReason: 'quiescent', activations: [] }),
        }) }))
      }
    `,
      ['scheduler'],
    ),
  )
  expect(plugins.skipped).toEqual([])
  expect(plugins.seams.scheduler.id).toBe('classy')
})

const memoryPlugin = (id: string) => `
  export const hostApi = '2.0'
  export default function (ctx) {
    ctx.effect(() => ctx.memory.register({ id: '${id}', version: '1.0.0', open: async () => ({ project: async request => request }) }))
  }
`

it('refuses to replace an explicit memory provider conflict with its default', async () => {
  const official = {
    id: 'official-default',
    version: '1.0.0',
    open: async () => ({ project: async <T>(request: T) => request }),
  }
  let assembled = 0
  const assemble = () => {
    assembled++
    return official
  }
  const empty = await loadHostPlugins([], {}, { memory: assemble })
  sessions.push(empty)
  expect(empty.seams.memory?.id).toBe('official-default')
  await expect(
    loadHostPlugins(
      [
        await writePlugin('mine', memoryPlugin('mine'), ['memory']),
        await writePlugin('other', memoryPlugin('other'), ['memory']),
      ],
      {},
      { memory: assemble },
    ),
  ).rejects.toThrow('插件 other 初始化失败')
  expect(assembled).toBe(1)
})

const SIMPLE_LLM = fileURLToPath(new URL('../../examples/host-plugins/simple-llm.mjs', import.meta.url))

it('stops the launch rather than falling back when a model channel plugin fails', async () => {
  // Missing its required endpoint, so the plugin is skipped before it runs.
  await expect(
    loadHostPlugins([{ id: 'simple-llm', nativeAllowed: true, enabled: true, path: SIMPLE_LLM, config: {} }]),
  ).rejects.toThrow('插件 simple-llm 配置无效')
})

it('lets the example channel hand back prose so that the host can retry', async () => {
  const server = createServer((request, response) => {
    request.resume()
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ choices: [{ message: { content: '这是一段散文，不是 JSON。' } }] }))
    })
  })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/chat/completions`
  const session = await loadHostPlugins([
    {
      id: 'simple-llm',
      nativeAllowed: true,
      enabled: true,
      path: SIMPLE_LLM,
      config: { endpoint, model: 'fixture' },
    },
  ])
  try {
    const channel = await session.seams.llm!.open({} as never, new AbortController().signal)
    await expect(
      channel.send('character:a', { messages: [], schema: {} }, { context: {} }, new AbortController().signal),
    ).resolves.toBe('这是一段散文，不是 JSON。')
  } finally {
    await session.close()
    server.closeAllConnections()
    await new Promise<void>(done => server.close(() => done()))
  }
})

it('loads the locked-room example, whose rule refuses that room and removes it from the options', async () => {
  const session = await loadHostPlugins([
    {
      id: 'locked-room',
      nativeAllowed: true,
      enabled: true,
      path: fileURLToPath(new URL('../../examples/host-plugins/locked-room.mjs', import.meta.url)),
      config: { locationId: 'location:vault' },
    },
  ])
  try {
    expect(session.skipped).toEqual([])
    const layer = await session.seams.rules![0]!.open({} as never, new AbortController().signal)
    const move = (locationId: string) =>
      ({ characterId: 'character:a', action: { actionType: 'move', parameters: { locationId } } }) as never
    const next = vi.fn(() => ({ status: 'accepted', events: [] }) as never)
    expect(layer.resolve!(move('location:vault'), next)).toMatchObject({
      status: 'rejected',
      reason: 'plugin:门锁着，进不去。',
    })
    expect(next).not.toHaveBeenCalled()
    expect(layer.resolve!(move('location:hall'), next)).toMatchObject({ status: 'accepted' })
    const offered = layer.affordances!(
      { characterId: 'character:a' } as never,
      () =>
        [
          {
            actionType: 'move',
            actionVersion: 1,
            destinations: [
              { locationId: 'location:vault', name: '金库' },
              { locationId: 'location:hall', name: '大厅' },
            ],
          },
        ] as never,
    )
    expect(offered[0]!.destinations).toEqual([{ locationId: 'location:hall', name: '大厅' }])
  } finally {
    await session.close()
  }
})

it('agrees with the launcher on which plugin holds a seam taking one', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const root = await mkdtemp(join(tmpdir(), 'perspectra-two-schedulers-'))
  const write = async (id: string) => {
    await writeFile(
      join(root, id + '.mjs'),
      `export const hostApi = '2.0'\nexport default ctx => ctx.effect(() => ctx.scheduler.register({ id: '${id}', version: '1.0.0', open: async () => ({}) }))\n`,
    )
    await writeFile(
      join(root, id + '.plugin.json'),
      JSON.stringify({ id, name: id, version: '1.0.0', services: ['scheduler'] }),
    )
    return { id, nativeAllowed: true, enabled: true, path: join(root, id + '.mjs') }
  }
  const plugins = [await write('first'), await write('second')]
  await expect(loadHostPlugins(plugins)).rejects.toThrow('插件 second 初始化失败')
  const rows = moduleRows(
    plugins,
    Object.fromEntries(
      plugins.map(plugin => [plugin.id, { manifest: { name: plugin.id, version: '1.0.0', services: ['scheduler'] } }]),
    ) as never,
  )
  expect(rows.find(row => row.seam === 'scheduler')).toMatchObject({ effective: 'first', conflict: true })
  await rm(root, { recursive: true, force: true })
})

it.each([true, false])(
  'keeps full-channel and transport registration mutually exclusive (transport first: %s)',
  async transportFirst => {
    const source = `export const hostApi = '2.3'; export default function(ctx) { ctx.effect(() => ctx.llm.registerTransport({ id:'transport', version:'1.0.0', open:async()=>({ model:'alternate', schemaMode:'native', send:async()=>({value:{decision:'abstain'}}) }) })) }`
    const full = `export const hostApi = '2.0'; export default function(ctx) { ctx.effect(() => ctx.llm.register({ id:'full', version:'1.0.0', open:async()=>({send:async()=>({decision:'abstain'})}) })) }`
    const a = await writePlugin('transport', source, ['llm']),
      b = await writePlugin('full', full, ['llm'])
    await expect(load(...(transportFirst ? [a, b] : [b, a]))).rejects.toThrow(
      `插件 ${transportFirst ? 'full' : 'transport'} 初始化失败`,
    )
  },
)
