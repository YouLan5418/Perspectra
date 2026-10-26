import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { FrontendServices, loadHostPlugins } from '../../desktop/host-plugins.ts'
import { createHostServer, type HostState } from '../../desktop/host/http-server.ts'
import type { FrontendHostServices } from '../../packages/frontend/src/speech.ts'
import type { FrontendBgmPlugin } from '../../packages/frontend/src/bgm.ts'

const token = 'c'.repeat(64),
  servers: ReturnType<typeof createHostServer>[] = [],
  roots: Context[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>(done => server.close(() => done()))
  }
  for (const root of roots.splice(0)) await root.fiber.dispose()
})
const paragraph = { seq: 7, segmentIndex: 0, text: '有点紧张。' }
const track = { id: 'tense', title: '紧张', contentType: 'audio/wav' as const, bytes: new Uint8Array([82, 73, 70, 70]) }
function service(selector: FrontendBgmPlugin['selectTrack'] = () => 'tense') {
  const root = new Context(),
    services = new FrontendServices(root)
  const selectTrack = vi.fn(selector)
  roots.push(root)
  const dispose = services.registerBgm({ tracks: [track], selectTrack })
  return { root, services, dispose, selectTrack }
}
async function fixture(services: FrontendHostServices = {}) {
  let state: HostState = {
    busy: false,
    paused: false,
    error: false,
    notice: 'PRIVATE_NOTICE',
    phaseLabel: '',
    debug: { key: 'PRIVATE_KEY' },
    world: { title: '测试', playerName: '玩家', npcNames: ['PRIVATE_NPC'] },
    transcript: [{ seq: 7, speaker: '同行者', text: paragraph.text, player: false }],
  }
  const submit = vi.fn(async () => state)
  const server = createHostServer(
    { state: async () => state, submit, pause: async () => state, resume: async () => state, close: async () => {} },
    token,
    undefined,
    undefined,
    services,
  )
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const send = (path: string, payload: unknown, headers: Record<string, string> = { 'x-playtest-token': token }) =>
    fetch(url + '/frontend-api/v1/' + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(payload),
    })
  return {
    url,
    send,
    submit,
    replace: () => {
      state = { ...state, transcript: [] }
    },
  }
}

it('advertises BGM only with a service and delivers only registered audio and authorized reading input', async () => {
  const absent = await fixture()
  const capabilities = async (url: string) =>
    (await (await fetch(url + '/frontend-api/v1/init', { headers: { 'x-playtest-token': token } })).json()).capabilities
  expect(await capabilities(absent.url)).not.toContain('bgm')
  expect((await absent.send('bgm', paragraph)).status).toBe(404)
  const { services, selectTrack, dispose } = service(),
    { url, send, submit } = await fixture(services)
  expect(await capabilities(url)).toContain('bgm')
  expect((await send('bgm', paragraph, {})).status).toBe(401)
  expect((await send('bgm', paragraph, { 'x-playtest-token': token, origin: 'null' })).status).toBe(403)
  expect((await send('bgm', { ...paragraph, text: 'PRIVATE_NPC' })).status).toBe(400)
  expect((await send('bgm', { ...paragraph, speakerId: 'forged' })).status).toBe(400)
  expect(selectTrack).not.toHaveBeenCalled()
  expect(await (await send('bgm', paragraph)).json()).toEqual({ track: { id: 'tense', title: '紧张' } })
  expect(selectTrack.mock.calls[0]?.[0]).toEqual({ ...paragraph, type: 'speech' })
  const audio = await send('bgm/audio', { id: 'tense' })
  expect(audio.headers.get('content-type')).toBe('audio/wav')
  expect(new Uint8Array(await audio.arrayBuffer())).toEqual(track.bytes)
  expect((await send('bgm/audio', { id: 'C:/private/secret.wav' })).status).toBe(404)
  expect((await send('bgm/audio', { id: 'tense', path: 'private' })).status).toBe(400)
  expect(submit).not.toHaveBeenCalled()
  dispose()
  expect(await capabilities(url)).not.toContain('bgm')
  expect((await send('bgm/audio', { id: 'tense' })).status).toBe(404)
})

it('rejects stale selections after candidate replacement and hides plugin failures', async () => {
  let release!: (id: string) => void
  const root = new Context(),
    services = new FrontendServices(root)
  roots.push(root)
  const selectTrack = vi.fn(
    () =>
      new Promise<string>(done => {
        release = done
      }),
  )
  services.registerBgm({ tracks: [track], selectTrack })
  const { send, replace } = await fixture(services)
  const pending = send('bgm', paragraph)
  await vi.waitFor(() => expect(selectTrack).toHaveBeenCalledOnce())
  replace()
  release('tense')
  expect((await pending).status).toBe(409)
  const failed = service(
    vi.fn(() => {
      throw new Error('PRIVATE_PROVIDER_KEY')
    }),
  )
  const response = await (await fixture(failed.services)).send('bgm', paragraph)
  expect(response.status).toBe(502)
  expect(await response.text()).not.toContain('PRIVATE_')
})

it('owns music lifetime, rejects duplicate or invalid registrations and cancels late selections', async () => {
  const { root, services, dispose } = service()
  expect(() => services.registerBgm({ tracks: [track], selectTrack: () => null })).toThrow('Only one')
  dispose()
  expect(() => services.registerBgm({ tracks: [track, track], selectTrack: () => null })).toThrow('duplicate')
  expect(() =>
    services.registerBgm({ tracks: [{ ...track, bytes: new Uint8Array() }], selectTrack: () => null }),
  ).toThrow('Invalid')
  let release!: (value: string) => void, signal: AbortSignal | undefined
  services.registerBgm({
    tracks: [track],
    selectTrack: (_input, supplied) => {
      signal = supplied
      return new Promise<string>(done => {
        release = done
      })
    },
  })
  const captured = services.bgm!
  const pending = captured.selectTrack({ ...paragraph, type: 'speech' }, new AbortController().signal)
  const rejected = expect(pending).rejects.toThrow()
  await root.fiber.dispose()
  expect(signal?.aborted).toBe(true)
  release('tense')
  await rejected
  expect(() => captured.getTrack('tense')).toThrow()
})

it('loads the runnable creator Cordis example and serves its WAV through the real host', async () => {
  const session = await loadHostPlugins([
    {
      id: 'bgm',
      path: fileURLToPath(new URL('../../examples/host-plugins/demo-bgm.mjs', import.meta.url)),
      enabled: true,
    },
  ])
  try {
    const { send } = await fixture(session.services)
    expect(await (await send('bgm', paragraph)).json()).toEqual({ track: { id: 'tense', title: '紧张（示例和弦）' } })
    const audio = new Uint8Array(await (await send('bgm/audio', { id: 'tense' })).arrayBuffer())
    expect(new TextDecoder().decode(audio.slice(0, 4))).toBe('RIFF')
    expect(audio.byteLength).toBeGreaterThan(1000)
    // A copied host-service object still cannot serve assets after its owner exits.
    const copied = { ...session.services }
    await session.close()
    expect((await (await fixture(copied)).send('bgm/audio', { id: 'tense' })).status).toBe(502)
  } finally {
    await session.close()
  }
})
