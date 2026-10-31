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
const lens = (core: LauncherCore, request: Record<string, unknown>) => core.handle(request) as Promise<LensSnapshot>

describe('Launcher pack lens operations', () => {
  it('lens-open refuses a pack with a validation error', async () => {
    const core = await service()
    const { path, packageId } = await withSweetDays(core)
    await writeFile(join(path, 'worldpack.source.json'), '{broken')
    const restored = new LauncherCore(resolve('.'), core.root)
    cores.push(restored)
    await restored.initialize()
    expect(restored.snapshot().packDetails[packageId]!.error).toContain('世界包')
    await expect(restored.handle({ operation: 'lens-open', packageId })).rejects.toThrow('世界包')
    await expect(restored.handle({ operation: 'lens-reload' })).rejects.toThrow('透视尚未打开')
  }, 60_000)

  it('lens-open returns the sweet-days view without creating an instance', async () => {
    const core = await service()
    const { packageId } = await withSweetDays(core)
    const before = await readFile(join(core.root, 'launcher.json'), 'utf8')
    const snapshot = await lens(core, { operation: 'lens-open', packageId })
    expect(snapshot.view.items.length).toBeGreaterThan(10)
    expect(snapshot.baseline).toEqual({ kind: 'none' })
    expect(snapshot.simulation.trace).toEqual([])
    expect(core.snapshot().instances).toEqual([])
    expect(await readFile(join(core.root, 'launcher.json'), 'utf8')).toBe(before)
    expect(existsSync(join(core.root, 'instances'))).toBe(false)
    await expect(core.handle({ operation: 'lens-close' })).resolves.toEqual({})
    await expect(core.handle({ operation: 'lens-seen' })).rejects.toThrow('透视尚未打开')
  }, 120_000)

  it('lens-seen moves the baseline, reload alone does not', async () => {
    const core = await service()
    const { path, packageId } = await withSweetDays(core)
    await lens(core, { operation: 'lens-open', packageId })
    const seen = await lens(core, { operation: 'lens-seen' })
    expect(seen.baseline).toEqual({ kind: 'seen' })
    expect(seen.changes).toEqual([])
    const file = join(path, 'characters.json')
    const edited = JSON.parse(await readFile(file, 'utf8'))
    edited.characters[0].displayName += '改'
    await writeFile(file, JSON.stringify(edited))
    const reloaded = await lens(core, { operation: 'lens-reload' })
    expect(reloaded.changes.length).toBeGreaterThan(0)
    expect((await lens(core, { operation: 'lens-reload' })).changes).toEqual(reloaded.changes)
    expect((await lens(core, { operation: 'lens-seen' })).changes).toEqual([])
  }, 180_000)

  it('lens-step appends to the trace; requests are added by item id and closed', async () => {
    const core = await service()
    const { packageId } = await withSweetDays(core)
    const opened = await lens(core, { operation: 'lens-open', packageId })
    const one = await lens(core, { operation: 'lens-step', step: { kind: 'wait' } })
    const two = await lens(core, { operation: 'lens-step', step: { kind: 'wait' } })
    expect(one.simulation.trace).toHaveLength(1)
    expect(two.simulation.trace.map(trace => trace.index)).toEqual([0, 1])
    await expect(
      core.handle({ operation: 'lens-request-add', itemId: 'no-such-item', note: '改一下' }),
    ).rejects.toThrow('找不到设置项')
    const added = await lens(core, { operation: 'lens-request-add', itemId: opened.view.items[0]!.id, note: '改一下' })
    expect(added.requests).toHaveLength(1)
    const closed = await lens(core, { operation: 'lens-request-close', id: added.requests[0]!.id })
    expect(closed.requests[0]!.state).toBe('closed')
    const restarted = await lens(core, { operation: 'lens-restart', start: {} })
    expect(restarted.simulation.trace).toEqual([])
  }, 180_000)

  it('lens session survives start and does not touch instance data', async () => {
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

    await lens(core, { operation: 'lens-open', packageId })
    await lens(core, { operation: 'lens-step', step: { kind: 'wait' } })
    // The fake runtime stands in for the game process only; the lens simulation was opened without it.
    vi.stubEnv('PERSPECTRA_RUNTIME_ROOT', runtime)
    vi.stubEnv('HCW_HINDSIGHT_PYTHON', process.execPath)
    await core.handle({ operation: 'start', instanceId })
    expect(core.snapshot().core.state).toBe('running')
    const afterStart = await readdir(join(core.root, 'instances', instanceId))
    const index = await readFile(join(core.root, 'launcher.json'), 'utf8')
    const during = await lens(core, { operation: 'lens-step', step: { kind: 'wait' } })
    expect(during.simulation.trace).toHaveLength(2)
    await lens(core, { operation: 'lens-seen' })
    await core.handle({ operation: 'stop' })
    vi.unstubAllEnvs()
    expect((await lens(core, { operation: 'lens-reload' })).simulation.trace).toEqual([])
    expect(await readdir(join(core.root, 'instances', instanceId))).toEqual(afterStart)
    expect(await readFile(join(core.root, 'launcher.json'), 'utf8')).toBe(index)
  }, 240_000)
})
