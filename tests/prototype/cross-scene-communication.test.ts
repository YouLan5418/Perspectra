import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it, vi } from 'vitest'
import { brandId, resolutionAuthority, type WorldJsonObject } from '@harness-world/contracts'
import { currentLocation } from '@harness-world/kernel'
import { crossSceneRuntime } from '../experiments/cross-scene-runtime.ts'
import { PlaytestMemoryCore } from '../experiments/playtest-memory-core.ts'
import { localPrototypeTurnCall } from '../experiments/local-prototype-turn-call.ts'

const directories: string[] = [], runtimes: Awaited<ReturnType<typeof crossSceneRuntime>>[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const r of runtimes.splice(0)) await r.close(); for (const d of directories.splice(0)) rmSync(d, { recursive: true, force: true }) })
async function fixture(decide: Parameters<typeof crossSceneRuntime>[1] = async () => ({ decision: 'abstain' })) {
  const directory = mkdtempSync(join(tmpdir(), 'sms-experiment-')); directories.push(directory)
  const runtime = await crossSceneRuntime(directory, decide); runtimes.push(runtime); return { runtime, directory }
}
const companion = 'character:companion', friend = 'character:friend', player = 'character:player'

it('renders free message arguments without requiring unrelated activity fields', async () => {
  const { runtime: r } = await fixture()
  const call = localPrototypeTurnCall({ continuation: false, canPerform: true, context: {
    character: { characterId: companion }, scene: { people: [] }, affordances: [{ actionType: 'interact', interactions: [{
      ...r.communication.parameters(player, ''), argumentSchema: { type: 'object', additionalProperties: false,
        required: ['text'], properties: { text: { type: 'string', minLength: 1, maxLength: 2000 } } },
    }] }],
  } })
  const args = (((call.schema.properties as WorldJsonObject).parameters as WorldJsonObject).properties as WorldJsonObject).arguments as WorldJsonObject
  expect(args.required).toEqual(['text'])
  expect(JSON.stringify(args)).not.toContain('activityId')
})

it('delivers a private remote message, permits remote reply and triggers only observable local chains', async () => {
  const visits: string[] = [], contexts: WorldJsonObject[] = []
  let replied = false
  const { runtime: r, directory } = await fixture(async request => {
    contexts.push(request.context)
    const id = String((request.context.character as WorldJsonObject).characterId); visits.push(id)
    if (id === companion && !request.continuation && !replied) {
      replied = true
      return { decision: 'perform', actionType: 'interact', parameters: r.communication.parameters(player, '收到，我稍后过来。') }
    }
    if (id === companion && request.continuation) return { decision: 'publish', segments: [{ type: 'speech', text: '他叫我去前室，你先留在这里。' }] }
    return { decision: 'abstain' }
  })
  const result = await r.send('暗号是蓝色纸鹤，请稍后来前室。')
  expect(result.sent.status).toBe('accepted'); expect(result.cycle.terminalReason).toBe('quiescent')
  expect(visits).toContain(friend)
  const remote = contexts.find(c => (c.character as WorldJsonObject).characterId === companion)!
  expect((remote.scene as WorldJsonObject).people).not.toContainEqual(expect.objectContaining({ characterId: player }))
  expect(JSON.stringify(remote.stimulus)).toContain('蓝色纸鹤')
  expect(JSON.stringify(r.view(friend).observations)).not.toContain('蓝色纸鹤')
  expect(JSON.stringify(r.view(friend).observations)).not.toContain('收到，我稍后过来')
  expect(JSON.stringify(r.view(friend).observations)).toContain('你先留在这里')
  expect(result.transcript.some(line => line.speaker.includes('短信') && line.text.includes('收到'))).toBe(true)
  expect(result.transcript.some(line => line.text.includes('你先留在这里'))).toBe(false)
  expect(currentLocation(r.store.readEvents(r.address), companion)).toBe('location:back-room')
  const db = new DatabaseSync(join(directory, 'memory.sqlite'))
  try { const rows = db.prepare('SELECT text_value,epistemic_kind FROM cognitive_memory_v2_sources').all()
    expect(rows.some(row => String(row.text_value).includes('via 短信') && String(row.text_value).includes('蓝色纸鹤') && row.epistemic_kind === 'reported_speech')).toBe(true)
  } finally { db.close() }
})

it('silent receipt does not wake bystanders, and ordinary remote publish stays prohibited', async () => {
  const visits: string[] = []
  const { runtime: r } = await fixture(async request => { visits.push(String((request.context.character as WorldJsonObject).characterId)); return { decision: 'abstain' } })
  await r.send('只告诉你：蓝色纸鹤。')
  expect(visits).toEqual([companion]); expect(r.view(friend).observations.some(o => JSON.stringify(o).includes('蓝色纸鹤'))).toBe(false)
  const forbidden = await fixture(async () => ({ decision: 'publish', scope: 'direct', addresseeIds: [player], segments: [{ type: 'speech', text: '非法远程对白' }] }))
  const failed = await forbidden.runtime.send('请回复')
  expect(failed.cycle.terminalReason).toBe('failed'); expect(JSON.stringify(forbidden.runtime.view(player).observations)).not.toContain('非法远程对白')
})

it('guessed contacts are rejected and contact authorization does not grant physical interaction', async () => {
  const { runtime: r } = await fixture()
  const rejected = await r.send('不应收到', friend)
  expect(rejected.sent.status).toBe('rejected'); expect(rejected.cycle.activations).toHaveLength(0)
  expect(JSON.stringify(r.view(friend).observations)).not.toContain('不应收到')
  const resolution = r.communication.resolve({ manifest: r.manifest, events: r.store.readEvents(r.address), characterId: player,
    actionId: 'test:physical', roundId: brandId('test:physical', 'InteractionRoundId'),
    action: { actionType: 'interact', parameters: { targetRef: { kind: 'character', id: companion }, bindingId: 'binding:companion-hold',
      definitionRef: { id: 'base:hold-hand', version: 1 }, arguments: {} } },
    manifestHash: r.store.readManifest(r.address)!.manifestHash, asOfWorldSeq: r.store.head(r.address).headSeq,
    resolutionAuthority: resolutionAuthority('player', 'manual_player_immediate') })
  expect(resolution.status).toBe('rejected')
})

it('rolls back message and receiving observation together on a commit failure', async () => {
  const { runtime: r, directory } = await fixture(), before = r.store.head(r.address).headSeq
  const db = new DatabaseSync(join(directory, 'world.sqlite'))
  try {
    db.exec("CREATE TRIGGER fail_sms BEFORE INSERT ON events WHEN NEW.event_type='observation.upsert' BEGIN SELECT RAISE(ABORT, 'commit failed'); END")
    await expect(r.send('不能部分送达')).rejects.toThrow('commit failed')
  } finally { db.exec('DROP TRIGGER fail_sms'); db.close() }
  expect(r.store.head(r.address).headSeq).toBe(before); expect(JSON.stringify(r.view(companion).observations)).not.toContain('不能部分送达')
  expect((await r.send('重试发送')).sent.status).toBe('accepted')
})

it('reopening preserves authorized messages and does not replay unfinished reactions', async () => {
  const { runtime: r, directory } = await fixture(); await r.send('重启后仍然是短信')
  await r.close(); runtimes.splice(runtimes.indexOf(r), 1)
  const reopened = await crossSceneRuntime(directory, async () => { throw new Error('must not auto activate') }); runtimes.push(reopened)
  expect(JSON.stringify(reopened.view(companion).observations)).toContain('重启后仍然是短信')
  expect(JSON.stringify(reopened.view(friend).observations)).not.toContain('重启后仍然是短信')
  expect(reopened.view(brandId(player, 'CharacterId')).locationId).toBe('location:front-room')
})

it('Core query sources preserve the medium and exclude unaddressed scene bystanders', async () => {
  const { runtime: r, directory } = await fixture(); await r.send('秘密暗号：蓝色纸鹤')
  const inputs: WorldJsonObject[] = []
  const run = async (input: WorldJsonObject): Promise<WorldJsonObject> => {
    inputs.push(input); return input.operation === 'build'
      ? { archive: { scope: input.scope!, sources: input.sources!, facts: [], episodes: [], observations: [] }, index: { scope: input.scope!, units: [], vectors: [] } }
      : { delivery: [], deliveryTrace: { delivered: [], activityCoverage: [] } }
  }
  const core = new PlaytestMemoryCore(directory, r.address, run, undefined, { run })
  try {
    for (const id of [companion, friend]) r.memory.catchUp(r.address, brandId(id, 'CharacterId'), r.store.head(r.address).headSeq, 'sms-core')
    await core.refresh([companion, friend], new AbortController().signal, () => {})
    for (const id of [companion, friend]) {
      await core.project({ context: { character: { characterId: id, name: id }, scene: { people: [] }, observations: [] }, continuation: false }, new AbortController().signal)
    }
    const addressed = inputs.find(i => i.operation === 'build' && (i.scope as WorldJsonObject).characterId === companion)!
    const bystander = inputs.find(i => i.operation === 'build' && (i.scope as WorldJsonObject).characterId === friend)!
    expect(JSON.stringify(addressed.sources)).toContain('via 短信')
    expect(JSON.stringify(addressed.sources)).toContain('蓝色纸鹤')
    expect(JSON.stringify(bystander.sources)).not.toContain('蓝色纸鹤')
  } finally { await core.close() }
})
