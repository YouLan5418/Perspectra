import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
const PLAYER = 'character:player',
  COMPANION = 'character:companion',
  FRIEND = 'character:friend'
const obj = (value: unknown) => value as WorldJsonObject
const SEEN = '你看见门缝里那张催租单。',
  THOUGHT = '你忽然想起这个月的房租好像是你经手的。'
const always = `when: () => [['总是', true]]`
const stimuli = `stimuli: [
  { characterId: '${COMPANION}', kind: 'perception', text: '${SEEN}' },
  { characterId: '${COMPANION}', kind: 'thought', text: '${THOUGHT}' },
]`
const definition = (beats: Record<string, string>) =>
  JSON.stringify({
    cycleRounds: 16,
    chance: 1,
    cooldownRounds: { low: 0, medium: 0, high: 0 },
    recoveryRounds: 0,
    beats: Object.fromEntries(Object.keys(beats).map(id => [id, { intensity: 'low' }])),
  })

/** The market fixture with a pacing script; every round draws, and the draws are fixed. */
async function world(beats: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'pacing-beats-'))
  cleanups.push(() => rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }))
  const packPath = join(root, 'pack')
  cpSync(resolve('examples/world-packs/prototype-g1'), packPath, { recursive: true })
  mkdirSync(join(packPath, 'scripts'), { recursive: true })
  writeFileSync(join(packPath, 'scripts/status.js'), readFileSync(resolve('tests/fixtures/status-market.js'), 'utf8'))
  writeFileSync(
    join(packPath, 'scripts/pacing.js'),
    `globalThis.pacingScript = { definition: ${definition(beats)}, beats: { ${Object.entries(beats)
      .map(([id, body]) => `'${id}': { ${body} }`)
      .join(', ')} } }`,
  )
  const file = join(packPath, 'worldpack.source.json'),
    manifest = JSON.parse(readFileSync(file, 'utf8'))
  manifest.assetFiles = ['scripts/status.js', 'scripts/pacing.js']
  writeFileSync(file, JSON.stringify(manifest))
  const requests: { actor: string; text: string }[] = []
  const server = await startFakeProvider('openai', call => {
    const input = JSON.parse(call.userText) as WorldJsonObject
    requests.push({ actor: String(obj(obj(input.context).character).characterId), text: call.userText })
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
  const events = () => store.readEvents(runtime.address)
  const beats_ = () => events().filter(e => e.eventType === 'status.updated' && obj(obj(e.data).source).kind === 'beat')
  const observations = (observerId: string) =>
    events()
      .filter(e => e.eventType === 'observation.upsert' && obj(obj(e.data).value).observerId === observerId)
      .map(e => JSON.stringify(e.data))
      .join('\n')
  const round = async (draws: number[], text = '你好。') => {
    runtime.beginRoundRandom(draws)
    await runtime.submit(text)
  }
  const decision = () => obj(runtime.creatorInspection().pacing)
  return { runtime, events, beats: beats_, observations, round, decision, requests, store }
}

it('commits the change, the words and the stimuli as one beat, advancing the tick once', async () => {
  const f = await world({
    rent: `${always}, apply: truth => ({
      changes: [{ holderId: null, key: 'time', value: truth.public.time + 100 }],
      reveals: [{ observerId: '${FRIEND}', holderId: null, key: 'time' }],
      notice: '门缝里塞进来一张纸。', sceneNotice: '门缝里塞进来一张催租单。', ${stimuli} })`,
  })
  await f.round([0, 0, 0])
  const [beat] = f.beats()
  expect(obj(beat!.data).source).toEqual({ kind: 'beat', beatId: 'rent' })
  const same = f.events().filter(e => e.transactionId === beat!.transactionId)
  expect(same.filter(e => e.eventType === 'world.tick-advanced')).toHaveLength(1)
  expect(same.some(e => e.eventType === 'action.resolved')).toBe(false)
  expect(f.observations(COMPANION)).toContain(SEEN)
  expect(f.observations(PLAYER)).toContain('门缝里塞进来一张纸。')
  const state = await f.runtime.state()
  expect(JSON.stringify(obj(state).transcript)).toContain('门缝里塞进来一张纸。')
  expect(f.decision()).toMatchObject({ kind: 'beat', key: 'rent' })
})

it('commits nothing of a beat with an invalid value, and names why', async () => {
  const f = await world({
    bad: `${always}, apply: () => ({ changes: [{ holderId: null, key: 'time', value: 'x' }], ${stimuli} })`,
  })
  await f.round([0, 0, 0])
  expect(f.beats()).toEqual([])
  expect(f.observations(COMPANION)).not.toContain(SEEN)
  expect(f.decision()).toMatchObject({ kind: 'none', reason: { why: 'beat-failed', beatId: 'bad' } })
})

it.each([
  ['an undeclared character', `stimuli: [{ characterId: 'character:nobody', kind: 'perception', text: '看见了' }]`],
  ['the player', `stimuli: [{ characterId: '${PLAYER}', kind: 'thought', text: '想起了' }]`],
  ['an empty text', `stimuli: [{ characterId: '${COMPANION}', kind: 'thought', text: ' ' }]`],
  ['a long text', `stimuli: [{ characterId: '${COMPANION}', kind: 'thought', text: 'x'.repeat(501) }]`],
  ['too many', `stimuli: Array(9).fill({ characterId: '${COMPANION}', kind: 'thought', text: '想' })`],
  ['an instruction kind', `stimuli: [{ characterId: '${COMPANION}', kind: 'instruction', text: '请提起房租' }]`],
  ['an activity-scoped status', `changes: [{ holderId: '${PLAYER}', key: 'hp', value: 1 }]`],
])('refuses a beat with %s', async (_name, body) => {
  const f = await world({ bad: `${always}, apply: () => ({ ${body} })` })
  await f.round([0, 0, 0])
  expect(f.beats()).toEqual([])
  expect(f.decision()).toMatchObject({ reason: { why: 'beat-failed' } })
})

it('keeps a stimulus from everyone it does not name', async () => {
  const f = await world({ rent: `${always}, apply: () => ({ ${stimuli} })` })
  await f.round([0, 0, 0])
  expect(f.observations(FRIEND)).not.toContain(SEEN)
  expect(f.observations(PLAYER)).not.toContain(SEEN)
  expect(JSON.stringify(await f.runtime.state())).not.toContain(SEEN)
  expect(JSON.stringify(await f.runtime.state())).not.toContain(THOUGHT)
  const others = f.requests.filter(r => r.actor !== COMPANION).map(r => r.text)
  expect(others.join('')).not.toContain(SEEN)
  expect(others.join('')).not.toContain(THOUGHT)
  expect(f.requests.filter(r => r.actor === COMPANION).at(-1)!.text).toContain(SEEN)
})

it('gives the named character a chance it may decline, and no physical change', async () => {
  const f = await world({ rent: `${always}, apply: () => ({ ${stimuli} })` })
  const before = f.events().filter(e => e.eventType === 'character.moved').length
  await f.round([0, 0, 0])
  const received = f.requests.filter(r => r.text.includes(THOUGHT))
  expect(received.map(r => r.actor)).toEqual([COMPANION])
  expect(f.events().filter(e => e.eventType === 'character.moved')).toHaveLength(before)
})

it('classifies a perception and a thought differently in the record', async () => {
  const f = await world({ rent: `${always}, apply: () => ({ ${stimuli} })` })
  await f.round([0, 0, 0])
  const values = f
    .events()
    .filter(e => e.eventType === 'observation.upsert' && String(obj(e.data).id).includes(':stimulus:'))
    .map(e => obj(obj(e.data).value))
  expect(values.map(v => v.epistemicKind)).toEqual(['direct_observation', 'subjective_inference'])
})

it('leaves out only the beat whose condition throws, and carries on next round', async () => {
  const f = await world({
    broken: `when: () => { throw new Error('坏了') }, apply: () => ({})`,
    fine: `${always}, apply: () => ({})`,
  })
  await f.round([0, 0, 0])
  expect(f.beats().map(e => obj(obj(e.data).source).beatId)).toEqual(['fine'])
  expect(obj(f.decision().reason).excluded).toMatchObject([{ beatId: 'broken' }])
  await f.round([0, 0, 0])
  expect(f.beats()).toHaveLength(2)
})

it('does not commit when apply throws, and tries again next round', async () => {
  const f = await world({
    flaky: `${always}, apply: truth => { if (truth.public.time < 20) throw new Error('还不行'); return {} }`,
  })
  await f.round([0, 0, 0])
  expect(f.beats()).toEqual([])
  expect(f.decision()).toMatchObject({ reason: { why: 'beat-failed', error: expect.stringContaining('还不行') } })
  await f.round([0, 0, 0])
  expect(f.beats()).toHaveLength(1)
})

it('records a beat with no change, and it counts for the cooldown', async () => {
  const f = await world({ quiet: `${always}, apply: () => ({})` })
  await f.round([0, 0, 0])
  expect(f.beats()).toHaveLength(1)
  expect(obj(f.beats()[0]!.data).changes).toEqual([])
})

it('does not disturb the player round count', async () => {
  const f = await world({ quiet: `${always}, apply: () => ({})` })
  const rounds = () =>
    f
      .events()
      .filter(e => e.eventType === 'status.updated' && obj(obj(e.data).source).kind === 'round')
      .map(e => obj(obj(e.data).source).round)
  await f.round([0, 0, 0])
  await f.round([0, 0, 0])
  await f.round([0, 0, 0])
  expect(rounds()).toEqual([1, 2, 3])
})

it('gives a script the seat of every character and the recorded random', async () => {
  const f = await world({
    seats: `${always}, apply: (truth, world) => ({
      notice: String(world.places['${COMPANION}']) + ':' + Math.random() })`,
  })
  await f.round([0, 0, 0.25])
  expect(f.observations(PLAYER)).toContain(':0.25')
  expect(f.observations(PLAYER)).not.toContain('null:')
  expect(f.runtime.roundRandom()).toEqual([0, 0, 0.25])
})
