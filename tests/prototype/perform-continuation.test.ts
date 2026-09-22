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
  expect(currentEntityState(f.store.readEvents(f.address), 'entity:cup')?.holderId).toBeNull()
})

it('ignores a late first decision when activation has been cancelled', async () => {
  const controller = new AbortController()
  const f = fixture(async () => { controller.abort(); return take })
  const before = f.store.head(f.address).headSeq
  expect(await f.turn.run(npc, { signal: controller.signal })).toMatchObject({ status: 'interrupted', calls: 1 })
  expect(f.store.head(f.address).headSeq).toBe(before)
})
