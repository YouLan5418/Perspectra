/**
 * Story pacing with a real model behind every character: the same player lines on the sweet days pack, with its
 * pacing and without, twice each. Writes a transcript and counts per run; judging naturalness stays with a reader.
 * Uses PERSPECTRA_MODEL_* and a new directory; records no credentials.
 *
 *   node --import tsx tests/experiments/pacing-compare-live.ts [.tmp/pacing-compare-<id>]
 *
 * The prologue is left out, so every run starts on the first morning. A running activity is left at once through the
 * escape path: this measures how often events come and how characters take beats, not how the activities play.
 */
import { randomUUID } from 'node:crypto'
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { WorldJsonObject } from '@harness-world/contracts'
import { WorldStore } from '@harness-world/store-sqlite'
import { projectPlayerView } from '../../desktop/host/frontend-adapter.ts'
import { WorldHostRuntime } from '../../desktop/host/world-runtime.ts'
import { environmentRoleModels } from '../../desktop/model-connections.ts'
import { assembleRoleplay } from '../../desktop/official-bundle.ts'
import { playSettings } from '../../desktop/play-settings.ts'

const models = environmentRoleModels(process.env)
const root = resolve(process.argv[2] ?? '.tmp/pacing-compare-' + randomUUID().slice(0, 6))
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
  'GPT，你的龙角是不是又红了？',
  '这个月的开销好像有点多。',
  'Claude，能帮我泡杯红茶吗？',
  'DeepSeek，游戏要不要再来一局？',
  '外面天气怎么样？',
  '今天有点累，先歇一会儿。',
  '你们觉得住在这里习惯吗？',
  '有没有什么想去的地方？',
  '水族馆听起来不错，下次一起去吧。',
  'GPT，别总替大家操心。',
  'Claude，你的书看到哪儿了？',
  'DeepSeek，冰箱里的布丁是不是你吃的？',
  '晚饭大家想吃点什么？',
  '我去洗碗，你们坐着吧。',
  '刚才好像听见什么声音？',
  '最近有没有什么烦心事？',
  'GPT，谢谢你一直帮我记着这些。',
  'Claude，你平时都在想些什么？',
  'DeepSeek，你最喜欢这里的什么？',
  '时间过得真快。',
  '明天有什么打算？',
  '要不要一起看个电影？',
  '那今天就到这儿吧，大家早点休息。',
]
/** The clock moves only through operations, so every few rounds the player spends a period of the day. */
const SPEND_TIME_EVERY = 4

function pack(name: string, pacing: boolean): string {
  const path = join(root, 'packs', name)
  cpSync(resolve('examples/world-packs/model-girls-sweet-days'), path, { recursive: true })
  const file = join(path, 'worldpack.source.json')
  const source = JSON.parse(readFileSync(file, 'utf8'))
  source.assetFiles = source.assetFiles.filter(
    (asset: string) => asset !== 'scripts/activities/prologue.js' && (pacing || asset !== 'scripts/pacing.js'),
  )
  writeFileSync(file, JSON.stringify(source, null, 2))
  const status = join(path, 'scripts/status.js')
  const text = readFileSync(status, 'utf8').replaceAll('\r\n', '\n')
  const firstMorning = text.replace("day: 0,\n        slot: '深夜'", "day: 1,\n        slot: '清晨'")
  if (firstMorning === text) throw new Error('the pack no longer starts on day 0 at night')
  writeFileSync(status, firstMorning)
  return path
}

async function run(name: string, pacing: boolean): Promise<WorldJsonObject> {
  const log = (line: string) => appendFileSync(join(root, name + '.md'), line + '\n')
  const runtime = await WorldHostRuntime.create({
    packPath: pack(name, pacing),
    dataDirectory: join(root, name),
    models,
    timeoutMs: 180_000,
    composition: assembleRoleplay(),
    playSettings: playSettings({ activityOpportunities: 4, activityDeadlineSeconds: 120 }),
  })
  const happened: { round: number; kind: string; key: string; automatic: boolean }[] = []
  const stimulated: { round: number; beat: string; characterId: string; kind: string; text: string; said: string[] }[] =
    []
  let replies = 0,
    failures = 0
  const events = () => {
    const store = new WorldStore(join(runtime.dataDirectory, 'world.sqlite'))
    try {
      return store.readEvents(runtime.address)
    } finally {
      store.close()
    }
  }
  let shown = events().length
  const show = (round: number) => {
    const all = events()
    for (const event of all.slice(shown)) {
      const data = obj(event.data)
      if (event.eventType === 'character.speak') {
        const segments = (data.segments as WorldJsonObject[] | undefined) ?? [{ type: 'speech', text: data.text ?? '' }]
        const line = segments.map(s => `[${String(s.type)}] ${String(s.text)}`).join(' ')
        replies++
        log(`- **${String(data.characterId)}**：${line}`)
        for (const stimulus of stimulated)
          if (stimulus.round === round && stimulus.characterId === data.characterId) stimulus.said.push(line)
      } else if (event.eventType === 'activity.updated' && data.operation === 'start') {
        happened.push({
          round,
          kind: 'activity',
          key: String(data.activityKey),
          automatic: String(data.requestId ?? '').startsWith('auto-start:'),
        })
        log(`- 〔活动开始〕${String(data.activityKey)}：${String(data.description ?? '')}`)
      } else if (event.eventType === 'status.updated' && obj(data.source).kind === 'beat') {
        const beat = String(obj(data.source).beatId)
        happened.push({ round, kind: 'beat', key: beat, automatic: true })
        log(`- 〔节拍〕${beat}：${JSON.stringify(data.changes)}`)
      } else if (event.eventType === 'observation.upsert') {
        const value = obj(obj(data).value),
          content = obj(value.content ?? {})
        const text = content.perceived ?? content.innerThought
        if (typeof content.eventNotice === 'string')
          log(`  - 〔${String(value.observerId)} 读到〕${content.eventNotice}`)
        if (typeof text === 'string') {
          const kind = content.perceived === undefined ? 'thought' : 'perception'
          log(`  - 〔只给 ${String(value.observerId)} 的${kind === 'thought' ? '念头' : '察觉'}〕${text}`)
          stimulated.push({
            round,
            beat: String(value.actionId),
            characterId: String(value.observerId),
            kind,
            text,
            said: [],
          })
        }
      } else if (event.eventType === 'character.moved') {
        log(`- 〔移动〕${String(data.characterId)} → ${String(data.toLocationId)}`)
      }
    }
    shown = all.length
  }
  const running = (state: { activity?: { game?: unknown } | null }) => obj(state.activity?.game ?? {}).active === true
  const decisions: unknown[] = []
  /** Sleep when the night allows it; otherwise walk to the entrance, work a shift and come home. */
  const spendTime = async (from: Awaited<ReturnType<typeof runtime.state>>, round: number) => {
    const offered = (state: typeof from, text: string) =>
      projectPlayerView(state).actions.find(a => a.label.includes(text))
    const step = async (label: string, action: Parameters<typeof runtime.perform>[0]) => {
      log(`玩家操作：${label}`)
      let state = await runtime.perform(action)
      show(round)
      if (running(state)) {
        state = await runtime.escape()
        log('- 〔试验脚本退出活动〕')
        show(round)
      }
      return state
    }
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
  try {
    for (const [index, line] of LINES.entries()) {
      const round = index + 1
      log(`\n## 第 ${round} 轮\n\n玩家：${line}`)
      try {
        let state = await runtime.submit(line)
        show(round)
        decisions.push({ round, decision: runtime.pacingDecision() })
        log(`  - （决策）${JSON.stringify(obj(runtime.pacingDecision() ?? {}).reason ?? null)}`)
        if (running(state)) {
          state = await runtime.escape()
          log('- 〔试验脚本退出活动〕')
          show(round)
        }
        if (round % SPEND_TIME_EVERY === 0 && !running(state)) await spendTime(state, round)
      } catch (error) {
        failures++
        log(`- 〔这轮失败〕${error instanceof Error ? error.message : String(error)}`)
      }
    }
  } finally {
    await runtime.close()
  }
  const automatic = happened.filter(item => item.automatic)
  const gaps = automatic.slice(1).map((item, i) => item.round - automatic[i]!.round)
  let quietest = 0,
    last = 0
  for (const item of automatic) {
    quietest = Math.max(quietest, item.round - last - 1)
    last = item.round
  }
  quietest = Math.max(quietest, LINES.length - last)
  return {
    name,
    pacing,
    rounds: LINES.length,
    replies,
    failures,
    automatic: automatic.length,
    gaps,
    quietest,
    happened,
    stimulated,
    decisions,
  } as unknown as WorldJsonObject
}

const results = await Promise.all([
  run('on-1', true),
  run('off-1', false),
])
results.push(...(await Promise.all([run('on-2', true), run('off-2', false)])))
writeFileSync(join(root, 'stats.json'), JSON.stringify(results, null, 2))
for (const r of results)
  console.log(
    `${String(r.name)}: 自动事件 ${String(r.automatic)}，间隔 ${JSON.stringify(r.gaps)}，最长无事件 ${String(r.quietest)} 轮，角色发言 ${String(r.replies)}，失败 ${String(r.failures)}`,
  )
