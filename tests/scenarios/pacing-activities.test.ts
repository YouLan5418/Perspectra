import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { WorldJsonObject } from '@harness-world/contracts'
import { WorldStore } from '@harness-world/store-sqlite'
import { fakeModels, startFakeProvider } from '../support/fake-provider.ts'
import { createRoleplayCore } from '../support/roleplay-runtime.ts'

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
const obj = (value: unknown) => value as WorldJsonObject
const definition = (activities: object, chance = 1) => ({
  cycleRounds: 16,
  chance,
  cooldownRounds: { low: 2, medium: 2, high: 8 },
  recoveryRounds: 0,
  activities,
})

/** Two always-ready activities; rounds replay fixed draws, so choices are exact. */
async function world(pacing: object | undefined) {
  const root = mkdtempSync(join(tmpdir(), 'pacing-activities-'))
  cleanups.push(() => rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }))
  const packPath = join(root, 'pack')
  cpSync(resolve('examples/world-packs/cross-scene-activity'), packPath, { recursive: true })
  const guess = join(packPath, 'scripts/activities/guess.js')
  const source = readFileSync(guess, 'utf8') + `\nactivityScript.autoStart = () => ({ when: [['总是', true]] })\n`
  writeFileSync(guess, source)
  writeFileSync(join(packPath, 'scripts/activities/dice.js'), source)
  const file = join(packPath, 'worldpack.source.json'),
    manifest = JSON.parse(readFileSync(file, 'utf8'))
  manifest.assetFiles.push('scripts/activities/dice.js')
  if (pacing) {
    writeFileSync(
      join(packPath, 'scripts/pacing.js'),
      `globalThis.pacingScript = { definition: ${JSON.stringify(pacing)}, beats: {} }`,
    )
    manifest.assetFiles.push('scripts/pacing.js')
  }
  writeFileSync(file, JSON.stringify(manifest))
  const requests: string[] = []
  const server = await startFakeProvider('openai', call => {
    requests.push(call.userText)
    return { tool: { decision: 'abstain' } }
  })
  cleanups.push(() => server.close())
  const runtime = await createRoleplayCore({
    packPath,
    dataDirectory: join(root, 'data'),
    models: fakeModels(server.endpoint),
    timeoutMs: 5000,
  })
  cleanups.push(() => runtime.close())
  const store = new WorldStore(join(root, 'data', 'world.sqlite'))
  cleanups.push(() => store.close())
  const starts = () =>
    store
      .readEvents(runtime.address)
      .filter(event => event.eventType === 'activity.updated' && obj(event.data).operation === 'start')
      .map(event => obj(event.data).activityKey)
  const round = async (draws: number[], text = '你好。') => {
    runtime.beginRoundRandom(draws)
    await runtime.submit(text)
  }
  const reason = () => obj(runtime.creatorInspection().pacing).reason as WorldJsonObject | undefined
  return { runtime, starts, round, reason, requests }
}

it('starts one of two ready events, by the recorded draw', async () => {
  const f = await world(definition({ guess: { intensity: 'low' }, dice: { intensity: 'low' } }))
  await f.round([0, 0.99])
  expect(f.starts()).toHaveLength(1)
  expect(f.reason()).toMatchObject({ why: 'chosen' })
})

it('waits out the cooldown, and starts nothing and records nothing meanwhile', async () => {
  const f = await world(definition({ guess: { intensity: 'high' }, dice: { intensity: 'high' } }))
  await f.round([0, 0])
  await f.runtime.escape()
  await f.round([])
  expect(f.starts()).toHaveLength(1)
  expect(f.reason()).toMatchObject({ why: 'cooling' })
})

it('leaves an activity it does not manage to the existing rule, first and outside the cooldown', async () => {
  const f = await world(definition({ guess: { intensity: 'high' } }))
  await f.round([])
  expect(f.starts()).toEqual(['dice'])
  await f.runtime.escape()
  await f.round([])
  expect(f.starts()).toEqual(['dice', 'dice'])
})

it('never blocks a manual start', async () => {
  const f = await world(definition({ guess: { intensity: 'high' }, dice: { intensity: 'high' } }))
  await f.round([0, 0])
  const started = String(f.starts()[0])
  await f.runtime.escape()
  await f.runtime.activityAction({
    activityKey: started === 'guess' ? 'dice' : 'guess',
    activityId: null,
    revision: 0,
    operation: 'start',
    parameters: {},
    requestId: 'manual',
  })
  expect(f.starts()).toHaveLength(2)
})

it('does not intervene when the draw says no, and the round still ends normally', async () => {
  const f = await world(definition({ guess: { intensity: 'low' }, dice: { intensity: 'low' } }, 0))
  await f.round([0])
  expect(f.starts()).toEqual([])
  expect(f.reason()).toMatchObject({ why: 'not-this-round' })
  expect(obj(obj(await f.runtime.state()).debug).autoStartError).toBeUndefined()
})

it('does not evaluate while an activity runs or after escaping within the same round', async () => {
  const f = await world(definition({ guess: { intensity: 'low' }, dice: { intensity: 'low' } }))
  await f.round([0, 0])
  const before = f.runtime.creatorInspection().pacing
  await f.round([])
  expect(f.starts()).toHaveLength(1)
  expect(f.runtime.creatorInspection().pacing).toEqual(before)
})

it('behaves as before with no pacing script', async () => {
  const f = await world(undefined)
  await f.round([0])
  expect(f.starts()).toHaveLength(1)
  expect(f.runtime.creatorInspection().pacing).toBeNull()
})

it('shows the creator why, and nobody else', async () => {
  const f = await world(definition({ guess: { intensity: 'high' }, dice: { intensity: 'high' } }))
  await f.round([0, 0])
  await f.runtime.escape()
  await f.round([])
  expect(f.reason()).toMatchObject({ why: 'cooling' })
  expect(JSON.stringify(await f.runtime.state())).not.toContain('cooling')
  expect(f.requests.join('')).not.toContain('cooling')
  expect(f.requests.join('')).not.toContain('tension')
})
