import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { brandId, type ActivityState, type WorldJsonObject } from '@perspectra/sdk/contracts'
import { CharacterViewBuilder, WorldStore } from '@perspectra/core/store'
import type { WorldHostCore } from '../../apps/host/src/runtime/world-runtime.ts'
import { createRoleplayCore } from '../support/roleplay-runtime.ts'
import { startFakeProvider, fakeModels } from '../support/fake-provider.ts'

const PLAYER = 'character:player',
  HOST = 'character:gpt',
  THIRD = 'character:claude',
  OUTSIDER = 'character:deepseek'
const roots: string[] = [],
  runtimes: WorldHostCore[] = [],
  servers: Awaited<ReturnType<typeof startFakeProvider>>[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const runtime of runtimes.splice(0)) await runtime.close()
  for (const server of servers.splice(0)) await server.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function fresh() {
  const root = mkdtempSync(join(tmpdir(), 'activity-notes-'))
  roots.push(root)
  return root
}
/** The guessing game with three participants; `notes` is the privateNotes literal its guess returns, if any. */
function pack(notes?: string) {
  const path = join(fresh(), 'pack')
  cpSync(resolve('examples/world-packs/ai-girls-awaken-v10'), path, { recursive: true })
  const file = join(path, 'scripts/activity.js')
  let script = readFileSync(file, 'utf8')
    .replace("npcIds: ['character:gpt']", `npcIds: ['${HOST}', '${THIRD}']`)
    .replace('const answer = 1 + Math.floor(Math.random() * 100);', 'const answer = 73;')
    .replace('private: { [playerId]: {}, [npcId]: {} }', 'private: { [playerId]: {}, [npcId]: {}, [npcIds[1]]: {} }')
  if (notes !== undefined)
    script = script.replace(
      "return { game, description, audience: 'participants' };",
      "return operation === 'guess' ? { game, description, audience: 'participants', privateNotes: " +
        notes +
        " } : { game, description, audience: 'participants' };",
    )
  writeFileSync(file, script)
  return path
}
async function start(packPath: string) {
  const server = await startFakeProvider('openai', () => ({ tool: { decision: 'abstain' } }))
  servers.push(server)
  const dataDirectory = fresh()
  const runtime = await createRoleplayCore({
    dataDirectory,
    packPath,
    models: fakeModels(server.endpoint),
    serialScheduling: true,
  })
  runtimes.push(runtime)
  const read = <T>(use: (store: WorldStore) => T) => {
    const store = new WorldStore(join(dataDirectory, 'world.sqlite'))
    try {
      return use(store)
    } finally {
      store.close()
    }
  }
  const events = () => read(store => store.readEvents(runtime.address))
  const observations = (characterId: string) =>
    read(store =>
      new CharacterViewBuilder(store).rebuildAt(
        runtime.address,
        brandId(characterId, 'CharacterId'),
        store.head(runtime.address).headSeq,
      ),
    ).observations.map(o => o.value as WorldJsonObject)
  const state = () =>
    (events().findLast(event => event.eventType === 'activity.updated')!.data as WorldJsonObject).state as ActivityState
  const begin = () =>
    runtime.activityAction({ activityId: null, revision: 0, operation: 'start', parameters: {}, requestId: 'start' })
  const guess = () => {
    const current = state()
    return runtime.activityAction({
      activityId: current.id,
      revision: current.revision,
      operation: 'guess',
      parameters: { value: 50 },
      requestId: 'guess',
    })
  }
  return { events, observations, state, begin, guess }
}
const text = (values: readonly WorldJsonObject[]) => JSON.stringify(values)

it('a private note reaches only the named participants and is remembered by them', async () => {
  const f = await start(pack(`{ [actorId]: '你掷出 9', '${HOST}': '玩家掷出 9' }`))
  await f.begin()
  await f.guess()
  const own = f.observations(PLAYER),
    host = f.observations(HOST)
  expect(text(own)).toContain('你掷出 9')
  expect(text(own)).not.toContain('玩家掷出 9')
  expect(text(host)).toContain('玩家掷出 9')
  expect(text(host)).not.toContain('你掷出 9')
  for (const other of [THIRD, OUTSIDER]) expect(text(f.observations(other))).not.toContain('掷出')
  // The note is part of this round of the activity, like its outcome line.
  const content = (values: readonly WorldJsonObject[]) => values.map(o => (o.content ?? {}) as WorldJsonObject)
  const outcome = content(host).find(o => String(o.resultDescription).includes('第1次猜了50'))!
  const note = content(host).find(o => o.resultDescription === '玩家掷出 9')!
  expect(note.resultMetadata).toEqual(outcome.resultMetadata)
  expect(note.resultMetadata).toMatchObject({ activity: { id: f.state().id, revision: f.state().revision } })
  // Committed with the update: the notes sit in the same round, right after the activity's own events.
  const committed = f.events()
  const update = committed.findLastIndex(e => e.eventType === 'activity.updated')
  const notes = committed.filter(e => String((e.data as WorldJsonObject).id).includes(':note:'))
  expect(notes.map(e => (e.data as WorldJsonObject).id)).toEqual([
    expect.stringMatching(new RegExp(`:note:${PLAYER}$`)),
    expect.stringMatching(new RegExp(`:note:${HOST}$`)),
  ])
  expect(committed.indexOf(notes[0]!)).toBeGreaterThan(update)
})

it('a note for a non-participant is refused and nothing commits', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const f = await start(pack(`{ '${OUTSIDER}': '玩家掷出 9' }`))
  await f.begin()
  const started = f.events()
  await expect(f.guess()).rejects.toThrow(OUTSIDER)
  expect(f.events()).toEqual(started)
})

it('activities without privateNotes commit exactly as before', async () => {
  const plain = await start(pack())
  await plain.begin()
  await plain.guess()
  const noted = await start(pack(`{ '${HOST}': '玩家掷出 9' }`))
  await noted.begin()
  await noted.guess()
  // Only the note's own observation differs; every other committed event is unchanged.
  const shape = (events: readonly { eventType: string; data: unknown }[]) =>
    JSON.parse(
      JSON.stringify(events.map(e => ({ eventType: e.eventType, data: e.data })))
        .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, 'uuid')
        .replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, 'time')
        // The two packs differ in their script, so pack-derived hashes differ too.
        .replace(/[0-9a-f]{16,}/g, 'hash'),
    )
  const withoutNote = noted.events().filter(e => !String((e.data as WorldJsonObject).id).includes(':note:'))
  expect(noted.events().length).toBe(plain.events().length + 1)
  expect(shape(withoutNote)).toEqual(shape(plain.events()))
})
