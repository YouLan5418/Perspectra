import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { brandId, type StoredWorldEvent, type WorldAddress, type WorldJsonObject } from '@harness-world/contracts'
import { currentEntityState } from '@harness-world/kernel'
import { WorldStore } from '@harness-world/store-sqlite'
import { FrozenWorldPlaytestRuntime } from './playtest-frozen-runtime.ts'
import { createClaimClassifier } from './jev-shadow-claims-client.ts'
import { JevShadow, type ShadowRecord } from './jev-shadow.ts'

const directory = resolve(process.argv[2] ?? '')
if (!process.argv[2] || existsSync(directory)) throw new Error('provide a new output directory')
mkdirSync(directory, { recursive: true })
const classify = createClaimClassifier(process.env.OPENROUTER_JEV_KEY ?? '')
const sources = ['tests/experiments/jev-shadow-claims-client.ts', 'packages/provider-chat/src/prototype-turn.ts',
  'packages/application/src/character-execution-result.ts', 'tests/experiments/jev-shadow-window.ts']
writeFileSync(resolve(directory, 'sources.json'), JSON.stringify(Object.fromEntries(sources.map(path => [path, readFileSync(path, 'utf8')])), null, 2))
const address: WorldAddress = { tenantId: brandId('custody08', 'TenantId'), worldId: brandId('probe', 'WorldId'), branchId: brandId('main', 'BranchId') }
const characters = [{ characterId: 'char:a', name: '林澄' }, { characterId: 'char:b', name: '陆遥' }]
const items = [{ entityId: 'item:book', name: '蓝封账簿' }]
const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

if (process.argv.includes('--probe')) {
  const cases: { id: string; holder: string | null; narration: string; conflict: boolean; transfer?: [string | null, string | null] }[] = [
    { id: 'table-pages', holder: null, narration: '林澄翻开桌上的蓝封账簿，压住书页看了看封底。', conflict: false },
    { id: 'table-lift', holder: null, narration: '林澄把蓝封账簿托起来看清封面，随即放回原处。', conflict: false },
    { id: 'loan-look', holder: 'char:a', narration: '陆遥从林澄手中接过蓝封账簿看一眼，马上还回；始终由林澄保管。', conflict: false },
    { id: 'release-hand', holder: 'char:a', narration: '林澄把蓝封账簿放在桌上，松开手去倒水，仍负责保管它。', conflict: false },
    { id: 'table-background', holder: 'char:a', narration: '林澄看着桌上的蓝封账簿，暂时没有说话。', conflict: false },
    { id: 'hand-background', holder: 'char:a', narration: '陆遥手里的蓝封账簿翻到末页。', conflict: false },
    { id: 'slide', holder: null, narration: '林澄将蓝封账簿沿桌面挪近灯下，查看纸张。', conflict: false },
    { id: 'intent', holder: 'char:a', narration: '林澄打算把蓝封账簿交给陆遥保管，还没得到回应。', conflict: false },
    { id: 'still-custodian', holder: 'char:a', narration: '蓝封账簿虽放在桌上，仍由林澄保管。', conflict: false },
    { id: 'formal-pocket', holder: null, transfer: [null, 'char:a'], narration: '林澄把蓝封账簿收进自己的随身包，准备带走。', conflict: false },
    { id: 'formal-give', holder: 'char:a', transfer: ['char:a', 'char:b'], narration: '林澄将蓝封账簿交给陆遥保管，陆遥接下这份保管责任。', conflict: false },
    { id: 'formal-release', holder: 'char:a', transfer: ['char:a', null], narration: '林澄不再保管蓝封账簿，把它留在公共柜台供别人取用。', conflict: false },
    { id: 'invent-pocket', holder: null, narration: '林澄把蓝封账簿收进自己的随身包，准备带走。', conflict: true },
    { id: 'invent-give', holder: 'char:a', narration: '林澄将蓝封账簿交给陆遥保管，陆遥接下这份保管责任。', conflict: true },
    { id: 'invent-release', holder: 'char:a', narration: '林澄不再保管蓝封账簿，把它留在公共柜台供别人取用。', conflict: true },
    { id: 'invent-current', holder: 'char:b', narration: '蓝封账簿现由林澄保管，陆遥已经不再负责。', conflict: true },
    { id: 'invent-temporary-custody', holder: 'char:a', narration: '林澄将蓝封账簿交由陆遥保管了一会儿，陆遥完成看守后又正式转交林澄保管。', conflict: true },
    { id: 'implicit-departure', holder: 'char:a', narration: '陆遥把蓝封账簿装进自己的旅行袋，带着它离开了。', conflict: true },
  ]
  const results: { id: string; repeat: number; expectedConflict: boolean; actualConflict: boolean; record: ShadowRecord }[] = []
  writeFileSync(resolve(directory, 'protocol.json'), JSON.stringify({ scope: 'custody, not physical handling', repeats: 2, cases, noTuning: true }, null, 2))
  for (let repeat = 1; repeat <= 2; repeat++) for (const sample of cases) {
    const events: StoredWorldEvent[] = []
    const add = (eventType: string, data: WorldJsonObject, tx = events.length + 1) => {
      const seq = events.length + 1
      events.push({ address, seq, eventType, data, eventVersion: 1, tick: tx,
        eventHash: `sha256:${'0'.repeat(64)}`, previousHash: 'genesis',
        transactionId: brandId(`tx:${tx}`, 'TransactionId'), eventOrdinal: 0 })
    }
    for (const c of characters) add('character.created', { ...c, locationId: 'room' })
    add('entity.upsert', { entityId: items[0]!.entityId, kind: 'book', locationId: 'room' })
    const transfer = (from: string | null, to: string | null, tx?: number) => add('entity.transferred', {
      entityId: items[0]!.entityId, fromHolderId: from, fromLocationId: from === null ? 'room' : null,
      toHolderId: to, toLocationId: to === null ? 'room' : null, characterId: from ?? to!, interactionId: 'base:give',
    }, tx)
    if (sample.holder) transfer(null, sample.holder)
    const initialSeq = events.length, tx = initialSeq + 1
    if (sample.transfer) transfer(...sample.transfer, tx)
    add('character.speak', { characterId: 'char:a', text: '', narration: sample.narration }, tx)
    const before = sha(events)
    const shadow = new JevShadow({ address, characters, items, initialSeq, classify, readEvents: seq => events.slice(0, seq), write: async record => {
      const row = { id: sample.id, repeat, expectedConflict: sample.conflict,
        actualConflict: record.status === 'CONFLICT', record }
      results.push(row); appendFileSync(resolve(directory, 'results.jsonl'), JSON.stringify(row) + '\n')
    } })
    shadow.observe(events.length); await shadow.close()
    if (before !== sha(events)) throw new Error('audit modified fixture')
    console.log(JSON.stringify({ id: sample.id, repeat, status: results.at(-1)?.record.status }))
  }
  writeFileSync(resolve(directory, 'summary.json'), JSON.stringify({ cases: cases.length, calls: results.length,
    positives: results.filter(r => r.expectedConflict).length,
    detected: results.filter(r => r.expectedConflict && r.actualConflict).length,
    negatives: results.filter(r => !r.expectedConflict).length,
    falseAlerts: results.filter(r => !r.expectedConflict && r.actualConflict).map(r => ({ id: r.id, repeat: r.repeat })),
    failures: results.filter(r => r.record.status === 'CALL_FAILED').length,
    unresolved: results.filter(r => r.record.status === 'UNCERTAIN').map(r => ({ id: r.id, repeat: r.repeat })),
    costUsd: results.reduce((s, r) => s + (r.record.answer?.costUsd ?? 0), 0), unchangedDuringAudit: true }, null, 2))
} else {
  const liveItems = [{ entityId: 'entity:pocket-watch', name: '铜怀表' }, { entityId: 'entity:diary', name: '布面日记' }]
  const key = process.env.DEEPSEEK_API_KEY
  if (!key) throw new Error('DEEPSEEK_API_KEY missing')
  const records: ShadowRecord[] = []
  const runtime = await FrozenWorldPlaytestRuntime.create({ dataDirectory: resolve(directory, 'world'),
    packPath: resolve('experiments/jev-narrative-auditor/holdout-2026-09-27/live-pack'),
    provider: 'deepseek', model: 'deepseek-flash', apiKey: key, shadowAudit: { items: liveItems, classify,
      write: async record => { records.push(record); appendFileSync(resolve(directory, 'jev-shadow.jsonl'), JSON.stringify(record) + '\n') } } })
  const action = (definition: string, recipientId?: string) => '/act interact ' + JSON.stringify({
    targetRef: { kind: 'entity', id: 'entity:diary' }, bindingId: `binding:diary-${definition}`,
    definitionRef: { id: `base:${definition}`, version: 1 }, arguments: recipientId ? { recipientId } : {},
  })
  const prompts = [
    '陆舟，请翻开桌上的布面日记看看夹页；程雨把桌上的铜怀表翻一面看看。不用替大家保管它们。',
    action('take'),
    '日记现在由我保管。陆舟，你可以临时托起来看看封底再放回，保管人仍是我。程雨说说你看到什么。',
    '我把日记暂放桌上，仍由我保管。程雨可以翻一页看看，陆舟说说线索。',
    action('give', 'character:companion'),
    '陆舟，日记现在由你保管，可以暂放桌上。程雨只翻页查看，不接管，也不用改变保管关系。',
    '陆舟，请把日记转交程雨保管。程雨，你愿意接下保管责任吗？',
    '程雨，如果日记已由你保管，请解除个人保管，把它留在失物台供其他人取用。否则说说当前情况。',
    '陆舟，请取得铜怀表的保管，把它收进随身口袋，暂时不要离开房间。',
    '陆舟，请把铜怀表转交程雨保管。程雨，你接下以后说说想法。',
    '程雨，如果怀表已由你保管，请解除个人保管，留在失物台供其他人取用。',
    '分别回顾日记和怀表：谁只是翻页或临时查看，谁正式负责保管，谁后来转交或解除保管？现在由谁保管？',
  ]
  writeFileSync(resolve(directory, 'protocol.json'), JSON.stringify({ prompts, mode: 'shadow-only', model: 'deepseek-flash',
    packPath: 'experiments/jev-narrative-auditor/holdout-2026-09-27/live-pack', noRewrite: true, rounds: prompts.length }, null, 2))
  const store = new WorldStore(resolve(directory, 'world/world.sqlite'))
  const read = () => store.readEvents(runtime.address)
  const initialSeq = read().length
  let failedRounds = 0
  const latencyMs: number[] = []
  try {
    for (const [index, input] of prompts.entries()) {
      const start = performance.now()
      const state = await runtime.submit(input.startsWith('/act') ? input : '/act speak ' + JSON.stringify({ text: input }))
      latencyMs.push(Math.round(performance.now() - start)); if (state.error) failedRounds++
      const row = { round: index + 1, input, elapsedMs: latencyMs.at(-1), state }
      appendFileSync(resolve(directory, 'turns.jsonl'), JSON.stringify(row) + '\n')
      console.log(JSON.stringify({ round: index + 1, headSeq: state.debug.headSeq, error: state.error, calls: state.debug.providerCalls }))
    }
    const final = await runtime.state(), before = sha(read())
    await runtime.close()
    const events = read(), unchangedDuringAuditDrain = before === sha(events)
    writeFileSync(resolve(directory, 'events.json'), JSON.stringify(events, null, 2))
    const publications = events.filter(e => e.seq > initialSeq && e.eventType === 'character.speak')
      .filter(e => { const d = e.data as WorldJsonObject; return String(d.text ?? '').trim() || String(d.narration ?? '').trim() })
    const summary = { rounds: prompts.length, failedRounds, providerCalls: final.debug.providerCalls,
      npcPublications: publications.filter(e => (e.data as WorldJsonObject).characterId !== 'character:player').length,
      expectedRecords: publications.length * liveItems.length, records: records.length,
      auditComplete: records.length === publications.length * liveItems.length, unchangedDuringAuditDrain, latencyMs,
      conflicts: records.filter(r => r.status === 'CONFLICT').map(r => ({ seq: r.publication?.seq, item: r.item?.entityId,
        narration: r.publication?.narration, claims: r.claims.filter(c => c.status === 'CONFLICT'), placement: r.placement })),
      failures: records.filter(r => ['CALL_FAILED', 'AUDIT_FAILED', 'QUEUE_SKIPPED'].includes(r.status)).length,
      costUsd: records.reduce((s, r) => s + (r.answer?.costUsd ?? 0), 0),
      formalTransfers: events.filter(e => e.eventType === 'entity.transferred'),
      finalItems: liveItems.map(item => currentEntityState(events, item.entityId)) }
    writeFileSync(resolve(directory, 'summary.json'), JSON.stringify(summary, null, 2))
    console.log(JSON.stringify({ rounds: summary.rounds, records: records.length, conflicts: summary.conflicts.length, failures: summary.failures }))
  } finally { await runtime.close(); store.close() }
}
