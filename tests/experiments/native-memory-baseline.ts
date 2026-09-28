import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { brandId, hashWorldJson, RECALL_KEYWORD_TOKENIZER_ID, worldAddressKey,
  type WorldEventDraft, type WorldJsonObject } from '@harness-world/contracts'
import { WorldStore } from '@harness-world/store-sqlite'
import { CognitiveMemoryService } from '@harness-world/memory'
import { frozenInteractionWorld } from '../fixtures/frozen-interaction-world.ts'

// A local baseline. Hindsight, embeddings and model APIs are not needed to reproduce it.
const root = resolve(process.argv[2] ?? '')
if (!process.argv[2] || existsSync(root)) throw new Error('provide a new output directory')
mkdirSync(root, { recursive: true })

const npc = brandId('character:npc', 'CharacterId')
const bob = brandId('character:bob', 'CharacterId')
const player = brandId('character:player', 'CharacterId')
const observation = (id: string, observerId: string, content: WorldJsonObject): WorldEventDraft => ({
  eventType: 'observation.upsert', eventVersion: 1, data: { id, value: { observerId, content } },
})
const worldPath = resolve(root, 'world.sqlite')
const memoryPath = resolve(root, 'memory.sqlite')
const store = new WorldStore(worldPath)
let memory: CognitiveMemoryService | undefined
try {
  const world = frozenInteractionWorld()
  const transfer: WorldEventDraft = { eventType: 'entity.transferred', eventVersion: 1, data: {
    entityId: 'entity:cup', characterId: bob, interactionId: 'base:take',
    fromHolderId: null, fromLocationId: 'location:room', toHolderId: bob, toLocationId: null,
  } }
  const events: WorldEventDraft[] = [...world.genesisEvents, transfer,
    observation('observation:cup-taken', npc, { actorId: bob, actionType: 'interact', status: 'accepted',
      interaction: transfer.data, resultDescription: '鲍勃取得了杯子的保管。' }),
    observation('observation:cup-claim', npc, { actorId: bob, actionType: 'speak', status: 'accepted',
      speech: { characterId: bob, text: '我早把杯子交给玩家了。' } }),
    observation('observation:bob-private', bob, { actorId: player, actionType: 'speak', status: 'accepted',
      speech: { characterId: player, text: '只对鲍勃说：暗号是深海灯。' } }),
    observation('observation:door-promise', npc, { actorId: bob, actionType: 'speak', status: 'accepted',
      speech: { characterId: bob, text: '等我回来，我会把坏掉的门锁修好。' } }),
    { eventType: 'character.moved', eventVersion: 1, data: {
      characterId: bob, fromLocationId: 'location:room', toLocationId: 'location:next',
    } },
    { eventType: 'entity.transferred', eventVersion: 1, data: {
      entityId: 'entity:cup', characterId: bob, interactionId: 'base:drop',
      fromHolderId: bob, fromLocationId: null, toHolderId: null, toLocationId: 'location:next',
    } },
    ...Array.from({ length: 18 }, (_, n) => observation('observation:filler-' + n, npc,
      { actorId: player, actionType: 'speak', status: 'accepted',
        speech: { characterId: player, text: '今天雨还没停，我们已经等了' + (n + 1) + '分钟。' } })),
  ]
  store.activateBranch({ ...world, genesisEvents: events, genesisHash: hashWorldJson('world-genesis-plan', events),
    address: world.manifest.address, transactionId: brandId('transaction:native-memory-baseline', 'TransactionId'),
    roundId: brandId('round:native-memory-baseline', 'InteractionRoundId'),
    correlationId: 'native-memory-baseline' })
  const head = store.head(world.manifest.address)
  memory = new CognitiveMemoryService(memoryPath, store, undefined, 2, RECALL_KEYWORD_TOKENIZER_ID)
  const history = store.readEvents(world.manifest.address)
  const sourceId = (id: string) => {
    const event = history.find(entry => (entry.data as WorldJsonObject).id === id)
    if (event === undefined) throw new Error('missing source ' + id)
    return 'event:' + event.seq
  }
  const taken = sourceId('observation:cup-taken')
  const claim = sourceId('observation:cup-claim')
  const privateSource = sourceId('observation:bob-private')
  const promise = sourceId('observation:door-promise')
  const beforeTake = Number(taken.slice('event:'.length)) - 1
  const beforePrivate = Number(privateSource.slice('event:'.length)) - 1
  const npcBeforeTake = memory.recall(world.manifest.address, npc, '杯子谁拿走', beforeTake)
  const bobBeforePrivate = memory.recall(world.manifest.address, bob, '玩家对我说的暗号', beforePrivate)
  if (npcBeforeTake.some(row => row.sourceMaxSeq > beforeTake)
    || bobBeforePrivate.some(row => row.sourceMaxSeq > beforePrivate)) {
    throw new Error('as-of recall returned a future source')
  }
  const prefixChecks = { beforeTake, beforePrivate,
    npcFutureSources: npcBeforeTake.filter(row => row.sourceMaxSeq > beforeTake).length,
    bobFutureSources: bobBeforePrivate.filter(row => row.sourceMaxSeq > beforePrivate).length }
  for (const characterId of [npc, bob]) {
    memory.catchUp(world.manifest.address, characterId, head.headSeq, 'native-baseline:' + characterId)
  }
  const db = new DatabaseSync(memoryPath, { readOnly: true })
  const sources: Record<string, Array<{ source_id: string; source_seq: number; source_hash: string; capture_hash: string; memory_kind: string; epistemic_kind: string;
    text_value: string }>> = {}
  try {
    for (const characterId of [npc, bob]) {
      const key = worldAddressKey(world.manifest.address) + '\u001f' + characterId
      sources[characterId] = db.prepare(
        'SELECT source_id, source_seq, source_hash, capture_hash, memory_kind, epistemic_kind, text_value FROM cognitive_memory_v2_sources '
        + 'WHERE namespace_key = ? AND source_seq <= ? ORDER BY source_seq, source_id',
      ).all(key, head.headSeq) as typeof sources[string]
    }
  } finally { db.close() }
  if (!sources[npc]?.some(row => row.source_id === taken) || !sources[npc]?.some(row => row.source_id === claim) || !sources[npc]?.some(row => row.source_id === promise)
    || sources[npc]?.some(row => row.source_id === privateSource || row.text_value.includes('深海灯'))
    || !sources[bob]?.some(row => row.source_id === privateSource)) {
    throw new Error('source projection broke character isolation')
  }

  // Labels describe the evidence this character may use, not what an embedding score predicts.
  const cases = [
    { id: 'direct', characterId: npc, question: '最早是谁把杯子从桌上拿走的？', expected: taken },
    { id: 'paraphrase', characterId: npc, question: '那件喝水用的器皿当时是被谁收走的？', expected: taken },
    { id: 'indirect', characterId: npc, question: '桌上被拿走的东西最初到了谁手里？', expected: taken },
    { id: 'reported-speech', characterId: npc, question: '鲍勃曾说过杯子已经给玩家了吗？', expected: claim },
    { id: 'private-unknown', characterId: npc, question: '玩家私下告诉鲍勃的暗号是什么？', expected: null },
    { id: 'private-known', characterId: bob, question: '玩家只对我说的暗号是什么？', expected: privateSource },
    { id: 'promise-direct', characterId: npc, question: '鲍勃说过要修门锁吗？', expected: promise },
    { id: 'promise-paraphrase', characterId: npc, question: '是谁答应稍后处理那扇关不牢的门？', expected: promise },
    { id: 'promise-unfulfilled', characterId: npc, question: '那扇门现在已经修好了吗？', expected: null },
    { id: 'unseen-drop', characterId: npc, question: '鲍勃离开后把杯子放在哪个房间？', expected: null },
    { id: 'unrelated-unknown', characterId: npc, question: '门外那棵树叫什么名字？', expected: null },
  ] as const
  const results = cases.map(entry => {
    const recall = memory!.recall(world.manifest.address, entry.characterId, entry.question, head.headSeq)
    const returned = recall.map(row => ({
      sourceId: 'event:' + row.sourceMaxSeq, text: row.text,
    }))
    if (entry.characterId === npc && returned.some(row => row.text.includes('深海灯'))) {
      throw new Error('private observation leaked into NPC recall: ' + entry.id)
    }
    return { ...entry, returned, expectedHit: entry.expected === null
      ? null : returned.some(row => row.sourceId === entry.expected),
      noAnswerCandidateCount: entry.expected === null ? returned.length : null }
  })
  if (store.head(world.manifest.address).headSeq !== head.headSeq) throw new Error('recall changed world events')
  const report = { mode: 'native-cjk-keyword-baseline', headSeq: head.headSeq,
    sourceCounts: { npc: sources[npc]!.length, bob: sources[bob]!.length }, prefixChecks,
    expectedHits: results.filter(row => row.expected !== null && row.expectedHit).length,
    expectedTotal: results.filter(row => row.expected !== null).length,
    results }
  writeFileSync(resolve(root, 'report.json'), JSON.stringify(report, null, 2))
  writeFileSync(resolve(root, 'sources.json'), JSON.stringify(sources, null, 2))
  process.stdout.write(JSON.stringify({ expectedHits: report.expectedHits, expectedTotal: report.expectedTotal,
    results: results.map(row => ({ id: row.id, expectedHit: row.expectedHit,
      noAnswerCandidateCount: row.noAnswerCandidateCount, returned: row.returned.map(item => item.sourceId) })) }) + '\n')
} finally { memory?.close(); store.close() }
