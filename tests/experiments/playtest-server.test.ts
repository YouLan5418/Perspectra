import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPlaytestServer, PlaytestBusyError, type PlaytestRuntime, type PlaytestState } from './playtest-server.ts'
import { PLAYTEST_PAGE } from './playtest-page.ts'

const token = 'a'.repeat(64)
const state: PlaytestState = {
  busy: false, paused: false, phaseLabel: '可以输入', notice: '', error: false,
  transcript: [{ seq: 1, speaker: '玩家', text: '你好', player: true }],
  world: { title: '测试世界', playerName: '玩家', npcNames: ['Alice'] },
  debug: { tick: 1 },
}
const servers: ReturnType<typeof createPlaytestServer>[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) {
    if (server.listening) {
      server.close()
      await once(server, 'close')
    }
  }
})

async function fixture(overrides: Partial<PlaytestRuntime> = {}) {
  const runtime: PlaytestRuntime = {
    state: async () => state,
    submit: async () => state,
    pause: async () => ({ ...state, paused: true }),
    resume: async () => state,
    close: async () => {},
    ...overrides,
  }
  const server = createPlaytestServer(runtime, token)
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = (server.address() as AddressInfo).port
  return { runtime, url: `http://127.0.0.1:${port}` }
}

function auth(init: RequestInit = {}): RequestInit {
  return { ...init, headers: { 'x-playtest-token': token, ...init.headers } }
}

describe('local playtest server', () => {
  it('serves a self-contained page without exposing its fragment token', async () => {
    const { url } = await fixture()
    const response = await fetch(url)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-security-policy')).toContain("connect-src 'self'")
    const page = await response.text()
    expect(page).toBe(PLAYTEST_PAGE)
    expect(page).toContain('本机世界试玩')
    expect(page).toContain('id="scene"')
    expect(page).toContain('state.world.currentScene')
    expect(page).toContain('state.world.title')
    expect(page).not.toContain(token)
    expect(page).not.toMatch(/https?:\/\//)
  })

  it('requires the random token for every API route and exposes only supplied player state', async () => {
    const { url } = await fixture()
    expect((await fetch(`${url}/api/state`)).status).toBe(401)
    const response = await fetch(`${url}/api/state`, auth())
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(state)
  })

  it('validates submit requests and delegates pause and resume', async () => {
    const submit = vi.fn(async () => state)
    const pause = vi.fn(async () => ({ ...state, paused: true }))
    const resume = vi.fn(async () => state)
    const { url } = await fixture({ submit, pause, resume })
    expect((await fetch(`${url}/api/submit`, auth({ method: 'POST' }))).status).toBe(400)
    expect((await fetch(`${url}/api/submit`, auth({ method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }))).status).toBe(400)
    const accepted = await fetch(`${url}/api/submit`, auth({ method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"text":" hello "}' }))
    expect(accepted.status).toBe(200)
    expect(submit).toHaveBeenCalledWith('hello')
    const multiline = await fetch(`${url}/api/submit`, auth({ method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '第一行\r\n第二行\n\t第三行' }) }))
    expect(multiline.status).toBe(200)
    expect(submit).toHaveBeenLastCalledWith('第一行 第二行 第三行')
    expect((await fetch(`${url}/api/pause`, auth({ method: 'POST' }))).status).toBe(200)
    expect((await fetch(`${url}/api/resume`, auth({ method: 'POST' }))).status).toBe(200)
    expect(pause).toHaveBeenCalledOnce()
    expect(resume).toHaveBeenCalledOnce()
  })

  it('maps busy separately and suppresses unexpected runtime details', async () => {
    const busy = await fixture({ submit: async () => { throw new PlaytestBusyError('请等待当前行动完成') } })
    const busyResponse = await fetch(`${busy.url}/api/submit`, auth({ method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"text":"x"}' }))
    expect(busyResponse.status).toBe(409)
    expect(await busyResponse.json()).toEqual({ error: '请等待当前行动完成' })
    busy.runtime.submit = async () => { throw new Error('PRIVATE_CONTEXT_CANARY') }
    const failed = await fetch(`${busy.url}/api/submit`, auth({ method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"text":"x"}' }))
    expect(failed.status).toBe(500)
    expect(JSON.stringify(await failed.json())).not.toContain('PRIVATE_CONTEXT_CANARY')
    expect((await fetch(`${busy.url}/unknown`, auth())).status).toBe(404)
  })

  it('rejects invalid tokens at construction', () => {
    expect(() => createPlaytestServer({} as PlaytestRuntime, 'short')).toThrow('32 random bytes')
  })
})
