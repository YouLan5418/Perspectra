import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { brandId, hashWorldJson, RECALL_KEYWORD_TOKENIZER_ID, type WorldEventDraft, type WorldJsonObject } from '@harness-world/contracts'
import { createCoreRulebookRegistry } from '@harness-world/kernel'
import { WorldStore, WriterLeaseService, CharacterRuntimeAvailabilityService } from '@harness-world/store-sqlite'
import { CognitiveMemoryService } from '@harness-world/memory'
import { prototypeTurnCall } from '@harness-world/provider-chat'
import { PrototypeCharacterTurn, type PrototypeTurnRequest } from '../../packages/application/src/prototype-character-turn.ts'
import { frozenInteractionWorld, basicInteractionPackage } from '../fixtures/frozen-interaction-world.ts'

const close: (() => void)[] = []
afterEach(() => { for (const item of close.splice(0).reverse()) item() })
const npc = brandId('character:npc', 'CharacterId')
const bob = brandId('character:bob', 'CharacterId')
const observation = (id: string, observerId: string, content: WorldJsonObject): WorldEventDraft => ({
  eventType: 'observation.upsert', eventVersion: 1,
  data: { id, value: { observerId, content } },
})
function fixture(decide: (request: PrototypeTurnRequest) => Promise<unknown>, longHistory = false) {
  const dir = mkdtempSync(join(tmpdir(), 'active-recall-'))
  close.push(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, 'world.sqlite')
  const store = new WorldStore(path), leases = new WriterLeaseService(path)
  const availability = new CharacterRuntimeAvailabilityService(path)
  const world = frozenInteractionWorld()
  const genesisEvents = [...world.genesisEvents,
    observation('observation:hearsay', npc, { actionType: 'speak', actorId: bob,
      speech: { characterId: bob, text: '昨天我把钥匙交给程雨了。' } }),
    observation('observation:witness', npc, { actionType: 'interact', actorId: npc,
      resultDescription: '我看见钥匙仍在桌上。' }),
    observation('observation:private', bob, { actionType: 'speak', actorId: npc,
      speech: { characterId: npc, text: '钥匙藏在秘密抽屉里。' } }),
    ...(longHistory ? [
      { eventType: 'character.moved', eventVersion: 1, data: {
        characterId: bob, fromLocationId: 'location:room', toLocationId: 'location:next',
      } } satisfies WorldEventDraft,
      ...Array.from({ length: 18 }, (_, index) => observation(`observation:filler-${index}`, npc, {
        actionType: 'speak', actorId: 'character:player',
        speech: { characterId: 'character:player', text: `现在等了${index}分钟。` },
      })),
    ] : []),
  ]
  store.activateBranch({ ...world, genesisEvents, genesisHash: hashWorldJson('world-genesis-plan', genesisEvents),
    address: world.manifest.address, transactionId: brandId('transaction:active-recall-genesis', 'TransactionId'),
    roundId: brandId('round:active-recall-genesis', 'InteractionRoundId'), correlationId: 'active-recall' })
  const memory = new CognitiveMemoryService(join(dir, 'memory.sqlite'), store, undefined, 2, RECALL_KEYWORD_TOKENIZER_ID)
  close.push(() => { memory.close(); availability.close(); leases.close(); store.close() })
  const turn = new PrototypeCharacterTurn({ address: world.manifest.address, store, memory, leases, availability,
    rulebooks: createCoreRulebookRegistry({ interactionPackages: [basicInteractionPackage] }),
    decide: async request => decide(request) })
  return { turn, store, address: world.manifest.address }
}

async function advanceTick(f: ReturnType<typeof fixture>, index: number): Promise<void> {
  const head = f.store.head(f.address)
  await f.store.commitRound({
    address: f.address,
    transactionId: brandId('transaction:active-recall-age-' + index, 'TransactionId'),
    roundId: brandId('round:active-recall-age-' + index, 'InteractionRoundId'),
    expectedHeadSeq: head.headSeq, expectedTick: head.tick, nextTick: head.tick + 1,
    events: [observation('observation:clock-' + index, bob, { actionType: 'speak', actorId: bob,
      speech: { characterId: bob, text: '另一处的新消息。' } })],
    outbox: [], correlationId: 'active-recall-age-' + index,
  })
}

it('lets an NPC retrieve only its attributed evidence, then decide without granting evidence world authority', async () => {
  const requests: PrototypeTurnRequest[] = []
  const f = fixture(async request => {
    requests.push(request)
    const schema = JSON.stringify(prototypeTurnCall(request).schema)
    if (requests.length === 1) {
      expect(schema).toContain('"const":"recall"')
      return { decision: 'recall', query: '钥匙' }
    }
    expect(schema).not.toContain('"const":"recall"')
    expect(request.recallEvidence?.query).toBe('钥匙')
    const memories = request.recallEvidence?.memories as WorldJsonObject[]
    expect(memories.some(m => (m.metadata as WorldJsonObject).epistemicKind === 'reported_speech'
      && (m.metadata as WorldJsonObject).speakerId === bob && String(m.text).includes('昨天我把钥匙交给程雨了'))).toBe(true)
    expect(memories.some(m => (m.metadata as WorldJsonObject).epistemicKind === 'observed_action'
      && String(m.text).includes('我看见钥匙仍在桌上'))).toBe(true)
    expect(memories.every(m => typeof (m.metadata as WorldJsonObject).source === 'object')).toBe(true)
    expect(memories.every(m => m.sourceAgeTicks === 2)).toBe(true)
    expect(JSON.stringify(request)).not.toContain('秘密抽屉')
    expect(request.recallEvidence?.note).toContain('不证明')
    return { decision: 'publish', speech: '我记得陆舟这么说过，但还得看看钥匙。' }
  }, true)
  await advanceTick(f, 1)
  await advanceTick(f, 2)
  const before = f.store.head(f.address).headSeq
  expect(await f.turn.run(npc, { maxCalls: 1 })).toMatchObject({ status: 'published', calls: 2 })
  const delta = f.store.readEvents(f.address).filter(e => e.seq > before)
  expect(delta.filter(e => e.eventType === 'character.speak')).toHaveLength(1)
  expect(delta.some(e => e.eventType === 'entity.transferred' || e.eventType === 'character.moved')).toBe(false)
})

it('rejects a second recall in the same activation without changing World', async () => {
  let requests = 0
  const f = fixture(async request => {
    requests++
    if (requests === 1) return { decision: 'recall', query: '钥匙' }
    expect(JSON.stringify(prototypeTurnCall(request).schema)).not.toContain('"const":"recall"')
    return { decision: 'recall', query: '日记' }
  })
  const before = f.store.head(f.address).headSeq
  expect(await f.turn.run(npc, { maxCalls: 1 })).toMatchObject({ status: 'failed', failure: 'invalid_output', calls: 2 })
  expect(f.store.head(f.address).headSeq).toBe(before)
})

it('returns no duplicate source when active recall repeats recent or automatic evidence', async () => {
  for (const longHistory of [false, true]) {
    let requestCount = 0
    const f = fixture(async request => {
      requestCount += 1
      if (requestCount === 1) {
        if (longHistory) {
          const automatic = request.context.memories as WorldJsonObject[]
          expect(automatic.some(memory => String(memory.text).includes('昨天我把钥匙交给程雨了'))).toBe(true)
          expect(automatic.every(memory => memory.sourceAgeTicks === 1)).toBe(true)
        } else {
          const recent = request.context.observations as WorldJsonObject[]
          expect(recent.some(record => JSON.stringify(record).includes('昨天我把钥匙交给程雨了'))).toBe(true)
        }
        return { decision: 'recall', query: '钥匙' }
      }
      expect(request.recallEvidence?.memories).toEqual([])
      expect(JSON.stringify(request)).not.toContain('秘密抽屉')
      return { decision: 'publish', speech: '我会把已知的说法和亲眼所见分开。' }
    }, longHistory)
    await advanceTick(f, 1)
    expect(await f.turn.run(npc, { maxCalls: 1, stimulus: [{ sourceText: '钥匙' }] }))
      .toMatchObject({ status: 'published', calls: 2 })
  }
})
