import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'

const LABELS = ['无状态变化', '意图', '尝试', '角色陈述', '叙事事实']
const syntheticCases = JSON.parse(readFileSync(new URL('./cases.json', import.meta.url), 'utf8'))
const stressCases = JSON.parse(readFileSync(new URL('./stress-cases.json', import.meta.url), 'utf8'))
const MODE = process.argv.includes('--mode') ? process.argv[process.argv.indexOf('--mode') + 1] : 'text'
const OUT = resolve(process.argv.includes('--output') ? process.argv[process.argv.indexOf('--output') + 1]
  : '.tmp/jev-narrative-auditor-results.jsonl')
const LIMIT = process.argv.includes('--limit') ? Number(process.argv[process.argv.indexOf('--limit') + 1]) : Infinity
const CONCURRENCY = process.argv.includes('--concurrency') ? Number(process.argv[process.argv.indexOf('--concurrency') + 1]) : 4
if (!['text', 'holder', 'repeat', 'stress_text', 'stress_holder'].includes(MODE)) {
  throw new Error('mode must be text, holder, repeat, stress_text, or stress_holder')
}
const CASES = MODE.startsWith('stress_') ? stressCases : syntheticCases
if (!Number.isInteger(CONCURRENCY) || CONCURRENCY < 1 || CONCURRENCY > 8) throw new Error('concurrency must be 1..8')
if (!(LIMIT > 0)) throw new Error('limit must be positive')
const apiKey = process.env.OPENROUTER_JEV_KEY?.trim()
if (!apiKey) throw new Error('OPENROUTER_JEV_KEY unavailable in this process')
const counts = Object.fromEntries(LABELS.map(label => [label, 0]))
for (const entry of CASES) {
  if (!LABELS.includes(entry.人工标签) || typeof entry.文本 !== 'string' || !entry.目标物品 || !entry.当前持有者) {
    throw new Error(`invalid labeled case: ${entry.编号}`)
  }
  counts[entry.人工标签]++
}
if (MODE.startsWith('stress_')) {
  if (CASES.length !== 50 || Object.values(counts).some(count => count !== 10)) throw new Error('expected 10 stress cases per class')
} else if (CASES.length !== 100 || Object.values(counts).some(count => count !== 20)) {
  throw new Error('expected 20 labeled cases per class')
}
const repeatPositions = new Set([0, 2, 4, 8, 12, 19])
const jobs = MODE === 'repeat'
  ? CASES.filter((_entry, index) => repeatPositions.has(index % 20))
    .flatMap(entry => Array.from({ length: 5 }, (_, repeat) => ({ entry, repeat: repeat + 1 })))
  : CASES.map(entry => ({ entry, repeat: 1 }))
const selected = jobs.slice(0, LIMIT)
mkdirSync(dirname(OUT), { recursive: true })
const completed = new Set(existsSync(OUT) ? readFileSync(OUT, 'utf8').split('\n').filter(Boolean)
  .map(line => JSON.parse(line)).filter(row => row.ok === true)
  .map(row => `${row.mode}:${row.id}:${row.repeat}`) : [])
const pending = selected.filter(job => !completed.has(`${MODE}:${job.entry.编号}:${job.repeat}`))
const criteria = {
  '无状态变化': '目标物品没有被描述为发生本轮持有关系转移。包括观察、同一人左右手或自身口袋移动、否定、纯假设或条件，以及仅转移其他物品。',
  '意图': '仅想、准备、打算或计划转交目标物品，尚未开始交付；未来承诺或尚未执行的对白也归这里。',
  '尝试': '已开始向他人交付、递出或试图拿取目标物品，但文本未确认新持有人成功取得；包括被阻止、拒收、收回。',
  '角色陈述': '目标物品已转移只存在于角色的对白、猜测、思想、梦境、传闻、日记或回忆中；客观旁白并未确认本轮真的完成。',
  '叙事事实': '客观叙述明确确认目标物品在本轮已由另一人持有或保管，即使没有写交付动词；接收、拿走、放入他人包内、多次交付均算。',
}
function requestBody(entry) {
  return {
    model: 'typesafe/jev-1.13',
    state: {
      '目标物品': entry.目标物品,
      ...(['holder', 'stress_holder'].includes(MODE) ? { '当前持有者': entry.当前持有者 } : {}),
      '文本': entry.文本,
    },
    questions: {
      transfer_kind: {
        type: 'choice',
        instructions: '针对`目标物品`，判断`文本`如何描述本轮持有关系变化。只给一句话的最合适类别。'
          + (['holder', 'stress_holder'].includes(MODE) ? ' `当前持有者`仅帮助识别持有人；不要据此把文本声称的事实当作真实事件。' : ''),
        criteria,
      },
    },
  }
}
function validateAnswer(body) {
  const answer = body?.answers?.transfer_kind
  if (answer?.type !== 'choice' || !LABELS.includes(answer.choice)
    || !answer.probabilities || LABELS.some(label => !Number.isFinite(answer.probabilities[label])
      || answer.probabilities[label] < 0 || answer.probabilities[label] > 1)
    || Math.abs(LABELS.reduce((sum, label) => sum + answer.probabilities[label], 0) - 1) > 0.02) {
    throw new Error('invalid Jev choice response')
  }
  return answer
}
const sleep = milliseconds => new Promise(done => setTimeout(done, milliseconds))
async function call(job) {
  const started = performance.now()
  let lastError
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch('https://openrouter.ai/api/alpha/decisions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody(job.entry)),
        signal: AbortSignal.timeout(30_000),
      })
      if (!response.ok) {
        const body = await response.text()
        const error = new Error(`HTTP ${response.status}: ${body.slice(0, 300)}`)
        if (![429, 500, 502, 503, 504].includes(response.status)) throw error
        lastError = error
        await sleep(600 * attempt)
        continue
      }
      const body = await response.json()
      const answer = validateAnswer(body)
      return {
        ok: true, mode: MODE, id: job.entry.编号, repeat: job.repeat,
        gold: job.entry.人工标签, prediction: answer.choice,
        probabilities: answer.probabilities, confidence: answer.confidence,
        latencyMs: Math.round(performance.now() - started),
        inputTokens: body.usage?.input_tokens ?? null,
        outputTokens: body.usage?.output_tokens ?? null,
        costUsd: body.usage?.cost ?? null,
        model: body.model ?? null, response: body,
      }
    } catch (error) {
      lastError = error
      if (attempt < 3) await sleep(600 * attempt)
    }
  }
  return { ok: false, mode: MODE, id: job.entry.编号, repeat: job.repeat,
    gold: job.entry.人工标签, latencyMs: Math.round(performance.now() - started),
    error: String(lastError?.message ?? lastError).replace(/Bearer\s+\S+/g, 'Bearer [redacted]') }
}
let next = 0
let succeeded = 0
let failed = 0
async function worker() {
  while (next < pending.length) {
    const job = pending[next++]
    const result = await call(job)
    appendFileSync(OUT, JSON.stringify(result) + '\n', 'utf8')
    if (result.ok) succeeded++
    else { failed++; console.error(`failed ${result.mode}:${result.id}:${result.repeat} ${result.error}`) }
    if ((succeeded + failed) % 25 === 0 || succeeded + failed === pending.length) {
      console.log(`${MODE}: ${succeeded + failed}/${pending.length} newly attempted, ${failed} failures`)
    }
  }
}
console.log(`Jev ${MODE}: ${selected.length} selected, ${pending.length} pending; output=${OUT}`)
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pending.length) }, () => worker()))
if (failed) process.exitCode = 1
