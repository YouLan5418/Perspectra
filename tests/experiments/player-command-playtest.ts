import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { WorldJsonObject } from '@harness-world/contracts'
import { currentEntityState } from '@harness-world/kernel'
import { WorldStore } from '@harness-world/store-sqlite'
import { FrozenWorldPlaytestRuntime } from './playtest-frozen-runtime.ts'
import { createClaimClassifier } from './jev-shadow-claims-client.ts'
import type { ShadowRecord } from './jev-shadow.ts'

const directory = resolve(process.argv[2] ?? '')
if (!process.argv[2] || existsSync(directory)) throw new Error('provide a new output directory')
if (!process.env.DEEPSEEK_API_KEY || !process.env.OPENROUTER_JEV_KEY) throw new Error('model keys missing')
mkdirSync(directory, { recursive: true })
const log = (file: string, value: unknown) => appendFileSync(resolve(directory, file), JSON.stringify(value) + '\n')
const records: ShadowRecord[] = []
let round = 0, intentCalls = 0, modelCalls = 0
const nativeFetch = globalThis.fetch
const inputs = ['我拿起日记，准备带走。', '/take entity:diary',
  '/narrate 我把自己保管的日记暂放桌上，仍由我保管。',
  '/give entity:diary character:companion', '陆舟，你把日记放桌上吧。']
writeFileSync(resolve(directory, 'protocol.json'), JSON.stringify({ inputs, model: 'deepseek-flash',
  purpose: 'plain input never chooses controlled player actions; exact commands and autonomous NPC responses',
  shadowOnly: true }, null, 2))
writeFileSync(resolve(directory, 'sources.json'), JSON.stringify(Object.fromEntries([
  'packages/application/src/player-intent-preparation.ts', 'packages/application/src/player-input.ts',
  'packages/application/src/prototype-character-turn.ts', 'tests/experiments/playtest-frozen-runtime.ts',
].map(path => [path, readFileSync(path, 'utf8')])), null, 2))
globalThis.fetch = async (url, init) => {
  const response = await nativeFetch(url, init)
  if (String(url).includes('api.deepseek.com') && typeof init?.body === 'string') {
    modelCalls++
    const body = JSON.parse(init.body)
    if (JSON.stringify(body).includes('player-intent-candidate')) intentCalls++
    log('model-calls.jsonl', { round, request: body, response: await response.clone().json() })
  }
  return response
}
const runtime = await FrozenWorldPlaytestRuntime.create({ dataDirectory: resolve(directory, 'world'),
  packPath: resolve('experiments/jev-narrative-auditor/holdout-2026-09-27/live-pack'),
  provider: 'deepseek', model: 'deepseek-flash', apiKey: process.env.DEEPSEEK_API_KEY,
  shadowAudit: { items: [{ entityId: 'entity:diary', name: '布面日记' }, { entityId: 'entity:pocket-watch', name: '铜怀表' }],
    classify: createClaimClassifier(process.env.OPENROUTER_JEV_KEY),
    write: async record => { records.push(record); log('jev-shadow.jsonl', record) } } })
const store = new WorldStore(resolve(directory, 'world/world.sqlite'))
try {
  for (const input of inputs) {
    round++
    const before = store.head(runtime.address).headSeq
    const state = await runtime.submit(input)
    const events = store.readEvents(runtime.address)
    const delta = events.filter(e => e.seq > before)
    const playerActions = delta.filter(e => e.eventType === 'action.resolved' && (e.data as WorldJsonObject).sourceRole === 'player')
    log('turns.jsonl', { round, input, state, playerActions,
      holderId: currentEntityState(events, 'entity:diary')?.holderId })
    process.stdout.write(`round ${round}: ${playerActions.map(e => String((e.data as WorldJsonObject).actionType)).join(',')}\n`)
  }
  const before = store.head(runtime.address).headSeq
  await runtime.close()
  const events = store.readEvents(runtime.address)
  writeFileSync(resolve(directory, 'events.json'), JSON.stringify(events, null, 2))
  const summary = { rounds: round, intentCalls, modelCalls, shadowRecords: records.length,
    failures: records.filter(r => ['CALL_FAILED', 'AUDIT_FAILED', 'QUEUE_SKIPPED'].includes(r.status)).length,
    costUsd: records.reduce((sum, r) => sum + (r.answer?.costUsd ?? 0), 0),
    shadowWorldUnchanged: before === store.head(runtime.address).headSeq,
    diaryHolder: currentEntityState(events, 'entity:diary')?.holderId }
  writeFileSync(resolve(directory, 'summary.json'), JSON.stringify(summary, null, 2))
  process.stdout.write(JSON.stringify(summary) + '\n')
} finally { globalThis.fetch = nativeFetch; store.close(); await runtime.close() }
