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

function fixture(decide: (request: PrototypeTurnRequest, signal: AbortSignal) => Promise<unknown>, extra: WorldEventDraft[] = []) {
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
  const turn = new PrototypeCharacterTurn({ address, store, leases, availability,
    rulebooks: createCoreRulebookRegistry({ interactionPackages: [basicInteractionPackage] }), decide })
  return { turn, store, address }
}

it('commits perform before continuation, then publishes the result-aware expression', async () => {
  let calls = 0
  const f = fixture(async request => {
    if (++calls === 1) return take
    expect(request.result?.status).toBe('accepted')
    expect(currentEntityState(f.store.readEvents(f.address), 'entity:cup')?.holderId).toBe(npc)
    expect(f.store.readEvents(f.address).filter(event => event.eventType === 'character.speak')).toHaveLength(0)
    expect(JSON.stringify(prototypeTurnCall(request).schema)).not.toContain('"const":"perform"')
    return { decision: 'publish', speech: '拿到了。', narration: '低头看了看手里的杯子。' }
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
    return { decision: 'publish', speech: '拿起来看了看，又放回原处。' }
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
    return { decision: 'publish', speech: '我还没拿到它呢。' }
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
      if (mode === 'cancel') { controller.abort(); return { decision: 'publish', speech: 'late' } }
      if (mode === 'second-operation') return take
      if (mode === 'mixed-draft') return { decision: 'publish', speech: 'done', parameters: take.parameters }
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

it('refreshes the scene after moving and publishes only to the new audience', async () => {
  let calls = 0
  const f = fixture(async request => {
    if (++calls === 1) return { decision: 'perform', actionType: 'move', parameters: { locationId: 'location:next' } }
    expect(currentLocation(f.store.readEvents(f.address), npc)).toBe('location:next')
    expect((request.context.scene as WorldJsonObject).locationId).toBe('location:next')
    expect(JSON.stringify(prototypeTurnCall(request).schema)).not.toContain('addresseeIds')
    return { decision: 'publish', narration: '环顾四周。' }
  })
  expect(await f.turn.run(npc)).toMatchObject({ status: 'published' })
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
  const f = fixture(async () => ({ decision: 'publish', narration: '轻轻笑了笑。' }))
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
        return { decision: 'publish', speech: '迟到的回答。' }
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
    return { decision: 'publish', speech: '我到了。', addresseeIds: ['character:player'] }
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
    if (stage === 'inspect') return { decision: 'publish', narration: '把杯子暂放桌上，松开手，让对方托起看一眼后放回；仍由自己保管。' }
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
