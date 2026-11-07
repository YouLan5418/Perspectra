/**
 * The cache prefix with DeepSeek behind every character: the sweet days pack played from the first morning with
 * request capture on from the start, so every model call is recorded with its usage. Compare the records with
 * scratch analysis; judging naturalness stays with a reader of the transcript.
 *
 *   node --import tsx tests/experiments/stable-prefix-live.ts [.tmp/stable-prefix-<id>] [rounds]
 *
 * Reads the key from DEEPSEEK_API_KEY into memory only; the endpoint and model are fixed here. Uses a new directory.
 */
import { randomUUID } from 'node:crypto'
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { WorldJsonObject } from '@harness-world/contracts'
import { WorldStore } from '@harness-world/store-sqlite'
import { projectPlayerView } from '../../desktop/host/frontend-adapter.ts'
import { WorldHostRuntime } from '../../desktop/host/world-runtime.ts'
import { environmentRoleModels } from '../../desktop/model-connections.ts'
import { assembleCoreMemory, assembleRoleplay } from '../../desktop/official-bundle.ts'
import { playSettings } from '../../desktop/play-settings.ts'

const apiKey = process.env.DEEPSEEK_API_KEY?.trim()
if (!apiKey) throw new Error('DEEPSEEK_API_KEY is not set')
const models = environmentRoleModels({
  PERSPECTRA_MODEL_ENDPOINT: 'https://api.deepseek.com/chat/completions',
  PERSPECTRA_MODEL: 'deepseek-flash',
  PERSPECTRA_MODEL_API_KEY: apiKey,
})
const root = resolve(process.argv[2] ?? '.tmp/stable-prefix-' + randomUUID().slice(0, 6))
const rounds = Number(process.argv[3] ?? 16)
if (existsSync(root)) throw new Error('live play needs a new directory: ' + root)
mkdirSync(root, { recursive: true })
const obj = (value: unknown) => value as WorldJsonObject

const LINES = [
  '早上好，大家昨晚睡得怎么样？',
  'GPT，今天的计划表排好了吗？',
  'Claude，你在看什么书？',
  'DeepSeek，早饭想吃什么？',
  '我今天要出门打工，晚点回来。',
  '回来了，家里没出什么事吧？',
  '你们下午都做了什么？',
  'Claude，能帮我泡杯红茶吗？',
  'DeepSeek，游戏要不要再来一局？',
  '今天有点累，先歇一会儿。',
  '有没有什么想去的地方？',
  '水族馆听起来不错，下次一起去吧。',
  'DeepSeek，冰箱里的布丁是不是你吃的？',
  '晚饭大家想吃点什么？',
  '我去洗碗，你们坐着吧。',
  '那今天就到这儿吧，大家早点休息。',
  '早啊，今天是个好天气。',
  'GPT，今天要做的事多吗？',
  'Claude，昨天那本书看完了吗？',
  'DeepSeek，早饭还是想吃蛋糕吗？',
  '我出门打工去了，你们在家别闹。',
  '我回来了，今天店里特别忙。',
  '这个月的开销好像有点多。',
  'GPT，你的龙角是不是又红了？',
  'Claude，你平时都在想些什么？',
  'DeepSeek，你最喜欢这里的什么？',
  '外面好像下雨了。',
  '要不要一起看个电影？',
  '刚才好像听见什么声音？',
  '最近有没有什么烦心事？',
  'GPT，谢谢你一直帮我记着这些。',
  '大家晚安。',
]
const SPEND_TIME_EVERY = 4

function pack(): string {
  const path = join(root, 'pack')
  cpSync(resolve('examples/world-packs/model-girls-sweet-days'), path, { recursive: true })
  const file = join(path, 'worldpack.source.json')
  const source = JSON.parse(readFileSync(file, 'utf8'))
  source.assetFiles = source.assetFiles.filter((asset: string) => asset !== 'scripts/activities/prologue.js')
  writeFileSync(file, JSON.stringify(source, null, 2))
  const status = join(path, 'scripts/status.js')
  const text = readFileSync(status, 'utf8').replaceAll('\r\n', '\n')
  const firstMorning = text.replace("day: 0,\n        slot: '深夜'", "day: 1,\n        slot: '清晨'")
  if (firstMorning === text) throw new Error('the pack no longer starts on day 0 at night')
  writeFileSync(status, firstMorning)
  return path
}

const log = (line: string) => appendFileSync(join(root, 'transcript.md'), line + '\n')
const runtime = await WorldHostRuntime.create({
  packPath: pack(),
  dataDirectory: join(root, 'world'),
  models,
  timeoutMs: 180_000,
  // Core memory as the Launcher installs it by default: the history then grows until a consolidation.
  composition: assembleRoleplay({ memory: assembleCoreMemory({ models }) }),
  playSettings: playSettings({ activityOpportunities: 4, activityDeadlineSeconds: 120 }),
})
runtime.requestInspection(true)
const events = () => {
  const store = new WorldStore(join(runtime.dataDirectory, 'world.sqlite'))
  try {
    return store.readEvents(runtime.address)
  } finally {
    store.close()
  }
}
let shown = events().length
const show = () => {
  const all = events()
  for (const event of all.slice(shown)) {
    const data = obj(event.data)
    if (event.eventType === 'character.speak') {
      const segments = (data.segments as WorldJsonObject[] | undefined) ?? [{ type: 'speech', text: data.text ?? '' }]
      log(`- **${String(data.characterId)}**：${segments.map(s => `[${String(s.type)}] ${String(s.text)}`).join(' ')}`)
    } else if (event.eventType === 'character.moved')
      log(`- 〔移动〕${String(data.characterId)} → ${String(data.toLocationId)}`)
    else if (event.eventType === 'action.resolved' && data.accepted === false && data.sourceRole !== 'player')
      log(`- 〔被规则拒绝〕${String(data.actorId)} ${String(data.actionType)}：${String(data.reason ?? '')}`)
  }
  shown = all.length
}
const running = (state: { activity?: { game?: unknown } | null }) => obj(state.activity?.game ?? {}).active === true
const step = async (label: string, action: Parameters<typeof runtime.perform>[0]) => {
  log(`玩家操作：${label}`)
  let state = await runtime.perform(action)
  show()
  if (running(state)) {
    state = await runtime.escape()
    log('- 〔试验脚本退出活动〕')
    show()
  }
  return state
}
const spendTime = async (from: Awaited<ReturnType<typeof runtime.state>>) => {
  const offered = (state: typeof from, text: string) => projectPlayerView(state).actions.find(a => a.label.includes(text))
  const walk = (state: typeof from, locationId: string) =>
    (state.availableActions ?? []).some(
      a => a.actionType === 'move' && (a.destinations ?? []).some(d => d.locationId === locationId),
    )
      ? step('去 ' + locationId, { actionType: 'move', parameters: { locationId } })
      : Promise.resolve(state)
  const sleep = offered(from, '休息迎接明天')
  if (sleep) return step(sleep.label, sleep.action)
  let state = await walk(from, 'location:entrance-shop')
  const work = offered(state, '兼职')
  if (work) state = await step(work.label, work.action)
  return walk(state, 'location:living-room')
}
let failures = 0
const started = Date.now()
try {
  for (let index = 0; index < rounds; index++) {
    // Past the written lines the player starts over; the history keeps growing, which is what this measures.
    const line = LINES[index % LINES.length]!
    const round = index + 1
    log(`\n## 第 ${round} 轮\n\n玩家：${line}`)
    try {
      let state = await runtime.submit(line)
      if (state.error) {
        failures++
        log(`- 〔角色处理失败〕${state.notice}`)
      }
      show()
      if (running(state)) {
        state = await runtime.escape()
        log('- 〔试验脚本退出活动〕')
        show()
      }
      if (round % SPEND_TIME_EVERY === 0 && !running(state)) await spendTime(state)
    } catch (error) {
      failures++
      log(`- 〔这轮失败〕${error instanceof Error ? error.message : String(error)}`)
    }
    console.log(`round ${round} done, ${Math.round((Date.now() - started) / 1000)}s`)
  }
} finally {
  await runtime.close()
}
console.log(`records: ${join(runtime.dataDirectory, 'creator-debug', 'records')}  failures: ${failures}`)
