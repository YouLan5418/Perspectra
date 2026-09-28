import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { brandId, hashWorldJson, RECALL_KEYWORD_TOKENIZER_ID, worldAddressKey,
  type WorldEventDraft, type WorldJsonObject } from '@harness-world/contracts'
import { WorldStore } from '@harness-world/store-sqlite'
import { CognitiveMemoryService } from '@harness-world/memory'
import { frozenInteractionWorld } from '../fixtures/frozen-interaction-world.ts'

// Shadow experiment: only the host chooses character-scoped sources and banks.
const root = resolve(process.argv[2] ?? '')
if (!process.argv[2] || existsSync(root)) throw new Error('provide a new output directory')
const hindsightUrl = process.env.HINDSIGHT_LAB_URL?.trim() || 'http://127.0.0.1:8891'
const npc = brandId('character:npc', 'CharacterId')
const bob = brandId('character:bob', 'CharacterId')
const player = brandId('character:player', 'CharacterId')
const observation = (id: string, observerId: string, content: WorldJsonObject): WorldEventDraft => ({
  eventType: 'observation.upsert', eventVersion: 1, data: { id, value: { observerId, content } },
})
type Source = {
  source_id: string; source_seq: number; source_hash: string; capture_hash: string
  epistemic_kind: string; memory_kind: string; text_value: string
}
type Recalled = { text: string; document_id: string | null; metadata: Record<string, string> | null }
async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(hindsightUrl + path, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  })
  if (!response.ok) throw new Error('Hindsight ' + path + ' returned ' + response.status
    + ': ' + (await response.text()).slice(0, 500))
  return await response.json() as T
}
mkdirSync(root, { recursive: true })
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
    address: world.manifest.address, transactionId: brandId('transaction:hindsight-shadow', 'TransactionId'),
    roundId: brandId('round:hindsight-shadow', 'InteractionRoundId'), correlationId: 'hindsight-shadow' })
  const head = store.head(world.manifest.address)
  memory = new CognitiveMemoryService(memoryPath, store, undefined, 2, RECALL_KEYWORD_TOKENIZER_ID)
  for (const characterId of [npc, bob]) {
    memory.catchUp(world.manifest.address, characterId, head.headSeq, 'hindsight-shadow:' + characterId)
  }
  const db = new DatabaseSync(memoryPath, { readOnly: true })
  const sources = new Map<string, Source[]>()
  try {
    for (const characterId of [npc, bob]) {
      const namespace = worldAddressKey(world.manifest.address) + '\u001f' + characterId
      sources.set(characterId, db.prepare(
        'SELECT source_id, source_seq, source_hash, capture_hash, epistemic_kind, memory_kind, text_value '
        + 'FROM cognitive_memory_v2_sources WHERE namespace_key = ? AND source_seq <= ? '
        + 'ORDER BY source_seq, source_id',
      ).all(namespace, head.headSeq) as Source[])
    }
  } finally { db.close() }
  const history = store.readEvents(world.manifest.address)
  const sourceId = (id: string) => {
    const event = history.find(entry => (entry.data as WorldJsonObject).id === id)
    if (event === undefined) throw new Error('missing source ' + id)
    return 'event:' + event.seq
  }
  const taken = sourceId('observation:cup-taken')
  const claim = sourceId('observation:cup-claim')
  const privateSource = sourceId('observation:bob-private')
  const npcSources = sources.get(npc)!, bobSources = sources.get(bob)!
  if (!npcSources.some(row => row.source_id === taken) || !npcSources.some(row => row.source_id === claim)
    || npcSources.some(row => row.source_id === privateSource || row.text_value.includes('深海灯'))
    || !bobSources.some(row => row.source_id === privateSource)) {
    throw new Error('local character visibility projection failed')
  }
  const runId = basename(root).replace(/[^a-zA-Z0-9_-]/gu, '-').slice(-45)
  const banks = { npc: 'cordis-lab-' + runId + '-npc', bob: 'cordis-lab-' + runId + '-bob' }
  for (const [characterId, bank] of [[npc, banks.npc], [bob, banks.bob]] as const) {
    await post('/v1/default/banks/' + bank + '/memories', { items: sources.get(characterId)!.map(row => ({
      content: row.text_value, timestamp: 'unset', document_id: row.source_id,
      context: 'character-visible ' + row.epistemic_kind,
      metadata: { source_id: row.source_id, source_seq: String(row.source_seq),
        source_hash: row.source_hash, capture_hash: row.capture_hash,
        epistemic_kind: row.epistemic_kind, memory_kind: row.memory_kind },
    })) })
  }
  const queries = [
    { characterId: npc, bank: banks.npc, question: '最早是谁把杯子从桌上拿走的？', expected: taken },
    { characterId: npc, bank: banks.npc, question: '那件喝水用的器皿当时是被谁收走的？', expected: taken },
    { characterId: npc, bank: banks.npc, question: '鲍勃曾说过杯子已经给玩家了吗？', expected: claim },
    { characterId: npc, bank: banks.npc, question: '私下说的暗号深海灯是什么？', expected: null },
    { characterId: bob, bank: banks.bob, question: '玩家只对我说的暗号是什么？', expected: privateSource },
  ] as const
  const results = []
  for (const query of queries) {
    const baseline = memory.recall(world.manifest.address, query.characterId, query.question, head.headSeq)
    const hindsight = await post<{ results: Recalled[] }>(
      '/v1/default/banks/' + query.bank + '/memories/recall',
      { query: query.question, budget: 'low', max_tokens: 180 },
    )
    const allowed = new Map(sources.get(query.characterId)!.map(row => [row.source_id, row]))
    for (const row of hindsight.results) {
      const source = row.metadata?.source_id
      if (source === undefined || row.document_id !== source || allowed.get(source)?.text_value !== row.text) {
        throw new Error('Hindsight returned an unattributed or unapproved source for ' + query.characterId)
      }
    }
    if (query.characterId === npc && JSON.stringify(hindsight.results).includes('深海灯')) {
      throw new Error('Hindsight leaked another character private observation')
    }
    results.push({ question: query.question, characterId: query.characterId, expected: query.expected,
      baseline: baseline.map(row => ({ sourceSeq: row.sourceMaxSeq, text: row.text })),
      hindsight: hindsight.results.map(row => ({ sourceId: row.metadata!.source_id, text: row.text })),
      baselineHit: query.expected === null ? !baseline.some(row => row.text.includes('深海灯'))
        : baseline.some(row => row.sourceMaxSeq === Number(query.expected.slice(6))),
      hindsightHit: query.expected === null ? !hindsight.results.some(row => row.text.includes('深海灯'))
        : hindsight.results.some(row => row.metadata?.source_id === query.expected),
    })
  }
  if (store.head(world.manifest.address).headSeq !== head.headSeq) throw new Error('shadow recall changed world events')
  const report = { backend: 'Hindsight 0.10.1', mode: 'chunks, no consolidation, ONNX multilingual-e5-small, RRF',
    banks, headSeq: head.headSeq, sourceCounts: { npc: npcSources.length, bob: bobSources.length },
    roleIsolation: true, worldUnchanged: true, results }
  writeFileSync(resolve(root, 'report.json'), JSON.stringify(report, null, 2))
  writeFileSync(resolve(root, 'sources.json'), JSON.stringify({ npc: npcSources, bob: bobSources }, null, 2))
  process.stdout.write(JSON.stringify(report, null, 2) + '\n')
} finally { memory?.close(); store.close() }
