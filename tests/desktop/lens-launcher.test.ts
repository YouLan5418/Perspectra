import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LauncherCore } from '../../desktop/launcher-core.ts'
import type { LensSnapshot } from '../../desktop/lens/session.ts'

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
  const root = await mkdtemp(join(tmpdir(), 'perspectra-lens-launcher-'))
  roots.push(root)
  const core = new LauncherCore(resolve('.'), root)
  await core.initialize()
  cores.push(core)
  return core
}
/** The pack is copied, so the author's `.perspectra-lens` folder is written beside a throwaway copy. */
async function withSweetDays(core: LauncherCore) {
  const path = join(core.root, 'sweet-days')
  await cp(SWEET, path, { recursive: true, filter: source => !source.includes('.perspectra-lens') })
  await core.handle({ operation: 'load', path })
  return { path, packageId: core.snapshot().packs[0]!.id }
}
const openLens = async (core: LauncherCore, packageId: string) =>
  (await core.handle({ operation: 'lens-open', packageId })) as { url: string }
function page(url: string) {
  const { origin, hash } = new URL(url)
  return async (operation: string, data: Record<string, unknown> = {}) => {
    const response = await fetch(origin + '/api/lens', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-lens-token': hash.slice('#token='.length) },
      body: JSON.stringify({ operation, ...data }),
    })
    return (await response.json()) as LensSnapshot & { error?: string }
  }
}

describe('Launcher pack lens page', () => {
  it('opens a page for a pack without creating an instance, and reuses it', async () => {
    const core = await service()
    const { packageId } = await withSweetDays(core)
    const before = await readFile(join(core.root, 'launcher.json'), 'utf8')
    const { url } = await openLens(core, packageId)
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/lens\/#token=[a-f0-9]{64}$/)
    expect((await openLens(core, packageId)).url).toBe(url)
    const snapshot = await page(url)('lens-open')
    expect(snapshot.view.items.length).toBeGreaterThan(10)
    expect(snapshot.simulation.trace).toEqual([])
    expect(core.snapshot().instances).toEqual([])
    expect(await readFile(join(core.root, 'launcher.json'), 'utf8')).toBe(before)
    expect(existsSync(join(core.root, 'instances'))).toBe(false)
    await expect(core.handle({ operation: 'lens-open', packageId: 'pack:none' })).rejects.toThrow('世界包不存在')
    await expect(core.handle({ operation: 'lens-close' })).resolves.toEqual({})
    await expect(page(url)('lens-open')).rejects.toThrow()
  }, 120_000)

  it('a pack that fails validation still opens, and the page says why', async () => {
    const core = await service()
    const { path, packageId } = await withSweetDays(core)
    await writeFile(join(path, 'worldpack.source.json'), '{broken')
    const restored = new LauncherCore(resolve('.'), core.root)
    cores.push(restored)
    await restored.initialize()
    expect(restored.snapshot().packDetails[packageId]!.error).toContain('世界包')
    const { url } = await openLens(restored, packageId)
    expect((await page(url)('lens-open')).error).toBeTruthy()
  }, 60_000)

  it('the page keeps working while a game runs and leaves instance data alone', async () => {
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

    const lens = page((await openLens(core, packageId)).url)
    await lens('lens-open')
    await lens('lens-step', { step: { kind: 'wait' } })
    // The fake runtime stands in for the game process only; the lens simulation was opened without it.
    vi.stubEnv('PERSPECTRA_RUNTIME_ROOT', runtime)
    vi.stubEnv('HCW_HINDSIGHT_PYTHON', process.execPath)
    await core.handle({ operation: 'start', instanceId })
    expect(core.snapshot().core.state).toBe('running')
    const afterStart = await readdir(join(core.root, 'instances', instanceId))
    const index = await readFile(join(core.root, 'launcher.json'), 'utf8')
    const during = await lens('lens-step', { step: { kind: 'wait' } })
    expect(during.simulation.trace).toHaveLength(2)
    await lens('lens-seen')
    await core.handle({ operation: 'stop' })
    vi.unstubAllEnvs()
    expect((await lens('lens-reload')).simulation.trace).toEqual([])
    expect(await readdir(join(core.root, 'instances', instanceId))).toEqual(afterStart)
    expect(await readFile(join(core.root, 'launcher.json'), 'utf8')).toBe(index)
  }, 240_000)
})
