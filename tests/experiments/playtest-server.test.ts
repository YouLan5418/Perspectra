import { once } from 'node:events'
import { resolve } from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPlaytestServer, PlaytestBusyError, type PlaytestRuntime, type PlaytestState } from './playtest-server.ts'
import { HOST_ACTIVITY_PAGE } from './playtest-host-page.ts'
import { loadPackWeb, type PackWeb } from './playtest-pack-web.ts'

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

async function fixture(overrides: Partial<PlaytestRuntime> = {}, packWeb?: PackWeb) {
  const runtime: PlaytestRuntime = {
    state: async () => state,
    submit: async () => state,
    pause: async () => ({ ...state, paused: true }),
    resume: async () => state,
    close: async () => {},
    ...overrides,
  }
  const server = createPlaytestServer(runtime, token, packWeb)
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
  it('serves a trusted host and a separate default sandbox without embedding the token', async () => {
    const { url } = await fixture()
    const response = await fetch(url)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-security-policy')).toContain("connect-src 'self'")
    const page = await response.text()
    expect(page).toBe(HOST_ACTIVITY_PAGE)
    expect(page).toContain('sandbox="allow-scripts"')
    expect((await (await fetch(url+'/frontend-api/v1/init',auth())).json()).frontendMode).toBe('sandbox')
    expect(page).not.toContain(token)
    const child = await fetch(url + '/frontend/default.html')
    expect(child.headers.get('content-security-policy')).toContain("connect-src 'none'")
    expect(await child.text()).toContain('/frontend/sdk.js')
  })

  it('serves declared frontend resources and retains the official fallback', async () => {
    const packWeb = await loadPackWeb(resolve('examples/world-packs/ai-girls-awaken-v10'))
    expect(packWeb).toBeDefined()
    expect(await loadPackWeb(resolve('examples/world-packs/hand-in-hand'))).toBeUndefined()
    const { url } = await fixture({}, packWeb)
    expect(await (await fetch(url)).text()).toBe(HOST_ACTIVITY_PAGE)
    const page = await fetch(url + '/frontend/custom/index.html')
    expect(await page.text()).toContain('/frontend/sdk.js')
    expect(page.headers.get('content-security-policy')).toContain('sandbox allow-scripts')
    const script = await fetch(url + '/frontend/custom/app.js')
    expect(script.headers.get('content-type')).toContain('text/javascript')
    expect(await script.text()).toContain('window.Perspectra')
    const style = await fetch(url + '/frontend/custom/style.css')
    expect(style.headers.get('content-type')).toContain('text/css')
    expect((await style.text()).length).toBeGreaterThan(100)
    expect((await fetch(url + '/frontend/custom/not-declared.js')).status).toBe(404)
    expect((await fetch(url + '/frontend-api/v1/init?template=default', auth())).status).toBe(200)
    expect((await fetch(url + '/api/state')).status).toBe(401)
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

  it('accepts a structured action as a proposal and rejects invalid action bodies', async () => {
    const perform = vi.fn(async () => state)
    const { url } = await fixture({ perform })
    const send = (value: unknown) => fetch(`${url}/api/perform`, auth({ method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) }))
    expect((await send({ actionType: 'interact', parameters: [] })).status).toBe(400)
    expect((await send({ actionType: 'admin', parameters: {} })).status).toBe(400)
    expect((await fetch(`${url}/api/perform`, { method: 'POST' })).status).toBe(401)
    const accepted = await send({ actionType: 'move', parameters: { locationId: 'location:back-room' } })
    expect(accepted.status).toBe(200)
    expect(perform).toHaveBeenCalledWith({ actionType: 'move', parameters: { locationId: 'location:back-room' } })
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
