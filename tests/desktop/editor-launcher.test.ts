import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LauncherCore } from '../../apps/launcher/backend/core.ts'

const SWEET = resolve('examples/world-packs/model-girls-sweet-days')
const CONNECTION = '6f1c2a4e-1d0b-4c39-9a51-0d6c1b7e2f10'
const roots: string[] = []
const cores: LauncherCore[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(cores.splice(0).map(core => core.close()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
async function service() {
  const root = await mkdtemp(join(tmpdir(), 'perspectra-editor-launcher-'))
  roots.push(root)
  const core = new LauncherCore(resolve('.'), root)
  await core.initialize()
  cores.push(core)
  return core
}
async function withSweetDays(core: LauncherCore) {
  const path = join(core.root, 'sweet-days')
  await cp(SWEET, path, { recursive: true })
  await core.handle({ operation: 'load', path })
  return { path, packageId: core.snapshot().packs[0]!.id }
}
const openEditor = async (core: LauncherCore, packageId: string) =>
  new URL(((await core.handle({ operation: 'editor-open', packageId })) as { url: string }).url)
function request(url: URL, operation: string, token = url.hash.slice(7)) {
  return fetch(new URL('/api/editor', url), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-editor-token': token },
    body: JSON.stringify({ operation }),
  })
}
describe('Launcher pack editor', () => {
  it('opens the selected source in an authenticated editor without creating an instance', async () => {
    const core = await service()
    const { packageId } = await withSweetDays(core)
    const before = await readFile(join(core.root, 'launcher.json'), 'utf8')
    const url = await openEditor(core, packageId)
    expect(url.pathname).toBe('/editor/')
    expect((await openEditor(core, packageId)).href).toBe(url.href)
    expect((await request(url, 'records', '')).status).toBe(401)
    expect((await (await request(url, 'records')).json()).records.length).toBeGreaterThan(0)
    for (const path of ['/lens/', '/api/lens', '/api/lens/status']) {
      expect((await fetch(new URL(path, url))).status).toBe(404)
    }
    expect(core.snapshot().instances).toEqual([])
    expect(await readFile(join(core.root, 'launcher.json'), 'utf8')).toBe(before)
    expect(existsSync(join(core.root, 'instances'))).toBe(false)
    await expect(openEditor(core, 'pack:none')).rejects.toThrow('世界包不存在')
    await core.handle({ operation: 'editor-close' })
    await expect(request(url, 'records')).rejects.toThrow()
  }, 60_000)

  it('suspends source edits during a running game and enables them again after stop', async () => {
    const core = await service()
    await core.handle({
      operation: 'connection-save',
      connection: {
        id: CONNECTION,
        name: '本地',
        protocol: 'openai',
        endpoint: 'http://127.0.0.1:8046/v1/chat/completions',
      },
    })
    const { packageId } = await withSweetDays(core)
    await core.handle({
      operation: 'create',
      packageId,
      name: '试玩',
      models: { decision: { connectionId: CONNECTION, model: 'fixture' } },
    })
    const instanceId = core.snapshot().instances[0]!.id
    const runtime = join(core.root, 'fake-runtime')
    await mkdir(runtime)
    await writeFile(
      join(runtime, 'playtest.mjs'),
      "process.on('message', m => { if (m.type === 'shutdown') process.disconnect() })\n" +
        "process.send({ type: 'ready', port: 12345, token: 'a'.repeat(64), frontendMode: 'sandbox' })\n",
    )

    const editor = await openEditor(core, packageId)
    vi.stubEnv('PERSPECTRA_RUNTIME_ROOT', runtime)
    vi.stubEnv('HCW_HINDSIGHT_PYTHON', process.execPath)
    await core.handle({ operation: 'start', instanceId })
    expect(core.snapshot().core.state).toBe('running')
    await expect(openEditor(core, packageId)).rejects.toThrow('结束游戏')
    expect((await (await request(editor, 'record-save')).json()).error).toContain('结束游戏')
    await core.handle({ operation: 'stop' })
    expect((await (await request(editor, 'open')).json()).graphs).toBeDefined()
  }, 120_000)
})
