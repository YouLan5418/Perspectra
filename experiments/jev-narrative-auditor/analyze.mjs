import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
const labels = ['无状态变化', '意图', '尝试', '角色陈述', '叙事事实']
const cases = JSON.parse(readFileSync(new URL('./cases.json', import.meta.url), 'utf8'))
const stressCases = JSON.parse(readFileSync(new URL('./stress-cases.json', import.meta.url), 'utf8'))
const byId = new Map([...cases, ...stressCases].map(entry => [entry.编号, entry]))
const path = resolve(process.argv[2] ?? '.tmp/jev-narrative-auditor-results.jsonl')
const rows = readFileSync(path, 'utf8').split('\n').filter(Boolean).map(JSON.parse)
const unique = new Map(rows.map(row => [`${row.mode}:${row.id}:${row.repeat}`, row]))
const all = [...unique.values()]
const percentile = (values, p) => {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.ceil((p / 100) * sorted.length) - 1]
}
const round = value => Math.round(value * 10000) / 10000
const money = value => Math.round(value * 100000000) / 100000000
function summary(rows) {
 const valid = rows.filter(row => row.ok)
 const matrix = Object.fromEntries(labels.map(gold => [gold, Object.fromEntries(labels.map(pred => [pred, 0]))]))
 for (const row of valid) matrix[row.gold][row.prediction]++
 const correct = valid.filter(row => row.gold === row.prediction).length
 const facts = valid.filter(row => row.gold === '叙事事实')
 const nonfacts = valid.filter(row => row.gold !== '叙事事实')
 const subjective = valid.filter(row => row.gold === '角色陈述')
 const errors = valid.filter(row => row.gold !== row.prediction).map(row => ({
   id: row.id, gold: row.gold, prediction: row.prediction,
   probability: row.probabilities[row.prediction],
   factProbability: row.probabilities['叙事事实'],
   text: byId.get(row.id)?.文本,
 }))
 return {
  expected: rows.length, success: valid.length, failures: rows.filter(row => !row.ok).map(row => row.id),
  accuracy: valid.length ? round(correct / valid.length) : null,
  factRecall: facts.length ? round(facts.filter(row => row.prediction === '叙事事实').length / facts.length) : null,
  factFalsePositiveRate: nonfacts.length ? round(nonfacts.filter(row => row.prediction === '叙事事实').length / nonfacts.length) : null,
  subjectiveAsFactRate: subjective.length ? round(subjective.filter(row => row.prediction === '叙事事实').length / subjective.length) : null,
  matrix, errors,
  latencyMs: { mean: valid.length ? Math.round(valid.reduce((s, row) => s + row.latencyMs, 0) / valid.length) : null,
   median: percentile(valid.map(row => row.latencyMs), 50), p95: percentile(valid.map(row => row.latencyMs), 95) },
  usage: { calls: valid.length,
   inputTokens: valid.reduce((s, row) => s + (row.inputTokens ?? 0), 0),
   outputTokens: valid.reduce((s, row) => s + (row.outputTokens ?? 0), 0),
   costUsd: money(valid.reduce((s, row) => s + (row.costUsd ?? 0), 0)),
   meanCostUsd: valid.length ? money(valid.reduce((s, row) => s + (row.costUsd ?? 0), 0) / valid.length) : null },
 }
}
const text = all.filter(row => row.mode === 'text')
const holder = all.filter(row => row.mode === 'holder')
const repeat = all.filter(row => row.mode === 'repeat')
const stressText = all.filter(row => row.mode === 'stress_text')
const stressHolder = all.filter(row => row.mode === 'stress_holder')
const textById = new Map(text.filter(row => row.ok).map(row => [row.id, row]))
const holderById = new Map(holder.filter(row => row.ok).map(row => [row.id, row]))
const paired = cases.filter(entry => textById.has(entry.编号) && holderById.has(entry.编号)).map(entry => ({
 id: entry.编号, gold: entry.人工标签, text: textById.get(entry.编号).prediction,
 holder: holderById.get(entry.编号).prediction,
}))
const repeatById = Map.groupBy(repeat.filter(row => row.ok), row => row.id)
const repeated = [...repeatById].map(([id, entries]) => {
 const counts = Object.fromEntries(labels.map(label => [label, entries.filter(entry => entry.prediction === label).length]))
 const factProbabilities = entries.map(entry => entry.probabilities['叙事事实'])
 return { id, gold: entries[0].gold, count: entries.length, choices: counts,
  majorityShare: Math.max(...Object.values(counts)) / entries.length,
  factProbabilityMin: Math.min(...factProbabilities), factProbabilityMax: Math.max(...factProbabilities),
  text: byId.get(id)?.文本 }
})
const completeRepeated = repeated.filter(row => row.count === 5)
const result = {
 dataset: { count: cases.length + stressCases.length,
  initialCount: cases.length, stressCount: stressCases.length,
  counts: Object.fromEntries(labels.map(label => [label, [...cases, ...stressCases]
    .filter(entry => entry.人工标签 === label).length])) },
 text: summary(text), holder: summary(holder), repeat: summary(repeat),
 stressText: summary(stressText), stressHolder: summary(stressHolder),
 paired: { count: paired.length, improved: paired.filter(row => row.text !== row.gold && row.holder === row.gold),
  worsened: paired.filter(row => row.text === row.gold && row.holder !== row.gold),
  changed: paired.filter(row => row.text !== row.holder) },
 stability: { sampleCount: completeRepeated.length,
  allFiveSame: completeRepeated.filter(row => row.majorityShare === 1).length,
  meanMajorityShare: completeRepeated.length ? round(completeRepeated.reduce((s, row) => s + row.majorityShare, 0) / completeRepeated.length) : null,
  variable: completeRepeated.filter(row => row.majorityShare < 1) },
}
const out = resolve('.tmp/jev-narrative-auditor-summary.json')
writeFileSync(out, JSON.stringify(result, null, 2) + '\n', 'utf8')
console.log(JSON.stringify({
 dataset: result.dataset,
 text: { ...result.text, errors: result.text.errors.slice(0, 20) },
 holder: { ...result.holder, errors: result.holder.errors.slice(0, 20) },
 stressText: result.stressText, stressHolder: result.stressHolder,
 paired: { count: result.paired.count, improved: result.paired.improved.length,
  worsened: result.paired.worsened.length, changed: result.paired.changed.length },
 stability: { ...result.stability, variable: result.stability.variable.slice(0, 30) },
}, null, 2))
