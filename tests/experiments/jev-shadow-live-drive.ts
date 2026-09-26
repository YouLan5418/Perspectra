import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import { currentEntityState, type RulebookEvent } from '@harness-world/kernel'
import type { ShadowRecord } from './jev-shadow.ts'
import type { PlaytestState } from './playtest-server.ts'

// Calls the already-running real web host. No API keys or private agent contexts are read here.
const origin = process.env.LOCAL_PLAYTEST_URL
const token = process.env.LOCAL_PLAYTEST_TOKEN
const dataDirectory = resolve(process.argv[2] ?? '')
if (!origin || !token || !process.argv[2]) throw new Error('local playtest URL, token and data directory are required')
const prompts = [
  '桌上这把黄铜钥匙有什么用？',
  '同行者，请帮我拿起黄铜钥匙，先由你保管。',
  '先别把钥匙交给我。我想知道你拿到它以后打算怎么办。',
  '同行者，把黄铜钥匙交给留守者吧。',
  '留守者，钥匙现在在哪儿？你准备怎么保管它？',
  '我只是指了指保温杯，没有拿它。你们愿意帮我看看它吗？',
  '同行者，我们去后室聊一会儿吧；钥匙留给留守者。',
  '我回到前室，问留守者：刚才我不在的时候，钥匙有没有交给别人？',
]
async function request(path: string, text?: string): Promise<PlaytestState> {
  const response = await fetch(origin + path, { method: text === undefined ? 'GET' : 'POST',
    headers: { 'x-playtest-token': token!, 'content-type': 'application/json' },
    ...(text === undefined ? {} : { body: JSON.stringify({ text }) }), signal: AbortSignal.timeout(240_000) })
  if (!response.ok) throw new Error(`local playtest HTTP ${response.status}; not retried`)
  return await response.json() as PlaytestState
}
const initial = await request('/api/state')
const initialSeq = Number(initial.debug.headSeq)
let latest = initial
const turns: Array<{ round: number; input: string; elapsedMs: number; state: PlaytestState }> = []
for (const [index, input] of prompts.entries()) {
  const started = performance.now()
  latest = await request('/api/submit', input)
  const row = { round: index + 1, input, elapsedMs: performance.now() - started, state: latest }
  turns.push(row)
  appendFileSync(resolve(dataDirectory, 'live-turns.jsonl'), JSON.stringify(row) + '\n')
  console.log(JSON.stringify({ round: row.round, elapsedMs: Math.round(row.elapsedMs), error: latest.error,
    notice: latest.notice, headSeq: latest.debug.headSeq, providerCalls: latest.debug.providerCalls, shadowAudit: latest.debug.shadowAudit }))
}
function worldRows() {
  const db = new DatabaseSync(resolve(dataDirectory, 'world.sqlite'), { readOnly: true })
  try { return db.prepare('SELECT seq, event_type, data_json, event_hash, transaction_id FROM events ORDER BY seq').all() }
  finally { db.close() }
}
const beforeDrain = worldRows()
const publications = beforeDrain.filter(row => {
  if (Number(row.seq) <= initialSeq || row.event_type !== 'character.speak') return false
  const data = JSON.parse(String(row.data_json))
  return String(data.text ?? '').trim() || String(data.narration ?? '').trim()
})
const expected = publications.length * 2
const log = resolve(dataDirectory, 'jev-shadow.jsonl')
const auditRows = (): ShadowRecord[] => existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
const deadline = Date.now() + 60_000
while (auditRows().length < expected && Date.now() < deadline) await delay(250)
const rows = auditRows()
const statuses = Object.fromEntries([...new Set(rows.map(row => row.status))].map(status => [status, rows.filter(row => row.status === status).length]))
const events: RulebookEvent[] = beforeDrain.map(row => ({ eventType: String(row.event_type), eventVersion: 1, data: JSON.parse(String(row.data_json)) }))
const summary = { model: latest.debug.model, rounds: turns.length, failedRounds: turns.filter(row => row.state.error).length,
  providerCalls: latest.debug.providerCalls, publications: publications.length, expectedAuditRecords: expected,
  actualAuditRecords: rows.length, statuses, auditComplete: rows.length === expected,
  unchangedDuringDrain: JSON.stringify(beforeDrain) === JSON.stringify(worldRows()),
  jevModels: [...new Set(rows.map(row => row.answer?.model).filter(Boolean))],
  jevCostUsd: rows.reduce((sum, row) => sum + (row.answer?.costUsd ?? 0), 0),
  keyState: currentEntityState(events, 'entity:brass-key'), thermosState: currentEntityState(events, 'entity:thermos'),
  conflicts: rows.filter(row => row.status === 'CONFLICT').map(row => ({ seq: row.publication?.seq,
    item: row.item?.name, actorId: row.publication?.actorId, narration: row.publication?.narration,
    worldHolder: row.worldHolder, claimedHolder: row.claimedHolder, claims: row.claims })),
  dataDirectory }
writeFileSync(resolve(dataDirectory, 'live-summary.json'), JSON.stringify(summary, null, 2) + '\n')
console.log(JSON.stringify(summary, null, 2))
