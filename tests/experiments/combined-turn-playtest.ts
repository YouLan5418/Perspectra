import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { WorldJsonObject } from '@harness-world/contracts'
import { WorldHostRuntime } from '../../desktop/host/world-runtime.ts'
import { projectPlayerView } from '../../desktop/host/frontend-adapter.ts'
import type { HostState, PlayerLine } from '../../desktop/host/http-server.ts'

type Option = ReturnType<typeof projectPlayerView>['actions'][number]
const COMPANION = 'character:companion'
const definition = (option: Option) => String((option.action.parameters.definitionRef as WorldJsonObject | undefined)?.id)
const say = (text: string, order: PlayerLine['order'] = 'before'): PlayerLine => ({
  speech: { text, scope: 'scene_public', addresseeIds: [] },
  order,
})

/**
 * Real provider run of "a line with an action is one turn" on the status-market sample. Player inputs are fixed;
 * whether and how the characters answer is the model's. Each step finds its option in the current player view,
 * the way the default stage does, so a step whose option is missing is recorded rather than forced.
 */
const steps: { label: string; run: (r: WorldHostRuntime, find: (m: (o: Option) => boolean) => Promise<Option>) => Promise<HostState> }[] = [
  { label: '对白', run: r => r.submit('集市好热闹啊。你们想先逛哪儿？') },
  {
    label: '先说后做：拿保温杯',
    run: async (r, find) =>
      r.perform((await find(o => definition(o) === 'status:take')).action, say('这个保温杯是谁落下的？我先帮忙拿着。')),
  },
  {
    label: '先说后做：把保温杯递给同行者',
    run: async (r, find) => {
      // The pack's own item rules: the recipient is an input of the author's give.
      const give = await find(o => definition(o) === 'status:give')
      return r.perform(
        { ...give.action, parameters: { ...give.action.parameters, arguments: { recipientId: COMPANION } } },
        say('天有点凉，你先捧着暖暖手吧。'),
      )
    },
  },
  {
    label: '先说后做：购买 20',
    run: async (r, find) => {
      const buy = await find(o => definition(o) === 'status:buy')
      return r.perform({ ...buy.action, parameters: { ...buy.action.parameters, arguments: { price: 20 } } }, say('老板，这包桂花糖我要了。'))
    },
  },
  {
    label: '先做后说：查看钱包',
    run: async (r, find) => r.perform((await find(o => definition(o) === 'status:check-purse')).action, say('还剩不少，够我们再逛一阵。', 'after')),
  },
  {
    label: '先说后做：去后间',
    run: async (r, find) => r.perform((await find(o => o.kind === 'move')).action, say('我去后面看看，马上回来。')),
  },
  { label: '对白（后间）', run: r => r.submit('这里好安静，有人在吗？') },
  {
    label: '先做后说：回前厅',
    run: async (r, find) => r.perform((await find(o => o.kind === 'move')).action, say('我回来了，后面没什么好看的。', 'after')),
  },
  { label: '对白', run: r => r.submit('刚才递给你的保温杯还热吗？') },
  { label: '对白', run: r => r.submit('今天就到这儿吧，大家都还好吗？') },
]

export async function playCombinedTurns(output: string, model: string) {
  const dataDirectory = resolve(output),
    local = relative(resolve('.tmp'), dataDirectory)
  if (!local || local.startsWith('..') || isAbsolute(local) || existsSync(dataDirectory))
    throw new TypeError('请使用 .tmp 内全新的数据目录')
  if (!process.env.DEEPSEEK_API_KEY) throw new TypeError('缺少 DEEPSEEK_API_KEY')
  mkdirSync(dataDirectory, { recursive: true })
  const runtime = await WorldHostRuntime.create({
    packPath: resolve('examples/world-packs/status-market'),
    dataDirectory,
    // Core memory runs only behind the local (OpenAI-compatible) entry; the official API speaks that protocol.
    provider: 'local',
    utilityEndpoint: 'https://api.deepseek.com/chat/completions',
    model,
    apiKey: process.env.DEEPSEEK_API_KEY,
    memoryCore: true,
    timeoutMs: 90000,
  })
  const turns: WorldJsonObject[] = []
  const find = async (match: (o: Option) => boolean) => {
    const option = projectPlayerView(await runtime.state()).actions.find(match)
    if (!option) throw new TypeError('当前没有这个行动选项')
    return option
  }
  try {
    for (const [index, step] of steps.entries()) {
      const started = performance.now(),
        before = await runtime.state()
      let result = before,
        failed: string | undefined
      try {
        result = await step.run(runtime, find)
      } catch (error) {
        failed = error instanceof Error ? error.message : String(error)
        result = await runtime.state()
      }
      const row: WorldJsonObject = {
        turn: index + 1,
        step: step.label,
        durationMs: Math.round(performance.now() - started),
        error: result.error,
        ...(failed === undefined ? {} : { failed }),
        notice: result.notice ?? null,
        calls: Number(result.debug.providerCalls ?? 0) - Number(before.debug.providerCalls ?? 0),
        location: result.world.currentScene?.locationName ?? null,
        statusBar: structuredClone(result.statusBar ?? []) as unknown as WorldJsonObject[],
        newLines: result.transcript
          .filter(line => line.seq > (before.transcript.at(-1)?.seq ?? 0))
          .map(line => ({ speaker: line.speaker, text: line.text })),
      }
      turns.push(row)
      writeFileSync(resolve(dataDirectory, 'turns.json'), JSON.stringify(turns, null, 2))
      console.log(JSON.stringify({ turn: index + 1, step: step.label, ms: row.durationMs, calls: row.calls, failed: failed ?? null }))
      if (result.error && failed === undefined) break
    }
    const final = await runtime.state()
    writeFileSync(
      resolve(dataDirectory, 'summary.json'),
      JSON.stringify(
        {
          model,
          memoryMode: final.debug.memoryMode,
          turns: turns.length,
          totalCalls: final.debug.providerCalls,
          finalStatusBar: final.statusBar ?? [],
          limitations: ['单次样本，不是受控 A/B', '玩家输入固定，NPC 行为由模型决定', '需要人工阅读转录判断自然度'],
        },
        null,
        2,
      ),
    )
    writeFileSync(resolve(dataDirectory, 'transcript.json'), JSON.stringify(final.transcript, null, 2))
  } finally {
    await runtime.close()
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new TypeError('用法：combined-turn-playtest.ts <.tmp/新数据目录> [模型]')
  await playCombinedTurns(process.argv[2], process.argv[3] ?? 'deepseek-flash')
}
