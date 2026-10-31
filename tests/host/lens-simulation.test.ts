import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { WorldJsonObject } from '@harness-world/contracts'
import { WorldStore } from '@harness-world/store-sqlite'
import { LensSimulation, type LensStart } from '../../desktop/lens/simulation.ts'
import { startStubModel } from '../../desktop/lens/stub-model.ts'
import { WorldHostRuntime } from '../../desktop/host/world-runtime.ts'
import type { HostAction, HostState } from '../../desktop/host/http-server.ts'

const PACK = resolve('examples/world-packs/model-girls-sweet-days')
const PLAYER = 'character:player',
  DEEPSEEK = 'character:deepseek'
const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function open(packPath: string, start?: LensStart) {
  const simulation = await LensSimulation.open(packPath, start)
  cleanups.push(() => simulation.close())
  return simulation
}
function tempDir(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), prefix))
  cleanups.push(() => rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }))
  return root
}
const kitchenStart = (slot: string): LensStart => ({
  status: { public: { slot } },
  scenes: { [PLAYER]: 'scene:living-room', [DEEPSEEK]: 'scene:kitchen' },
  skipAutoStart: ['prologue'],
})
function moveTo(state: HostState, locationId: string): HostAction {
  const offered = (state.availableActions ?? []).some(
    a => a.actionType === 'move' && (a.destinations ?? []).some(d => d.locationId === locationId),
  )
  if (!offered) throw new Error('move to ' + locationId + ' is not offered')
  return { actionType: 'move', parameters: { locationId } }
}
function mtimes(root: string): Record<string, number> {
  const result: Record<string, number> = {}
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true }))
    if (entry.isFile()) {
      const path = join(entry.parentPath, entry.name)
      result[path] = statSync(path).mtimeMs
    }
  return result
}

it('midnight kitchen starts the fridge event', async () => {
  const lens = await open(PACK, kitchenStart('深夜'))
  const trace = await lens.step({ kind: 'action', action: moveTo(await lens.state(), 'location:kitchen') })
  expect(trace.error).toBeUndefined()
  expect(trace.autoStart.find(e => e.activityKey === 'midnight-fridge')?.started).toBe(true)
  expect(trace.lines.some(line => line.kind === 'activity')).toBe(true)
  expect(trace.lines.some(line => line.kind === 'moved' && line.text.includes('厨房'))).toBe(true)
}, 60_000)

it('daytime kitchen explains the failed condition', async () => {
  const lens = await open(PACK, kitchenStart('上午'))
  const trace = await lens.step({ kind: 'action', action: moveTo(await lens.state(), 'location:kitchen') })
  const fridge = trace.autoStart.find(e => e.activityKey === 'midnight-fridge')!
  expect(fridge.started).toBe(false)
  expect(fridge.checks).toContainEqual({ label: '时段是深夜', met: false })
}, 60_000)

it('round hook shows in the trace', async () => {
  const lens = await open(PACK, { skipAutoStart: ['prologue'] })
  const trace = await lens.step({ kind: 'wait' })
  expect(trace.error).toBeUndefined()
  // Sweet days has no onRoundEnd; a pause round still commits its round record without changes.
  expect(trace.lines.filter(line => line.kind === 'round-hook').map(line => line.text)).toEqual(['回合结束：无变化'])
}, 60_000)

it('npc plan is consumed then abstains', async () => {
  const lens = await open(PACK, { skipAutoStart: ['prologue'] })
  lens.setNpcPlans({ [DEEPSEEK]: [{ kind: 'say', text: '测试台词' }] })
  const chances: boolean[] = []
  for (let i = 0; i < 6 && chances.length < 2; i++) {
    const trace = await lens.step({ kind: 'say', text: '大家好，DeepSeek 你在吗？' })
    expect(trace.error).toBeUndefined()
    if (trace.activated.includes(DEEPSEEK))
      chances.push(trace.lines.some(line => line.kind === 'speech' && line.text.includes('测试台词')))
  }
  expect(chances).toEqual([true, false])
}, 120_000)

it('does not touch the pack or data', async () => {
  const before = mtimes(PACK)
  const lens = await LensSimulation.open(PACK, kitchenStart('深夜'))
  const directories = readdirSync(tmpdir()).filter(name => name.startsWith('perspectra-lens-'))
  await lens.step({ kind: 'action', action: moveTo(await lens.state(), 'location:kitchen') })
  await lens.close()
  expect(mtimes(PACK)).toEqual(before)
  const after = readdirSync(tmpdir()).filter(name => name.startsWith('perspectra-lens-'))
  // The session's own temporary directory is gone; others may belong to concurrent tests.
  expect(directories.filter(name => !after.includes(name)).length).toBeGreaterThanOrEqual(1)
  expect(existsSync(join(PACK, '.perspectra-lens'))).toBe(false)
}, 60_000)

it('rejects unknown start references', async () => {
  await expect(LensSimulation.open(PACK, { scenes: { 'character:nobody': 'scene:kitchen' } })).rejects.toThrow(
    'character:nobody',
  )
  await expect(LensSimulation.open(PACK, { scenes: { [DEEPSEEK]: 'scene:nowhere' } })).rejects.toThrow('scene:nowhere')
  await expect(LensSimulation.open(PACK, { status: { public: { nokey: 1 } } })).rejects.toThrow('nokey')
  await expect(LensSimulation.open(PACK, { skipAutoStart: ['no-such-activity'] })).rejects.toThrow('no-such-activity')
}, 60_000)

it('step with a throwing autoStart reports the error in the trace', async () => {
  const pack = join(tempDir('lens-broken-'), 'pack')
  cpSync(PACK, pack, { recursive: true })
  const script = join(pack, 'scripts/activities/midnight-fridge.js')
  writeFileSync(
    script,
    readFileSync(script, 'utf8').replace(
      'autoStart(truth, world, previous) {',
      'autoStart(truth, world, previous) {\n    throw new TypeError("冰箱坏了")',
    ),
  )
  const lens = await LensSimulation.open(pack, kitchenStart('深夜'))
  const trace = await lens.step({ kind: 'action', action: moveTo(await lens.state(), 'location:kitchen') })
  const fridge = trace.autoStart.find(e => e.activityKey === 'midnight-fridge')
  // The runtime reports script failures without the author's message.
  expect(trace.error ?? fridge?.error).toBeTruthy()
  await lens.close()
}, 60_000)

it('matches a plain host runtime', async () => {
  const start = kitchenStart('深夜')
  const lens = await open(PACK, start)
  const lensTrace = await lens.step({ kind: 'action', action: moveTo(await lens.state(), 'location:kitchen') })
  expect(lensTrace.error).toBeUndefined()

  // The same start written by hand into a pack copy, played by an ordinary host runtime.
  const root = tempDir('lens-plain-'),
    pack = join(root, 'pack')
  cpSync(PACK, pack, { recursive: true })
  const scenesFile = join(pack, 'scenes.json')
  const scenes = JSON.parse(readFileSync(scenesFile, 'utf8')) as {
    scenes: { sceneId: string; participantIds: string[] }[]
  }
  for (const scene of scenes.scenes) {
    scene.participantIds =
      scene.sceneId === 'scene:kitchen' ? [DEEPSEEK] : scene.participantIds.filter(id => id !== DEEPSEEK)
  }
  writeFileSync(scenesFile, JSON.stringify(scenes))
  const charactersFile = join(pack, 'characters.json')
  const characters = JSON.parse(readFileSync(charactersFile, 'utf8')) as {
    characters: { characterId: string; initialLocationId?: string }[]
  }
  for (const character of characters.characters)
    if (character.characterId === DEEPSEEK) character.initialLocationId = 'location:kitchen'
  writeFileSync(charactersFile, JSON.stringify(characters))
  const prologue = join(pack, 'scripts/activities/prologue.js')
  writeFileSync(prologue, readFileSync(prologue, 'utf8') + '\nglobalThis.activityScript.autoStart = undefined\n')
  const stub = await startStubModel()
  cleanups.push(() => stub.close())
  const runtime = await WorldHostRuntime.create({
    packPath: pack,
    dataDirectory: join(root, 'data'),
    models: stub.models,
    memoryCore: false,
    timeoutMs: 10_000,
  })
  cleanups.push(() => runtime.close())
  await runtime.perform(moveTo(await runtime.state(), 'location:kitchen'))

  expect(await lens.statusTruth()).toEqual(runtime.creatorInspection({ limit: 1 }).statusTruth)
  const store = new WorldStore(join(runtime.dataDirectory, 'world.sqlite'))
  let plainKeys: unknown[]
  try {
    plainKeys = store
      .readEvents(runtime.address)
      .filter(e => e.eventType === 'activity.updated')
      .map(e => (e.data as WorldJsonObject).activityKey)
  } finally {
    store.close()
  }
  expect(plainKeys).toContain('midnight-fridge')
  const lensActivity = lensTrace.lines.filter(line => line.kind === 'activity')
  expect(lensActivity).toHaveLength(plainKeys.length)
  lensActivity.forEach((line, index) => expect(line.text).toContain(String(plainKeys[index])))
}, 120_000)
