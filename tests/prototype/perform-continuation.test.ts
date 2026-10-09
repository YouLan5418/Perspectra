import Ajv from 'ajv'
import { localPrototypeTurnCall } from '../experiments/local-prototype-turn-call.ts'
import { DatabaseSync } from 'node:sqlite'
import { CognitiveMemoryService } from '@harness-world/memory'
import { CharacterViewBuilder } from '@harness-world/store-sqlite'
import { publicationSourceText, checkExpressionPolicy, parseExpressionSegments, RECALL_KEYWORD_TOKENIZER_ID, type ExpressionSegment } from '@harness-world/contracts'
import { DeterministicPresenter } from '@harness-world/presentation'
import { playerTranscript } from '../experiments/playtest-view.ts'
import { projectPlayerView } from '../../packages/frontend/src/player-view.ts'
import type { PlaytestState } from '../experiments/playtest-server.ts'
import { PlaytestMemoryCore } from '../experiments/playtest-memory-core.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { brandId, hashWorldJson, type WorldEventDraft, type WorldJsonObject } from '@harness-world/contracts'
import { createCoreRulebookRegistry, currentEntityState, currentLocation } from '@harness-world/kernel'
import { CharacterRuntimeAvailabilityService, WorldStore, WriterLeaseService } from '@harness-world/store-sqlite'
import { prototypeTurnCall } from '@harness-world/provider-chat'
import { PrototypeCharacterTurn, type PrototypeTurnRequest } from '../../packages/application/src/prototype-character-turn.ts'
import { frozenInteractionWorld, basicInteractionPackage } from '../fixtures/frozen-interaction-world.ts'

const cleanup: (() => void)[] = []
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close() })
const npc = brandId('character:npc', 'CharacterId')
const take = { decision: 'perform', actionType: 'interact', parameters: {
  targetRef: { kind: 'entity', id: 'entity:cup' }, bindingId: 'binding:entity:cup:base:take',
  definitionRef: { id: 'base:take', version: 1 }, arguments: {},
} }

function fixture(decide: (request: PrototypeTurnRequest, signal: AbortSignal) => Promise<unknown>, extra: WorldEventDraft[] = [], limits: {publicationCharacters?:number;activationTimeoutMs?:number} = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'perform-prototype-'))
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }))
  const path = join(directory, 'world.sqlite')
  const store = new WorldStore(path)
  const leases = new WriterLeaseService(path)
  const availability = new CharacterRuntimeAvailabilityService(path)
  cleanup.push(() => { availability.close(); leases.close(); store.close() })
  const world = frozenInteractionWorld()
  const address = world.manifest.address
  const genesisEvents = [...world.genesisEvents, ...extra]
  store.activateBranch({ ...world, genesisEvents, genesisHash: hashWorldJson('world-genesis-plan', genesisEvents),
    address, transactionId: brandId('transaction:genesis', 'TransactionId'),
    roundId: brandId('round:genesis', 'InteractionRoundId'), correlationId: 'test' })
  const turn = new PrototypeCharacterTurn({ ...limits, address, store, leases, availability,
    rulebooks: createCoreRulebookRegistry({ interactionPackages: [basicInteractionPackage] }), decide })
  return { turn, store, address, directory }
}

it('commits perform before continuation, then publishes the result-aware expression', async () => {
  let calls = 0
  const f = fixture(async request => {
    if (++calls === 1) return take
    expect(request.result?.status).toBe('accepted')
    expect(currentEntityState(f.store.readEvents(f.address), 'entity:cup')?.holderId).toBe(npc)
    expect(f.store.readEvents(f.address).filter(event => event.eventType === 'character.speak')).toHaveLength(0)
    expect(JSON.stringify(prototypeTurnCall(request).schema)).not.toContain('"const":"perform"')
    return { decision: 'publish', segments: [{ type: 'narration', text: '低头看了看手里的杯子。' }, { type: 'speech', text: '拿到了。' }] }
  })
  expect(await f.turn.run(npc)).toMatchObject({ status: 'published', calls: 2, performResult: { status: 'accepted' } })
  const events = f.store.readEvents(f.address)
  expect(events.filter(event => event.eventType === 'entity.transferred')).toHaveLength(1)
  expect(events.find(event => event.eventType === 'entity.transferred')!.seq)
    .toBeLessThan(events.find(event => event.eventType === 'character.speak')!.seq)
})

it('can execute a second bounded operation after seeing the first result, then publish after the second', async () => {
  let calls = 0
  const drop = { decision: 'perform', actionType: 'interact', parameters: {
    targetRef: { kind: 'entity', id: 'entity:cup' }, bindingId: 'binding:entity:cup:base:drop',
    definitionRef: { id: 'base:drop', version: 1 }, arguments: {},
  } }
  const f = fixture(async request => {
    calls++
    if (calls === 1) { expect(request.canPerform).toBe(true); return take }
    if (calls === 2) {
      expect(request.result?.status).toBe('accepted')
      expect(request.canPerform).toBe(true)
      expect(JSON.stringify(prototypeTurnCall(request).schema)).toContain('"const":"perform"')
      expect(currentEntityState(f.store.readEvents(f.address), 'entity:cup')?.holderId).toBe(npc)
      return drop
    }
    expect(request.result?.status).toBe('accepted')
    expect(request.canPerform).toBe(false)
    expect(JSON.stringify(prototypeTurnCall(request).schema)).not.toContain('"const":"perform"')
    expect(currentEntityState(f.store.readEvents(f.address), 'entity:cup')?.holderId).toBeNull()
    return { decision: 'publish', segments: [{ type: 'speech', text: '拿起来看了看，又放回原处。' }] }
  })
  expect(await f.turn.run(npc, { maxCalls: 3 })).toMatchObject({ status: 'published', calls: 3,
    performResult: { status: 'accepted', action: { parameters: { definitionRef: { id: 'base:drop' } } } } })
  const events = f.store.readEvents(f.address)
  const transfers = events.filter(event => event.eventType === 'entity.transferred')
  expect(transfers).toHaveLength(2)
  expect(transfers[1]!.seq).toBeLessThan(events.find(event => event.eventType === 'character.speak')!.seq)
})

it('returns a real rejection before the character reacts, without changing possession', async () => {
  let calls = 0
  const f = fixture(async request => {
    if (++calls === 1) return { ...take, parameters: { ...take.parameters,
      definitionRef: { id: 'base:give', version: 1 }, bindingId: 'binding:entity:cup:base:give',
      arguments: { recipientId: 'character:player' } } }
    expect(request.result?.status).toBe('rejected')
    expect(currentEntityState(f.store.readEvents(f.address), 'entity:cup')?.holderId).toBeNull()
    return { decision: 'publish', segments: [{ type: 'speech', text: '我还没拿到它呢。' }] }
  })
  expect(await f.turn.run(npc)).toMatchObject({ status: 'published', performResult: { status: 'rejected' } })
  expect(f.store.readEvents(f.address).some(event => event.eventType === 'entity.transferred')).toBe(false)
})

it('rechecks a stale item proposal against the latest possession before execution', async () => {
  let calls = 0
  const f = fixture(async request => {
    calls++
    if (request.continuation) return { decision: 'abstain' }
    return take
  })
  expect(await f.turn.run(npc)).toMatchObject({ status: 'abstained', performResult: { status: 'accepted' } })
  expect(await f.turn.run(npc)).toMatchObject({ status: 'abstained', performResult: { status: 'rejected' } })
  expect(calls).toBe(4)
  const events = f.store.readEvents(f.address)
  expect(events.filter(event => event.eventType === 'entity.transferred')).toHaveLength(1)
  expect(currentEntityState(events, 'entity:cup')?.holderId).toBe(npc)
})

it.each(['throw', 'second-operation', 'mixed-draft', 'abstain', 'cancel'] as const)(
  'keeps the committed operation when continuation is %s', async mode => {
    const controller = new AbortController()
    let calls = 0
    const f = fixture(async () => {
      if (++calls === 1) return take
      if (mode === 'throw') throw new Error('provider unavailable')
      if (mode === 'cancel') { controller.abort(); return { decision: 'publish', segments: [{ type: 'speech', text: 'late' }] } }
      if (mode === 'second-operation') return take
      if (mode === 'mixed-draft') return { decision: 'publish', parameters: take.parameters, segments: [{ type: 'speech', text: 'done' }] }
      return { decision: 'abstain' }
    })
    const result = await f.turn.run(npc, { signal: controller.signal })
    expect(result.status).toBe(mode === 'abstain' ? 'abstained' : mode === 'cancel' ? 'interrupted' : 'failed')
    const events = f.store.readEvents(f.address)
    expect(currentEntityState(events, 'entity:cup')?.holderId).toBe(npc)
    expect(events.filter(event => event.eventType === 'entity.transferred')).toHaveLength(1)
    expect(events.some(event => event.eventType === 'character.speak')).toBe(false)
  })

it('does not dispatch a continuation beyond the call budget', async () => {
  const f = fixture(async () => take)
  expect(await f.turn.run(npc, { maxCalls: 1 })).toMatchObject({ status: 'budget_exhausted', calls: 1,
    performResult: { status: 'accepted' } })
})

it('discards an unexecuted operation together with its prewritten success narrative', async () => {
  const f = fixture(async () => ({ ...take, narration: '已经把杯子拿稳了。' }))
  expect(await f.turn.run(npc)).toMatchObject({ status: 'failed', calls: 1 })
  expect(currentEntityState(f.store.readEvents(f.address), 'entity:cup')?.holderId).toBeNull()
})

it('does not accept a legacy performance payload inside perform parameters', async () => {
  const f = fixture(async () => ({ ...take, parameters: { ...take.parameters,
    performance: { independent: ['smile'], onSuccess: [] } } }))
  const before = f.store.head(f.address).headSeq
  expect(await f.turn.run(npc)).toMatchObject({ status: 'failed' })
  expect(f.store.head(f.address).headSeq).toBe(before)
})

it('refreshes character and scene locations after moving, including the next activation, and uses only the new audience', async () => {
  let calls = 0
  const requests: PrototypeTurnRequest[] = []
  const f = fixture(async request => {
    requests.push(request)
    if (++calls === 1) return { decision: 'perform', actionType: 'move', parameters: { locationId: 'location:next' } }
    expect(currentLocation(f.store.readEvents(f.address), npc)).toBe('location:next')
    expect((request.context.scene as WorldJsonObject).locationId).toBe('location:next')
    const publish = (prototypeTurnCall(request).schema.oneOf as WorldJsonObject[]).find(value =>
      ((value.properties as WorldJsonObject).decision as WorldJsonObject).const === 'publish')!
    expect(publish.properties).not.toHaveProperty('addresseeIds')
    expect(((publish.properties as WorldJsonObject).scope as WorldJsonObject).enum).toEqual(['scene_public', 'self'])
    return { decision: 'publish', segments: [{ type: 'narration', text: '环顾四周。' }] }
  })
  expect(await f.turn.run(npc)).toMatchObject({ status: 'published', calls: 2 })
  expect(await f.turn.run(npc)).toMatchObject({ status: 'published', calls: 1 })
  expect(requests.map(request => (request.context.character as WorldJsonObject).locationId))
    .toEqual(['location:room', 'location:next', 'location:next'])
  expect(requests.map(request => (request.context.scene as WorldJsonObject).locationId))
    .toEqual(['location:room', 'location:next', 'location:next'])
  const observations = f.store.readEvents(f.address).filter(event => event.eventType === 'observation.upsert')
  const expressions = observations.map(event => (event.data as WorldJsonObject).value as WorldJsonObject)
    .filter(value => (value.content as WorldJsonObject).actionType === 'speak')
  expect(expressions.map(value => value.observerId)).not.toContain('character:player')
})

it('keeps another character private observations out of both model calls', async () => {
  let calls = 0
  const f = fixture(async request => {
    expect(JSON.stringify(request)).not.toContain('PLAYER_ONLY_SECRET')
    expect(JSON.stringify(request)).toContain('NPC_VISIBLE_REQUEST')
    return ++calls === 1 ? take : { decision: 'abstain' }
  }, [
    { eventType: 'observation.upsert', eventVersion: 1, data: { id: 'secret', value: {
      observerId: 'character:player', content: 'PLAYER_ONLY_SECRET',
    } } },
    { eventType: 'observation.upsert', eventVersion: 1, data: { id: 'visible', value: {
      observerId: npc, content: 'NPC_VISIBLE_REQUEST',
    } } },
  ])
  expect(await f.turn.run(npc)).toMatchObject({ status: 'abstained', calls: 2 })
})

it('supports a pure expression without invoking perform or a continuation', async () => {
  const f = fixture(async () => ({ decision: 'publish', segments: [{ type: 'narration', text: '轻轻笑了笑。' }] }))
  expect(await f.turn.run(npc)).toEqual({ status: 'published', calls: 1 })
  const events = f.store.readEvents(f.address)
  expect(currentEntityState(events, 'entity:cup')?.holderId).toBeNull()
  expect(events.filter(event => ['entity.transferred', 'character.moved', 'character.relation-started'].includes(event.eventType)))
    .toHaveLength(0)
})

it('ignores a late first decision when activation has been cancelled', async () => {
  const controller = new AbortController()
  const f = fixture(async () => { controller.abort(); return take })
  const before = f.store.head(f.address).headSeq
  expect(await f.turn.run(npc, { signal: controller.signal })).toMatchObject({ status: 'interrupted', calls: 1 })
  expect(f.store.head(f.address).headSeq).toBe(before)
})

it.each(['before-perform', 'after-perform'] as const)(
  'drops a late provider answer on timeout %s without undoing committed effects', async stage => {
    const f = fixture(async (_request, signal) => {
      if (stage === 'after-perform' && f.store.readEvents(f.address).some(event => event.eventType === 'entity.transferred')) {
        await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
        return { decision: 'publish', segments: [{ type: 'speech', text: '迟到的回答。' }] }
      }
      if (stage === 'before-perform') {
        await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
      }
      return take
    })
    const before = f.store.head(f.address).headSeq
    const result = await f.turn.run(npc, { signal: AbortSignal.timeout(25) })
    expect(result).toMatchObject({ status: 'interrupted', calls: stage === 'before-perform' ? 1 : 2 })
    const events = f.store.readEvents(f.address)
    expect(events.filter(event => event.eventType === 'entity.transferred')).toHaveLength(stage === 'before-perform' ? 0 : 1)
    expect(events.some(event => event.eventType === 'character.speak')).toBe(false)
    if (stage === 'before-perform') expect(f.store.head(f.address).headSeq).toBe(before)
    else expect(result.performResult).toMatchObject({ status: 'accepted' })
  })

it('publishes a directed continuation to a visible addressee after an executed operation', async () => {
  const f = fixture(async request => {
    if (!request.continuation) return take
    const schema = prototypeTurnCall(request).schema as WorldJsonObject
    const publish = (schema.oneOf as WorldJsonObject[]).find(value =>
      (value.properties as WorldJsonObject).decision !== undefined
      && ((value.properties as WorldJsonObject).decision as WorldJsonObject).const === 'publish')!
    const recipients = ((publish.properties as WorldJsonObject).addresseeIds as WorldJsonObject).items as WorldJsonObject
    expect(recipients.enum).toContain('character:player')
    return { decision: 'publish', addresseeIds: ['character:player'], segments: [{ type: 'speech', text: '我到了。' }] }
  })
  const result = await f.turn.run(npc)
  expect(result).toMatchObject({ status: 'published', calls: 2, performResult: { status: 'accepted' } })
  const speech = f.store.readEvents(f.address).findLast(event => event.eventType === 'character.speak')!
  expect(speech.data).toMatchObject({ addresseeIds: ['character:player'], scope: 'direct' })
})

it('temporary tabletop handling keeps custody and later transfer authority with the custodian', async () => {
  let stage = 'acquire'
  const f = fixture(async request => {
    if (stage === 'acquire') return request.continuation ? { decision: 'abstain' } : take
    if (stage === 'inspect') return { decision: 'publish', segments: [{ type: 'narration', text: '把杯子暂放桌上，松开手，让对方托起看一眼后放回；仍由自己保管。' }] }
    if (request.continuation) return { decision: 'abstain' }
    return { ...take, parameters: { ...take.parameters,
      definitionRef: { id: 'base:give', version: 1 }, bindingId: 'binding:entity:cup:base:give',
      arguments: { recipientId: 'character:player' } } }
  })
  await f.turn.run(npc)
  stage = 'inspect'
  await f.turn.run(npc)
  let events = f.store.readEvents(f.address)
  expect(currentEntityState(events, 'entity:cup')?.holderId).toBe(npc)
  expect(events.filter(event => event.eventType === 'entity.transferred')).toHaveLength(1)
  // An observer's temporary physical handling grants no right to give/drop the object.
  stage = 'give'
  expect(await f.turn.run(brandId('character:bob', 'CharacterId'))).toMatchObject({ performResult: { status: 'rejected' } })
  expect(await f.turn.run(npc)).toMatchObject({ performResult: { status: 'accepted' } })
  events = f.store.readEvents(f.address)
  expect(currentEntityState(events, 'entity:cup')?.holderId).toBe('character:player')
  expect(events.filter(event => event.eventType === 'entity.transferred')).toHaveLength(2)
})


it('preserves speech/narration alternation in one atomic publication, authorized views, memory and public UI', async () => {
  const segments: ExpressionSegment[] = [
    { type: 'speech', text: '先说一句。' }, { type: 'narration', text: '轻轻点头。' },
    { type: 'speech', text: '再补一句（这是对白中的括号）。' }, { type: 'narration', text: '目光停在杯子上。' },
  ]
  const player = brandId('character:player', 'CharacterId'), bob = brandId('character:bob', 'CharacterId')
  let calls = 0
  const f = fixture(async request => {
    calls++
    const decision = { decision: 'publish', segments, addresseeIds: [player] }
    for (const call of [prototypeTurnCall(request), localPrototypeTurnCall(request)]) {
      const validate = new Ajv({ strict: false }).compile(call.schema)
      expect(validate(decision)).toBe(true)
    }
    return decision
  })
  const before = f.store.head(f.address)
  expect(await f.turn.run(npc)).toMatchObject({ status: 'published', calls: 1 })
  expect(calls).toBe(1)
  const events = f.store.readEvents(f.address)
  const publication = events.findLast(e => e.eventType === 'character.speak')!
  expect(publication.data).toMatchObject({ segments, scope: 'direct', addresseeIds: [player] })
  expect(publication.data).not.toHaveProperty('text')
  expect(events.filter(e => e.seq > before.headSeq && e.eventType === 'character.speak')).toHaveLength(1)
  expect(f.store.head(f.address).tick).toBe(before.tick + 1)
  expect(currentLocation(events, npc)).toBe('location:room')
  expect(currentEntityState(events, 'entity:cup')?.holderId).toBeNull()
  const builder = new CharacterViewBuilder(f.store)
  const playerView = builder.rebuildAt(f.address, player, f.store.head(f.address).headSeq)
  const npcView = builder.rebuildAt(f.address, npc, f.store.head(f.address).headSeq)
  expect(npcView.selfObservations.at(-1)?.content).toMatchObject({ segments })
  const observed = playerView.observations.find(o => JSON.stringify(o.value).includes('先说一句'))!
  expect((observed.value as WorldJsonObject).content).toMatchObject({ speech: { segments } })
  expect(JSON.stringify(builder.rebuildAt(f.address, bob, f.store.head(f.address).headSeq))).not.toContain('先说一句')
  const transcript = playerTranscript(playerView, new Map([[npc, 'NPC']]), player)
  expect(transcript.at(-1)).toMatchObject({ segments, text: '先说一句。\n（轻轻点头。）\n再补一句（这是对白中的括号）。\n（目光停在杯子上。）' })
  const state = { transcript, world: { title: 'test', playerName: 'Player', npcNames: [] }, busy: false, paused: false, error: false } as unknown as PlaytestState
  expect(projectPlayerView(state).history.at(-1)?.segments).toEqual(segments)
  const rendered = new DeterministicPresenter().render({ observationId: String(observed.id), value: observed.value }, { locale: 'zh-CN' })
  expect(rendered.text).toContain(transcript.at(-1)!.text)
  const memory = new CognitiveMemoryService(join(f.directory, 'memory.sqlite'), f.store, undefined, 2, RECALL_KEYWORD_TOKENIZER_ID)
  try {
    for (const actor of [npc, player, bob]) memory.catchUp(f.address, actor, f.store.head(f.address).headSeq, 'ordered-expression-test')
    const db = new DatabaseSync(join(f.directory, 'memory.sqlite'), { readOnly: true })
    try {
      const rows = db.prepare('SELECT namespace_key,text_value,metadata_json,epistemic_kind FROM cognitive_memory_v2_sources WHERE text_value LIKE ?').all('%先说一句%')
      expect(rows).toHaveLength(2)
      for (const row of rows) {
        expect(row.epistemic_kind).toBe('reported_speech')
        expect(row.text_value).toBe(publicationSourceText(publication.data as WorldJsonObject))
        expect(JSON.parse(String(row.metadata_json)).segments).toEqual(segments)
        expect(String(row.namespace_key).endsWith(bob)).toBe(false)
      }
    } finally { db.close() }
  } finally { memory.close() }
  // Core receives the same authorized Source text, including the alternating order.
  const inputs: WorldJsonObject[] = []
  const core = new PlaytestMemoryCore(f.directory, f.address, async input => {
    inputs.push(input)
    if (input.operation === 'build') return { archive: { scope: input.scope!, sources: input.sources!, facts: [], episodes: [], observations: [] }, index: { scope: input.scope!, units: [], vectors: [] } }
    return { delivery: [], deliveryTrace: { delivered: [], activityCoverage: [] } }
  })
  try {
    await core.refresh([player], new AbortController().signal, () => {})
    expect(JSON.stringify(inputs)).toContain(publicationSourceText(publication.data as WorldJsonObject))
  } finally { await core.close() }
})

it('rejects malformed, mixed, oversized and unauthorized segmented publications before commit', async () => {
  const valid = [{ type: 'speech', text: '你好' }]
  const cases = [
    { decision: 'publish', speech: '旧模型字段' },
    { decision: 'publish', segments: valid, narration: '混合字段' },
    { decision: 'publish', segments: [] },
    { decision: 'publish', segments: [{ type: 'speech', text: '  ' }] },
    { decision: 'publish', segments: [{ type: 'move', text: '去后室' }] },
    { decision: 'publish', segments: [{ type: 'speech', text: '你好', actorId: 'other' }] },
    { decision: 'publish', segments: [{ type: 'speech', text: '字'.repeat(1001) }, { type: 'narration', text: '字'.repeat(1000) }] },
    { decision: 'publish', segments: valid, addresseeIds: ['character:npc'] },
    { decision: 'publish', segments: valid, addresseeIds: ['character:player', 'character:player'] },
    { decision: 'publish', segments: valid, addresseeIds: ['character:hidden'] },
  ]
  for (const raw of cases) {
    const f = fixture(async () => raw), before = f.store.head(f.address)
    expect(await f.turn.run(npc)).toMatchObject({ status: 'failed', failure: 'invalid_output' })
    expect(f.store.head(f.address)).toEqual(before)
  }
  const segments = [{ type: 'narration', text: '字'.repeat(1000) }, { type: 'speech', text: '字'.repeat(1000) }]
  const f = fixture(async () => ({ decision: 'publish', segments }))
  expect(await f.turn.run(npc)).toMatchObject({ status: 'published' })
})

it('keeps activity expression permissions when segments alternate or repeat', () => {
  const segments = parseExpressionSegments([{ type: 'narration', text: '点头' }, { type: 'speech', text: '甲' }, { type: 'narration', text: '微笑' }])
  expect(() => checkExpressionPolicy(segments, { speech: 'choices', speechChoices: ['甲'], narration: true })).not.toThrow()
  expect(() => checkExpressionPolicy(segments, { speech: 'none', narration: true })).toThrow('禁止')
  expect(() => checkExpressionPolicy(segments, { speech: 'free', narration: false })).toThrow('禁止')
  expect(() => checkExpressionPolicy([...segments, { type: 'speech', text: '甲' }], { speech: 'choices', speechChoices: ['甲'], narration: true })).toThrow('最多选择一项')
})

it('enforces the configured aggregate publication ceiling before committing expressions',async()=>{
 const segments=[{type:'speech',text:'a'.repeat(1500)},{type:'narration',text:'b'.repeat(1000)}]
 const allowed=fixture(async request=>{expect(request.context.publicationCharacters).toBe(3000);return {decision:'publish',segments}},[],{publicationCharacters:3000})
 expect(await allowed.turn.run(npc)).toMatchObject({status:'published'})
 const rejected=fixture(async()=>({decision:'publish',segments}),[],{publicationCharacters:2400})
 const before=rejected.store.head(rejected.address).headSeq
 expect(await rejected.turn.run(npc)).toMatchObject({status:'failed',failure:'invalid_output'})
 expect(rejected.store.head(rejected.address).headSeq).toBe(before)
})

it('bounds a configured activation without losing an already committed action',async()=>{
 let calls=0
 const f=fixture(async(_request,signal)=>{
  if(++calls===1)return take
  return new Promise((_done,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}))
 },[],{activationTimeoutMs:1000})
 expect(await f.turn.run(npc)).toMatchObject({status:'interrupted',calls:2})
 expect(currentEntityState(f.store.readEvents(f.address),'entity:cup')?.holderId).toBe(npc)
 expect(f.store.readEvents(f.address).filter(event=>event.eventType==='character.speak')).toHaveLength(0)
})


it.each(['scene_public','direct','private','self'])('accepts NPC %s publication in both model schemas and host, including result continuation',async scope=>{
 const addresseeIds=scope==='direct'||scope==='private'?['character:player']:[]
 const decision={decision:'publish',scope,addresseeIds,segments:[{type:'speech',text:'明确范围的对白'},{type:'narration',text:'轻轻点头'}]}
 const f=fixture(async request=>{
  if(!request.continuation)return take
  for(const call of [prototypeTurnCall(request),localPrototypeTurnCall(request)]) {
   expect(new Ajv({strict:false}).compile(call.schema)(decision)).toBe(true)
   expect(JSON.stringify(call.schema)).toContain('private')
  }
  return decision
 })
 expect(await f.turn.run(npc)).toMatchObject({status:'published',calls:2})
 expect(f.store.readEvents(f.address).findLast(e=>e.eventType==='character.speak')?.data).toMatchObject({scope,addresseeIds,segments:decision.segments})
})
it.each([
 {scope:'direct'}, {scope:'private',addresseeIds:[]},
 {scope:'scene_public',addresseeIds:['character:player']},
 {scope:'self',addresseeIds:['character:player']}, {scope:'unknown'},
 {scope:'private',addresseeIds:['character:hidden']},
])('rejects inconsistent or unauthorized NPC publication %j before commit',async audience=>{
 const f=fixture(async()=>({decision:'publish',segments:[{type:'speech',text:'不应发布'}],...audience}))
 const before=f.store.head(f.address)
 expect(await f.turn.run(npc)).toMatchObject({status:'failed',failure:'invalid_output'})
 expect(f.store.head(f.address)).toEqual(before)
})

it('keeps local interaction versions numeric without a singleton enum, while rejecting string and wrong versions',async()=>{
 let calls=0;
 const f=fixture(async request=>{
  if(++calls>1)return {decision:'abstain'};
  const call=localPrototypeTurnCall(request),validate=new Ajv({strict:false}).compile(call.schema);
  const p=(call.schema.properties as WorldJsonObject).parameters as WorldJsonObject;
  const d=(p.properties as WorldJsonObject).definitionRef as WorldJsonObject;
  expect((d.properties as WorldJsonObject).version).toEqual({type:'integer',minimum:1,maximum:1});
  expect(validate(take)).toBe(true);
  expect(validate({...take,parameters:{...take.parameters,definitionRef:{...take.parameters.definitionRef,version:'1'}}})).toBe(false);
  expect(validate({...take,parameters:{...take.parameters,definitionRef:{...take.parameters.definitionRef,version:2}}})).toBe(false);
  return take;
 });
 expect(await f.turn.run(npc)).toMatchObject({performResult:{status:'accepted'}});
 expect(currentEntityState(f.store.readEvents(f.address),'entity:cup')?.holderId).toBe(npc);
})
