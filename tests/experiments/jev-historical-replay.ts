import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { currentEntityState, type RulebookEvent } from '@harness-world/kernel'
import { createHolderClassifier } from './jev-shadow-client.ts'
import type { AuditItem, HolderQuestion, Publication } from './jev-shadow.ts'

const folder = resolve('experiments/jev-narrative-auditor/historical-replay-2026-09-26')
mkdirSync(folder, { recursive: true })
const key: AuditItem = { entityId: 'entity:brass-key', name: '黄铜钥匙', aliases: ['钥匙'] }
const thermos: AuditItem = { entityId: 'entity:thermos', name: '保温杯' }
const phone: AuditItem = { entityId: 'entity:phone', name: '手机' }
const charger: AuditItem = { entityId: 'entity:charger', name: '充电器' }
const old = 'D:/DeepSeek Harness/harness-cordis-world-prototype/.tmp/'
const action = 'D:/DeepSeek Harness/Perspectra Action First/.tmp/'
const sources = {
  free: old + 'g3-free-20260923/world.sqlite',
  continuous: old + 'g3-continuous-b-20260923/world.sqlite',
  actionA: action + 'frozen-playtest-drive-2026-09-25T14-34-41-090Z/world.sqlite',
  actionB: action + 'frozen-playtest-drive-2026-09-25T14-35-06-846Z/world.sqlite',
  girls: resolve('.tmp/frozen-playtest-drive-2026-09-25T18-22-07-893Z/world.sqlite'),
  live: resolve('.tmp/jev-shadow-live-20260926-122621/world.sqlite'),
}
type Source = keyof typeof sources
type Risk = 'terminal-conflict' | 'unbacked-history' | 'control' | 'borderline'
const selected: Array<{ source: Source; seq: number; item: AuditItem; risk: Risk; note: string }> = []
const add = (source: Source, seq: number, item: AuditItem, risk: Risk, note: string) => selected.push({ source, seq, item, risk, note })
for (const seq of [54, 94, 105, 128, 151]) add('free', seq, key, 'control', '真实持有、观察、邀请或获正式事件支持的回述')
add('free', 139, key, 'unbacked-history', '旁白让留守者在指间翻钥匙并递回；她从未正式持有过钥匙')
for (const seq of [156, 221, 226, 242, 247]) add('free', seq, key, 'unbacked-history', '继续回述留守者曾接收并归还钥匙；正式事件无此历史；226/247 改写递出者')
for (const seq of [100, 105, 111]) add('continuous', seq, key, 'control', '正式拿取 seq94 后的持有表达')
add('actionA', 26, key, 'terminal-conflict', '旁白完成拿取；正式拿取在后续另一提交 seq37 才发生')
add('actionA', 43, key, 'control', '正式拿取 seq37 后表达')
for (const seq of [32, 58]) add('actionB', seq, key, 'control', '正式拿取 seq26 后表达')
for (const item of [phone, charger]) add('girls', 156, item, 'terminal-conflict', 'GLM 旁白拿起手机和充电器；当时两者仍无人持有，稍后才有正式动作')
for (const item of [phone, charger]) add('girls', 215, item, 'control', '手机与充电器正式由玩家持有')
for (const seq of [340, 383, 412, 535]) add('girls', seq, phone, 'control', '手机正式由 DeepSeek 持有；含对白对他人旧说法的纠正')
add('live', 157, key, 'borderline', '递过去加对白给你，但未确认接收；不计入确定缺陷召回率')
add('live', 184, key, 'control', '留守者手中钥匙与正式状态一致')
for (const seq of [128, 133]) add('live', seq, thermos, 'control', '只观察保温杯，没有完成拿取')

interface ReplayCase {
  readonly id: string
  readonly sourcePath: string
  readonly sourceDigest: string
  readonly sourceEventHash: string
  readonly preHeadSeq: number
  readonly postHeadSeq: number
  readonly question: HolderQuestion
  readonly publishedHistory: readonly Publication[]
  readonly worldHolder: string | null
  readonly officialTransfers: readonly { seq: number; from: string | null; to: string | null }[]
  readonly gold: { risk: Risk; note: string }
}
function extract(): ReplayCase[] {
  return selected.map(selection => {
    const sourcePath = sources[selection.source]
    const db = new DatabaseSync(sourcePath, { readOnly: true })
    try {
      const keys = db.prepare('SELECT DISTINCT address_key FROM events').all()
      if (keys.length !== 1) throw new Error('select a branch explicitly before extracting')
      const rows = db.prepare(`SELECT seq, event_type, data_json, transaction_id, event_hash FROM events
        WHERE event_type IN ('character.created','character.upsert','character.speak','entity.upsert','entity.transferred','entity.taken') ORDER BY seq`).all()
      const selectedRow = rows.find(row => Number(row.seq) === selection.seq)
      if (selectedRow?.event_type !== 'character.speak') throw new Error('selected publication missing')
      const bounds = db.prepare('SELECT MIN(seq) AS first,MAX(seq) AS last FROM events WHERE transaction_id = ?').get(selectedRow.transaction_id!)!
      const postHeadSeq = Number(bounds.last), preHeadSeq = Number(bounds.first) - 1
      const prefix = rows.filter(row => Number(row.seq) <= postHeadSeq)
      const events: RulebookEvent[] = prefix.map(row => ({ eventType: String(row.event_type), eventVersion: 1, data: JSON.parse(String(row.data_json)) }))
      const characters = prefix.filter(row => ['character.created', 'character.upsert'].includes(String(row.event_type)))
        .map(row => { const data = JSON.parse(String(row.data_json)); return { characterId: String(data.characterId), name: String(data.name ?? data.characterId) } })
      const publication = (row: typeof selectedRow): Publication => {
        const data = JSON.parse(String(row.data_json))
        return { seq: Number(row.seq), actorId: String(data.characterId), speech: String(data.text ?? ''), narration: String(data.narration ?? '') }
      }
      const pub = publication(selectedRow)
      const publishedHistory = rows.filter(row => row.event_type === 'character.speak' && Number(row.seq) < selection.seq).slice(-12).map(publication)
      const officialTransfers = prefix.filter(row => ['entity.transferred', 'entity.taken'].includes(String(row.event_type)))
        .flatMap(row => { const data = JSON.parse(String(row.data_json)); return data.entityId === selection.item.entityId
          ? [{ seq: Number(row.seq), from: data.fromHolderId ?? null, to: data.toHolderId ?? data.characterId }] : [] })
      const worldHolder = currentEntityState(events, selection.item.entityId)?.holderId
      if (worldHolder === undefined) throw new Error('selected item missing')
      if (selection.risk === 'unbacked-history' && officialTransfers.some(edge => edge.to === 'character:friend')) throw new Error('historical gold contradicted by official transfer')
      return { id: `${selection.source}:${selection.seq}:${selection.item.entityId}`, sourcePath,
        sourceDigest: createHash('sha256').update(JSON.stringify(rows)).digest('hex'), sourceEventHash: String(selectedRow.event_hash),
        preHeadSeq, postHeadSeq, question: { item: selection.item,
          items: selection.source === 'girls' ? [phone, charger] : [key, thermos], characters, publication: pub },
        publishedHistory, worldHolder, officialTransfers, gold: { risk: selection.risk, note: selection.note } }
    } finally { db.close() }
  })
}

const traceCriteria = {
  '叙事交接事实': '最新客观旁白确认拿取、交付、接收、放入另一人的掌控范围，或出现需要持有目标物品才能完成的操作及归还。即使最后回到原持有人，中途持有仍算。仅看某人已持有或在自己的手内移动不算新的交接。',
  '对白交接回述': '最新对白、引用、思想或传闻声称已经发生过目标物品交接，客观旁白未确认该交接。只识别声称，不证明它是真的，也不推断角色内在信念。',
  '意图或未完成尝试': '最新表达只邀请、打算、递出、伸手，未确认接收或完成持有；明确没有交付也归这里。',
  '无交接宣称': '最新表达未声称目标物品交接；包括只观察、描述当前持有、同一持有人在自己手内翻转、纯假设。',
  '无法判断': '无法确定目标物品或交接表达的含义。',
}
const evolutionCriteria = {
  '未延续交接经过': '最新表达没有沿用、确认、改写或否定此前某段交接经过；仅提当前持有者不算。',
  '沿用交接经过': '最新表达再次声称先前出现的交接经过，包括另一位角色确认；不判断经过是否真实。',
  '改写交接来源或经过': '最新表达把此前同一段交接的递出者、接收者或先后过程换成另一种说法。',
  '否定或撤回交接': '最新表达明确否认或撤回先前声称的交接。',
  '无法判断': '文本不足以确定是否在回述同一段交接。',
}
function diagnosticBody(sample: ReplayCase) {
  // Explicit projection: no gold, source path, hashes, official event facts, holder state, or private contexts.
  return { model: 'typesafe/jev-1.13', state: {
    target: sample.question.item, items: sample.question.items, characters: sample.question.characters,
    latest: sample.question.publication, earlierPublications: sample.publishedHistory,
  }, questions: {
    transfer_trace: { type: 'choice', instructions: '只解释 latest 对 target 的交接宣称。earlierPublications 是按 seq 排列的真实已发布表达，仅帮助解指代和比较交接过程；speech 是角色对白，narration 是旁白。别依据故事是否可信决定有没有宣称，不判断权威世界真假。', criteria: traceCriteria },
    story_evolution: { type: 'choice', instructions: '比较 latest 与 earlierPublications 对 target 的交接说法。只识别公开叙事如何延续或变化，不推断角色私有认知，不判定世界事实。', criteria: evolutionCriteria },
  } }
}
function validateDiagnostic(input: unknown) {
  const body = input as { model?: string; answers?: Record<string, { type?: string; choice?: string; probabilities?: Record<string, number> }>; usage?: unknown }
  if (typeof body.model !== 'string') throw new Error('invalid model response')
  for (const [name, criteria] of Object.entries({ transfer_trace: traceCriteria, story_evolution: evolutionCriteria })) {
    const answer = body.answers?.[name], labels = Object.keys(criteria)
    if (answer?.type !== 'choice' || !answer.choice || !labels.includes(answer.choice) || !answer.probabilities
      || labels.some(label => !Number.isFinite(answer.probabilities![label]) || answer.probabilities![label]! < 0 || answer.probabilities![label]! > 1)
      || Math.abs(labels.reduce((sum, label) => sum + answer.probabilities![label]!, 0) - 1) > 0.02) throw new Error('invalid diagnostic choice')
  }
  return body
}

if (process.argv.includes('--extract')) {
  const samples = extract()
  writeFileSync(resolve(folder, 'cases.json'), JSON.stringify(samples, null, 2) + '\n')
  writeFileSync(resolve(folder, 'diagnostic-requests.jsonl'), samples.map(sample => JSON.stringify(diagnosticBody(sample))).join('\n') + '\n')
  console.log(JSON.stringify({ samples: samples.length, groups: Object.fromEntries(['terminal-conflict','unbacked-history','control','borderline'].map(risk => [risk, samples.filter(sample => sample.gold.risk === risk).length])), folder }))
} else {
  const samples = JSON.parse(readFileSync(resolve(folder, 'cases.json'), 'utf8')) as ReplayCase[]
  const outputIndex = process.argv.indexOf('--output')
  const output = outputIndex === -1 ? resolve(folder, 'results.jsonl') : process.argv[outputIndex + 1]
  if (!output || output.startsWith('--')) throw new Error('--output requires a new JSONL path')
  if (existsSync(output)) throw new Error('result file already exists; choose a new --output path for a repeat')
  const apiKey = process.env.OPENROUTER_JEV_KEY ?? ''
  const classify = createHolderClassifier(apiKey)
  let index = 0
  const results: unknown[] = []
  await Promise.all(Array.from({ length: 3 }, async () => {
    while (index < samples.length) {
      const sample = samples[index++]!
      let terminal: unknown, diagnostic: unknown
      try {
        const answer = await classify(sample.question)
        const claimedHolder = answer.choice.startsWith('holder:') ? answer.choice.slice('holder:'.length) : null
        terminal = { answer, verdict: ['NO_CLAIM', 'SPEECH_ONLY'].includes(answer.choice) ? 'NO_CLAIM'
          : answer.choice === 'UNCERTAIN' ? 'UNCERTAIN' : claimedHolder === sample.worldHolder ? 'SUPPORTED' : 'CONFLICT' }
      } catch { terminal = { error: 'terminal call failed' } }
      try {
        const response = await fetch('https://openrouter.ai/api/alpha/decisions', { method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(diagnosticBody(sample)), signal: AbortSignal.timeout(10_000) })
        if (!response.ok) throw new Error('diagnostic HTTP error')
        diagnostic = validateDiagnostic(await response.json())
      } catch { diagnostic = { error: 'diagnostic call failed' } }
      const row = { id: sample.id, gold: sample.gold, terminal, diagnostic }
      results.push(row)
      appendFileSync(output, JSON.stringify(row) + '\n')
      const terminalSummary = terminal as { verdict?: string; error?: string }
      const diagnosticSummary = diagnostic as { answers?: Record<string, { choice?: string }>; error?: string }
      console.log(JSON.stringify({ completed: results.length, total: samples.length, id: sample.id,
        terminal: terminalSummary.verdict ?? terminalSummary.error,
        trace: diagnosticSummary.answers?.transfer_trace?.choice ?? diagnosticSummary.error,
        evolution: diagnosticSummary.answers?.story_evolution?.choice }))
    }
  }))
}
