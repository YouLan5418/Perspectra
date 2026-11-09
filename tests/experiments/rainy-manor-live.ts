import { existsSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { brandId, type WorldJsonObject } from '@harness-world/contracts'
import { CharacterViewBuilder, WorldStore } from '@harness-world/store-sqlite'
import { environmentRoleModels } from '../../desktop/model-connections.ts'
import { WorldHostRuntime } from '../../desktop/host/world-runtime.ts'
import type { HostState } from '../../desktop/host/http-server.ts'

// Real-model play of the rainy-manor TRPG pack through the default frontend's paths: speech via submit, the TRPG
// panel via activityAction. Two games (the authored scenario, then a theme), each followed by main-world chat.
// The host's private rolls and notes are read from the store for diagnosis only; nothing here reaches a model.
// Usage: node --import tsx tests/experiments/rainy-manor-live.ts <new outputDir> [--model=opencode-go/glm-5.3-flash]
const model = process.argv.find(arg => arg.startsWith('--model='))?.slice(8) ?? 'opencode-go/glm-5.3-flash'
const output = resolve(process.argv.slice(2).find(arg => !arg.startsWith('--')) ?? 'output/rainy-manor-live-' + Date.now())
if (existsSync(output)) throw new Error('live play needs a new directory: ' + output)
mkdirSync(output, { recursive: true })
const dataDirectory = join(output, 'world')
const PLAYER = 'character:player',
  ARU = 'character:aru',
  CHENG = 'character:cheng',
  MEI = 'character:mei'
const NAME: Record<string, string> = { [PLAYER]: '玩家', [ARU]: '阿茹', [CHENG]: '澄', [MEI]: '梅' }

const runtime = await WorldHostRuntime.create({
  packPath: resolve('examples/world-packs/rainy-manor'),
  dataDirectory,
  models: environmentRoleModels({
    PERSPECTRA_MODEL_ENDPOINT: 'http://127.0.0.1:3495/v1/chat/completions',
    PERSPECTRA_MODEL: model,
  }),
  timeoutMs: 120_000,
})

type Json = WorldJsonObject
const transcript = (line: string) => (appendFileSync(join(output, 'transcript.md'), line + '\n'), console.log(line))
const log: Json[] = []
const delay = (ms: number) => new Promise(done => setTimeout(done, ms))
const withStore = <T>(read: (store: WorldStore) => T): T => {
  const store = new WorldStore(join(runtime.dataDirectory, 'world.sqlite'))
  try {
    return read(store)
  } finally {
    store.close()
  }
}
const events = () => withStore(store => store.readEvents(runtime.address))
async function settled(): Promise<HostState> {
  for (let i = 0; i < 480; i++) {
    const state = await runtime.state()
    if (!state.busy) return state
    await delay(500)
  }
  return runtime.state()
}
/** The player's own view of the TRPG activity, as the panel shows it. */
const panel = async () =>
  ((await runtime.state()).activities as Json[] | undefined)?.find(a => a.activityKey === 'trpg') as Json | undefined
/** The whole committed state, private parts included: diagnosis only. */
const full = () =>
  (
    events()
      .filter(e => e.eventType === 'activity.updated')
      .map(e => (e.data as Json).state as Json | undefined)
      .findLast(s => s !== undefined && (s.game as Json | undefined) !== undefined) as Json | undefined
  )?.game as Json | undefined

let seq = 0
/** Speech and activity results since the last report, in commit order, with who received each result. */
function report(): Json[] {
  const fresh = events().filter(e => e.seq > seq)
  seq = fresh.at(-1)?.seq ?? seq
  const rows: Json[] = []
  for (const e of fresh) {
    const d = e.data as Json
    if (e.eventType === 'character.speak') {
      const text = Array.isArray(d.segments)
        ? (d.segments as Json[]).map(s => (s.type === 'narration' ? `（${String(s.text)}）` : String(s.text))).join('')
        : String(d.text)
      const speaker = NAME[String(d.characterId)] ?? String(d.characterId)
      transcript(`- **${speaker}**：${text}`)
      rows.push({ seq: e.seq, kind: 'speak', speaker, text })
    } else if (e.eventType === 'activity.updated') {
      const input = (d.input as Json | undefined) ?? {}
      const actor = NAME[String(input.actorId)] ?? String(input.actorId ?? '')
      const operation = String(d.operation ?? '')
      const description = String(d.description ?? '')
      const params = input.parameters ? JSON.stringify(input.parameters) : ''
      const audience = String(d.audience ?? (d.observerIds ? (d.observerIds as string[]).map(id => NAME[id] ?? id).join('、') : ''))
      if (operation !== 'published') transcript(`  - _[${actor}·${operation}${audience ? '→' + audience : ''}] ${description}_ ${params}`)
      rows.push({ seq: e.seq, kind: 'activity', actor, operation, description, params, audience })
    }
  }
  return rows
}
async function step(name: string, run: () => Promise<unknown>) {
  transcript(`\n### ${name}`)
  let error: string | undefined
  const started = Date.now()
  try {
    await run()
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause)
    transcript(`  - ✘ ${error}`)
  }
  await settled()
  const rows = report()
  const view = await panel()
  const game = full()
  const host = game && (game.public as Json).hostId ? ((game.private as Json)[String((game.public as Json).hostId)] as Json) : undefined
  const entry: Json = {
    step: name,
    seconds: Math.round((Date.now() - started) / 1000),
    ...(error ? { error } : {}),
    rows,
    panel: view ? { phase: (view.game as Json | undefined)?.phase ?? null, public: (view.game as Json | undefined)?.public ?? null } : null,
    diagnosis: game
      ? {
          phase: game.phase as string,
          turn: (game.turn as string | null) ?? null,
          pending: ((game.public as Json).pending as Json[] | undefined) ?? [],
          hostRolls: (host?.rolls as Json[] | undefined) ?? [],
          hostNotes: (host?.notes as string | undefined) ?? '',
          rolls: Object.fromEntries(Object.entries(game.private as Json).map(([id, p]) => [NAME[id] ?? id, (p as Json).rolls ?? []])),
        }
      : null,
  }
  log.push(entry)
  if (game) transcript(`  - 〔诊断〕阶段 ${String(game.phase)}；待处理 ${JSON.stringify((game.public as Json).pending ?? [])}；主持人掷骰 ${JSON.stringify(host?.rolls ?? [])}`)
  writeFileSync(join(output, 'log.json'), JSON.stringify(log, null, 2))
}
let requests = 0
const act = (operation: string, parameters: Json = {}) =>
  step(`${operation} ${JSON.stringify(parameters)}`, async () => {
    const a = operation === 'start' ? undefined : await panel()
    return runtime.activityAction({
      activityKey: 'trpg',
      activityId: a && a.id ? String(a.id) : null,
      revision: a && a.id ? Number(a.revision) : 0,
      operation,
      parameters,
      requestId: 'live-' + requests++ + '-' + randomUUID().slice(0, 8),
    })
  })
const say = (text: string) => step('说：' + text, () => runtime.submit(text))
const active = async () => ((await panel())?.game as Json | undefined)?.active === true
const phase = async () => String(((await panel())?.game as Json | undefined)?.phase ?? '')

async function game(title: string, npcIds: string[], hostId: string, pick: Json, actions: string[], ending: string) {
  transcript(`\n## ${title}\n`)
  const started = Date.now()
  await act('start', { npcIds })
  await act('setup', { hostId, ...pick })
  if ((await phase()) === 'invited') await say(`${NAME[hostId]}，你愿意来主持吗？`)
  if ((await phase()) !== 'playing') {
    transcript(`  - 主持人没有接下（阶段：${await phase()}），本局结束`)
    if (await active()) await act('end', {})
    return
  }
  for (const action of actions) {
    if (!(await active())) break
    if (action.startsWith('说：')) await say(action.slice(2))
    else await act('propose', { text: action })
  }
  if (await active()) await act('end', { ending })
  transcript(`\n（本局用时 ${Math.round((Date.now() - started) / 1000)} 秒）`)
}

try {
  transcript(`# 雨夜古宅真实模型试玩\n\n模型：${model}；数据目录：${dataDirectory}`)
  await step('开场', async () => undefined)
  await game(
    '第一局：阿茹主持剧本《雨夜古宅》，澄参加，梅在局外',
    [ARU, CHENG],
    ARU,
    { scenario: 'rainy-manor' },
    [
      '我先接过管家递来的热茶，但只假装喝一口，偷偷观察他的表情。',
      '我仔细看看门厅里那幅老主人的画像，画框有没有什么不对劲的地方？',
      '说：澄，你要不要去楼梯那边看看？我总觉得楼上有动静。',
      '趁管家转身去添柴，我想悄悄把他腰上那串钥匙顺下来。',
      '我拿着钥匙去书房，试着打开那扇锁着的门。',
      '在书房里翻翻书架，找找有没有什么藏起来的东西。',
      '我们差不多该收尾了，主持人给我们一个结局吧。',
    ],
    '天亮了，雨停了。你们离开古宅，谁也没有回头。',
  )
  await say('呼，刚才那局好紧张！阿茹，你剧本里那个管家也太吓人了。澄，你还记得自己在古宅里干了什么吗？')
  await say('梅，你刚才在旁边看书，有没有听见我们在玩什么？')
  await game(
    '第二局：梅用题目“深夜的废弃医院”即兴主持，阿茹和澄参加',
    [MEI, ARU, CHENG],
    MEI,
    { theme: '深夜的废弃医院' },
    [
      '我推开医院大门，用手机的光照一照挂号大厅，看看有没有人来过的痕迹。',
      '说：阿茹，澄，你们想先去哪边？',
      '我想去二楼的病房找找有没有值班记录。',
      '听到走廊尽头有声音，我想屏住呼吸躲进旁边的储物间。',
      '我打开储物间里那个上锁的柜子。',
      '时间不早了，主持人，给这局收个尾吧。',
    ],
    '天快亮了，你们从侧门溜了出去，身后的医院重新陷入安静。',
  )
  await say('梅主持得好认真啊。大家觉得刚才那家医院里到底藏着什么？')
  await say('说起来，今晚雨还没停，我们明天要不要真的出去走走？')
} finally {
  const head = withStore(store => store.head(runtime.address).headSeq)
  const observations = Object.fromEntries(
    [ARU, CHENG, MEI].map(id => [
      NAME[id],
      withStore(store => new CharacterViewBuilder(store).rebuildAt(runtime.address, brandId(id, 'CharacterId'), head))
        .observations.map(o => JSON.stringify(o.value)),
    ]),
  )
  writeFileSync(join(output, 'observations.json'), JSON.stringify(observations, null, 2))
  writeFileSync(join(output, 'log.json'), JSON.stringify(log, null, 2))
  await runtime.close()
}
