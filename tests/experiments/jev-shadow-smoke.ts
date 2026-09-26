// Public, manually authored fixtures only. Never reads historical playtest data.
import { mkdirSync } from 'node:fs'
import { appendFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { brandId, type StoredWorldEvent, type WorldAddress, type WorldJsonObject } from '@harness-world/contracts'
import { createHolderClassifier } from './jev-shadow-client.ts'
import { JevShadow, type ShadowRecord } from './jev-shadow.ts'

const address: WorldAddress = { tenantId: brandId('synthetic', 'TenantId'), worldId: brandId('shadow-smoke', 'WorldId'), branchId: brandId('main', 'BranchId') }
const characters = [{ characterId: 'char:a', name: '林澄' }, { characterId: 'char:b', name: '陆遥' }, { characterId: 'char:c', name: '新来者' }]
const key = { entityId: 'item:key', name: '黄铜钥匙', aliases: ['钥匙'] }
function event(seq: number, eventType: string, data: WorldJsonObject, tx = seq): StoredWorldEvent {
  return { address, seq, eventType, data, eventVersion: 1, tick: tx, eventHash: `sha256:${'0'.repeat(64)}`, previousHash: 'genesis',
    transactionId: brandId(`tx:${tx}`, 'TransactionId'), eventOrdinal: 0 }
}
const cases = [
  { id: 'unsupported', narration: '林澄把黄铜钥匙交给陆遥。陆遥接过钥匙，放进自己的口袋。', expected: 'CONFLICT' },
  { id: 'supported', narration: '陆遥从桌上拿起黄铜钥匙，现在由陆遥保管。', transfer: true, expected: 'SUPPORTED' },
  { id: 'speech-only', speech: '我已经把黄铜钥匙给你了。', expected: 'NO_CLAIM' },
  { id: 'unmentioned', narration: '林澄看着窗外，轻轻叹了口气。', expected: 'NO_CLAIM' },
  { id: 'intention', narration: '林澄打算把黄铜钥匙交给陆遥，但还没有行动。', expected: 'NO_CLAIM' },
  { id: 'attempt', narration: '林澄递出黄铜钥匙，陆遥还没有接住。', expected: 'NO_CLAIM' },
  { id: 'new-recipient', narration: '新来者从桌上拿走黄铜钥匙，钥匙现在由新来者保管。', expected: 'CONFLICT' },
  { id: 'same-name', narration: '那把钥匙已经在新来者的口袋里。', ambiguous: true, expected: 'UNCERTAIN' },
]
const classify = createHolderClassifier(process.env.OPENROUTER_JEV_KEY ?? '')
const output = resolve('experiments/jev-narrative-auditor/results-shadow-minimal-after-2026-09-26.jsonl')
mkdirSync(resolve('experiments/jev-narrative-auditor'), { recursive: true })
const rows: Array<{ id: string; expected: string; record: ShadowRecord }> = []
for (const sample of cases) {
  const items = [key, ...(sample.ambiguous ? [{ ...key, entityId: 'item:other-key' }] : [])]
  const events = [
    ...characters.map((character, index) => event(index + 1, 'character.created', { ...character, locationId: 'room' })),
    ...items.map((item, index) => event(index + 4, 'entity.upsert', { entityId: item.entityId, kind: 'key', locationId: 'room' })),
  ]
  const initialSeq = events.length
  if (sample.transfer) events.push(event(events.length + 1, 'entity.transferred', { entityId: key.entityId,
    fromHolderId: null, fromLocationId: 'room', toHolderId: 'char:b', toLocationId: null, characterId: 'char:b', interactionId: 'take' }, initialSeq + 1))
  events.push(event(events.length + 1, 'character.speak', { characterId: 'char:a', text: sample.speech ?? '', narration: sample.narration ?? '' }, initialSeq + 1))
  const shadow = new JevShadow({ address, characters, items, initialSeq, classify,
    readEvents: seq => events.slice(0, seq), write: async record => {
      const row = { id: sample.id, expected: sample.expected, record }
      rows.push(row); await appendFile(output, JSON.stringify(row) + '\n', 'utf8')
    } })
  shadow.observe(events.length); await shadow.close()
}
console.log(JSON.stringify({ cases: cases.length, records: rows.length,
  matching: rows.filter(row => row.expected === row.record.status).length,
  failures: rows.filter(row => row.record.status === 'CALL_FAILED').length,
  costUsd: rows.reduce((sum, row) => sum + (row.record.answer?.costUsd ?? 0), 0),
  meanLatencyMs: rows.reduce((sum, row) => sum + row.record.latencyMs, 0) / rows.length,
  results: rows.map(row => ({ id: row.id, expected: row.expected, actual: row.record.status, choice: row.record.answer?.choice })),
  output }, null, 2))
if (rows.some(row => row.record.status === 'CALL_FAILED')) process.exitCode = 1
