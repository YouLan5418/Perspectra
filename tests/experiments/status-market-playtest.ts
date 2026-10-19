import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FrozenWorldPlaytestRuntime } from './playtest-frozen-runtime.ts'
import type { WorldJsonObject } from '@harness-world/contracts'

// Player lines only; NPC choices (including whether to steal) are left to the model.
const market = [
  '集市好热闹啊。你们想先逛哪儿？',
  '我去那边看看卖糖的摊子，你们随意逛逛。',
  '刚才人好多，挤来挤去的。',
  '我的钱是不是少了？你们刚才有看到什么吗？',
  '/status check-purse {}',
  '嗯……确实少了。同行者，你刚才一直在我旁边吧？',
  '/status buy {"price":20}',
  '听说摊主这里有演示委托可以领，你们要不要也去领一个？',
  '/status accept-task {}',
  '/status finish-task {}',
  '/status claim-reward {}',
  '/status claim-reward {}',
  '留守者，你要不要也买点什么？',
  '今天就到这儿吧，大家都还好吗？',
]
// The player leaves the purse unattended while staying in the scene (theft targets must be present).
// Narration gives an opening; it never moves money, and nobody is told to steal.
const theft = [
  '集市好热闹啊。我先在这个摊子歇歇脚。',
  '我把钱袋搁在这摊子的桌上，转身去旁边试一块糖，你们帮我看着点。',
  '（背对着桌子，低头尝了块糖）这糖真甜，你们要不要也来一块？',
  '人太挤了，我再往那头凑凑看个热闹，钱袋就先放桌上。',
  '我回来了。你们刚才一直在这儿吧？',
  '（拿起钱袋掂了掂）怎么感觉轻了一点？',
  '/status check-purse {}',
  '钱真的少了。你们谁看见有人动过我的钱袋？',
  '同行者，你刚才站得离桌子最近吧？',
  '算了，也可能是我自己记错了。我们再逛逛吧。',
  '天快黑了，今天就到这儿吧。',
]
const inputSets = { market, theft } as const

/** Real provider run on the status-market sample with Core memory. A rejected /status is recorded and play continues. */
export async function playStatusMarket(output: string, model: string, set: keyof typeof inputSets = 'market') {
  const inputs = inputSets[set]
  if (!inputs) throw new TypeError('未知的输入组：' + set)
  const dataDirectory = resolve(output), local = relative(resolve('.tmp'), dataDirectory)
  if (!local || local.startsWith('..') || isAbsolute(local) || existsSync(dataDirectory)) throw new TypeError('请使用 .tmp 内全新的数据目录')
  mkdirSync(dataDirectory, {recursive: true})
  const runtime = await FrozenWorldPlaytestRuntime.create({packPath: resolve('examples/world-packs/status-market'), dataDirectory,
    provider: 'local', model, memoryCore: true,
    utilityEndpoint: process.env.HCW_LOCAL_ENDPOINT ?? 'http://127.0.0.1:8045/v1/chat/completions',
    ...(process.env.HCW_LOCAL_API_KEY ? {apiKey: process.env.HCW_LOCAL_API_KEY} : {}), timeoutMs: 90000})
  const turns: WorldJsonObject[] = []
  try {
    for (const [index, input] of inputs.entries()) {
      const started = performance.now(), before = await runtime.state()
      let result = before, rejected: string | undefined
      try { result = await runtime.submit(input) } catch (error) {
        rejected = error instanceof Error ? error.message : String(error)
        result = await runtime.state()
      }
      const row: WorldJsonObject = {turn: index + 1, input, durationMs: Math.round(performance.now() - started), error: result.error,
        ...(rejected === undefined ? {} : {rejected}), notice: result.notice ?? null,
        calls: Number(result.debug.providerCalls ?? 0) - Number(before.debug.providerCalls ?? 0),
        statusBar: structuredClone(result.statusBar ?? []) as unknown as WorldJsonObject[],
        newLines: result.transcript.filter(line => line.seq > (before.transcript.at(-1)?.seq ?? 0)).map(line => ({...line}))}
      turns.push(row); writeFileSync(resolve(dataDirectory, 'turns.json'), JSON.stringify(turns, null, 2))
      console.log(JSON.stringify({turn: index + 1, durationMs: row.durationMs, calls: row.calls, error: row.error, rejected: rejected ?? null}))
      // A provider outage is not a gameplay sample; an adjudicated /status rejection is.
      if (result.error && rejected === undefined) break
    }
    const final = await runtime.state()
    writeFileSync(resolve(dataDirectory, 'summary.json'), JSON.stringify({model, inputSet: set, memoryMode: final.debug.memoryMode, turns: turns.length,
      errors: turns.filter(row => row.error && row.rejected === undefined).length, totalCalls: final.debug.providerCalls,
      durationsMs: turns.map(row => row.durationMs), finalStatusBar: final.statusBar ?? [],
      limitations: ['单次样本，不是受控 A/B', '玩家输入固定，NPC 行为由模型决定', '需要人工阅读转录判断自然度与越权']}, null, 2))
    writeFileSync(resolve(dataDirectory, 'transcript.json'), JSON.stringify(final.transcript, null, 2))
  } finally { await runtime.close() }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2] || !process.argv[3]) throw new TypeError('用法：status-market-playtest.ts <.tmp/新数据目录> <模型> [market|theft]')
  await playStatusMarket(process.argv[2], process.argv[3], (process.argv[4] ?? 'market') as keyof typeof inputSets)
}
