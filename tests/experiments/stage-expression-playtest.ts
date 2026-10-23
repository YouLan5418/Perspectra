import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { WorldJsonObject } from '@harness-world/contracts'
import { WorldHostRuntime } from '../../desktop/host/world-runtime.ts'
import { loadPackWeb } from '../../desktop/host/pack-frontend.ts'

/**
 * Real provider run of per-line expressions: the pack's stage.json declares expressions for some characters,
 * the player says a few lines likely to move them, and every segment's expression is recorded. Characters
 * without declared expressions must never carry one. Player lines are fixed; what the characters say and which
 * expression they pick is the model's.
 */
const lines = [
  '我刚才把大家留的点心全吃完了……抱歉。',
  '不过我买了新的蛋糕回来！谁想先挑？',
  'Claude，你今天看起来有点累，还好吗？',
  'DeepSeek，听说你昨晚写代码写到天亮？',
  '好啦，大家早点休息，晚安。',
]

export async function playStageExpressions(output: string, pack: string, model: string) {
  const dataDirectory = resolve(output),
    local = relative(resolve('.tmp'), dataDirectory)
  if (!local || local.startsWith('..') || isAbsolute(local) || existsSync(dataDirectory))
    throw new TypeError('请使用 .tmp 内全新的数据目录')
  if (!process.env.DEEPSEEK_API_KEY) throw new TypeError('缺少 DEEPSEEK_API_KEY')
  mkdirSync(dataDirectory, { recursive: true })
  const web = await loadPackWeb(resolve(pack))
  const stageExpressions = Object.fromEntries(
    Object.entries(web?.stage?.characters ?? {}).flatMap(([id, character]) =>
      character.expressions ? [[id, Object.keys(character.expressions)]] : [],
    ),
  )
  const runtime = await WorldHostRuntime.create({
    packPath: resolve(pack),
    dataDirectory,
    provider: 'local',
    utilityEndpoint: 'https://api.deepseek.com/chat/completions',
    model,
    apiKey: process.env.DEEPSEEK_API_KEY,
    memoryCore: true,
    timeoutMs: 90000,
    stageExpressions,
  })
  const turns: WorldJsonObject[] = []
  try {
    for (const [index, text] of lines.entries()) {
      const before = await runtime.state()
      const result = await runtime.submit(text)
      const added = result.transcript.filter(line => line.seq > (before.transcript.at(-1)?.seq ?? 0) && !line.player)
      const row: WorldJsonObject = {
        turn: index + 1,
        player: text,
        error: result.error,
        notice: result.notice,
        lines: added.map(line => ({
          speaker: line.speaker,
          speakerId: line.speakerId ?? null,
          segments: (line.segments ?? [{ type: 'speech', text: line.text }]).map(segment => ({
            type: segment.type,
            expression: segment.expression ?? null,
            text: segment.text,
          })),
        })),
      }
      turns.push(row)
      writeFileSync(resolve(dataDirectory, 'turns.json'), JSON.stringify(turns, null, 2))
      console.log(JSON.stringify({ turn: index + 1, error: result.error, lines: added.length }))
    }
    // Who picked what, and whether anyone without declared expressions carried one.
    const tally: Record<string, Record<string, number>> = {}
    for (const turn of turns)
      for (const line of turn.lines as { speakerId: string; segments: { expression: string | null }[] }[])
        for (const segment of line.segments) {
          const counts = (tally[line.speakerId] ??= {})
          const key = segment.expression ?? '（无）'
          counts[key] = (counts[key] ?? 0) + 1
        }
    const undeclared = Object.entries(tally).filter(
      ([id, counts]) => !stageExpressions[id] && Object.keys(counts).some(key => key !== '（无）'),
    )
    writeFileSync(
      resolve(dataDirectory, 'summary.json'),
      JSON.stringify({ model, stageExpressions, tally, undeclaredWithExpression: undeclared.map(([id]) => id) }, null, 2),
    )
  } finally {
    await runtime.close()
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2] || !process.argv[3])
    throw new TypeError('用法：stage-expression-playtest.ts <.tmp/新数据目录> <带 stage.json 的包> [模型]')
  await playStageExpressions(process.argv[2], process.argv[3], process.argv[4] ?? 'deepseek-flash')
}
