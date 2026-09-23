import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { FrozenWorldPlaytestRuntime } from './playtest-frozen-runtime.ts'

// One continuous world. Run in checkpoints with the same data directory; inspect each checkpoint before continuing.
const inputs = [
  '我有点尴尬地笑了笑。',
  '发生了什么？',
  '同行者，前室桌上的黄铜钥匙你注意到了吗？',
  '同行者，请试着拿起那把钥匙。拿到或没拿到，都告诉我实际结果。',
  '留守者，你也试着拿同一把钥匙；如果不行，就说说你看到的情况。',
  '我试着握住同行者的手，先看她是否愿意。',
  '同行者，你想和我一起去后室看看吗？',
  '我走到后室。',
  '同行者，你看到后室里有什么？',
  '我靠近同行者，低声说：刚才我其实有点紧张。',
  '同行者，钥匙现在在谁手里？刚才究竟发生了什么？',
  '如果钥匙还在你手里，你愿意把它递给我吗？',
  '我回到前室。',
  '留守者，我回来了。刚才后室里发生的事，你亲眼看见了吗？',
  '钥匙不是已经到我手里了吗？',
  '我停下来，看看留守者的表情，不说话。',
  '留守者，你现在最在意的是什么？',
  '我只对留守者低声说：我有点担心同行者，请先别告诉她。',
  '留守者，你觉得同行者现在会怎么做？',
  '我和留守者在前室安静待了一会儿。你想补充什么吗？',
] as const

const dataDirectory = process.argv[2] === undefined ? undefined : resolve(process.argv[2])
const until = Number(process.argv[3] ?? inputs.length)
if (dataDirectory === undefined || !Number.isInteger(until) || until < 1 || until > inputs.length) {
  throw new TypeError('usage: node --import tsx tests/experiments/prototype-g3-run.ts <data-dir> [until-turn:1-20]')
}
if (!process.env.DEEPSEEK_API_KEY) throw new Error('DEEPSEEK_API_KEY is not set in this process')
mkdirSync(dataDirectory, { recursive: true })
const turnsPath = resolve(dataDirectory, 'turns.json')
const turns = existsSync(turnsPath) ? JSON.parse(readFileSync(turnsPath, 'utf8')) as Array<{
  turn: number; input: string; headSeq: number; error: boolean; notice: string;
}> : []
const providerPath = resolve(dataDirectory, 'provider.jsonl')
const originalFetch = globalThis.fetch
let currentTurn = 0
let call = existsSync(providerPath) ? readFileSync(providerPath, 'utf8').split('\n')
  .filter(line => line.includes('"kind":"request"')).length : 0
globalThis.fetch = async (url, init) => {
  if (call >= 180) throw new Error('G3 provider call cap reached')
  call++
  const request = JSON.parse(String(init?.body)) as Record<string, unknown>
  // Request bodies contain the role-visible context needed for an epistemic audit; never log headers or keys.
  appendFileSync(providerPath, JSON.stringify({ kind: 'request', call, turn: currentTurn,
    model: request.model, messages: request.messages, tools: request.tools }) + '\n')
  const response = await originalFetch(url, init)
  const body = await response.clone().text()
  appendFileSync(providerPath, JSON.stringify({ kind: 'response', call, turn: currentTurn,
    status: response.status, body: body.slice(0, 65_536), truncated: body.length > 65_536 }) + '\n')
  return response
}
const runtime = await FrozenWorldPlaytestRuntime.create({ dataDirectory,
  packPath: resolve('examples/world-packs/prototype-g1'), provider: 'deepseek',
  apiKey: process.env.DEEPSEEK_API_KEY, timeoutMs: 45_000 })
try {
  const state = await runtime.state()
  const headSeq = (state.debug as { headSeq: number }).headSeq
  if (turns.length > 0 && headSeq !== turns.at(-1)!.headSeq) {
    throw new Error('world changed after the last recorded checkpoint; inspect it before resuming')
  }
  const last = turns.at(-1)
  const lastCompletedTurn = last?.error && last.notice.includes('这次输入没有提交') ? last.turn - 1 : last?.turn ?? 0
  for (let index = lastCompletedTurn; index < until; index++) {
    currentTurn = index + 1
    const input = inputs[index]!
    const started = Date.now()
    const attempt = turns.filter(value => value.turn === currentTurn).length + 1
    const result = await runtime.submit(input, `prototype-g3:turn:${currentTurn}:attempt:${attempt}`)
    const record = { turn: currentTurn, input, started, durationMs: Date.now() - started,
      headSeq: (result.debug as { headSeq: number }).headSeq, error: result.error,
      notice: result.notice, lastPlayerIntent: result.debug.lastPlayerIntent,
      activationCycle: result.debug.activationCycle, transcript: result.transcript }
    turns.push(record)
    writeFileSync(turnsPath, JSON.stringify(turns, null, 2))
    process.stdout.write(JSON.stringify({ turn: currentTurn, headSeq: record.headSeq, error: record.error,
      notice: record.notice, durationMs: record.durationMs }) + '\n')
    if (result.error) break
  }
} finally {
  await runtime.close()
  globalThis.fetch = originalFetch
}
