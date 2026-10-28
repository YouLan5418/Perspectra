/**
 * Two live werewolf games through the real host and a real model: the player plays from its own view with
 * simple choices, every NPC is a model. Writes a readable transcript and the raw records to a new directory.
 *
 *   node --import tsx tests/experiments/werewolf-live.ts [.tmp/werewolf-live-<id>]
 */
import { existsSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { brandId, type WorldJsonObject } from '@harness-world/contracts'
import { CharacterViewBuilder, WorldStore } from '@harness-world/store-sqlite'
import { WorldHostCore } from '../../desktop/host/world-runtime.ts'
import { playSettings } from '../../desktop/play-settings.ts'
import { PROVIDER_DEFAULTS } from '../../desktop/provider-defaults.ts'

const root = resolve(process.argv[2] ?? '.tmp/werewolf-live-' + randomUUID().slice(0, 6))
if (existsSync(root)) throw new Error('live play needs a new directory: ' + root)
mkdirSync(root, { recursive: true })
const data = join(root, 'data')
const PLAYER = 'character:player'
const NPCS = ['character:gpt', 'character:claude', 'character:deepseek', 'character:glm', 'character:gemini', 'character:qwen']
const NAME: Record<string, string> = {
  [PLAYER]: '玩家',
  'character:gpt': 'GPT',
  'character:claude': 'Claude',
  'character:deepseek': 'DeepSeek',
  'character:glm': 'GLM',
  'character:gemini': 'Gemini',
  'character:qwen': 'Qwen',
}
const transcript = (line: string) => (appendFileSync(join(root, 'transcript.md'), line + '\n'), console.log(line))
type Game = { active: boolean; phase: string; turn: string | null; public: WorldJsonObject; private: WorldJsonObject }

const runtime = await WorldHostCore.create({
  packPath: resolve('examples/world-packs/model-girls-werewolf'),
  dataDirectory: data,
  provider: 'local',
  model: process.env.HCW_LOCAL_MODEL ?? PROVIDER_DEFAULTS.local.model,
  utilityEndpoint: process.env.HCW_LOCAL_ENDPOINT ?? PROVIDER_DEFAULTS.local.endpoint,
  ...(process.env.HCW_LOCAL_API_KEY ? { apiKey: process.env.HCW_LOCAL_API_KEY } : {}),
  playSettings: playSettings({ activityOpportunities: 20, activityDeadlineSeconds: 600 }),
})
const withStore = <T>(read: (store: WorldStore) => T): T => {
  const store = new WorldStore(join(data, 'world.sqlite'))
  try {
    return read(store)
  } finally {
    store.close()
  }
}
const current = async () =>
  ((await runtime.state()).activities as WorldJsonObject[]).find(a => a.activityKey === 'werewolf')!
const game = async () => (await current()).game as unknown as Game
let requests = 0
const request = async (operation: string, parameters: WorldJsonObject = {}) => {
  const a = operation === 'start' ? undefined : await current()
  return runtime.activityAction({
    activityKey: 'werewolf',
    activityId: a && a.id !== null ? String(a.id) : null,
    revision: a && a.id !== null ? Number(a.revision) : 0,
    operation,
    parameters,
    requestId: 'live-' + requests++,
  })
}
const pick = <T>(list: readonly T[]) => list[Math.floor(Math.random() * list.length)]!

/** Speech, game results and per-character deliveries since `afterSeq`, in commit order. */
function report(afterSeq: number) {
  const events = withStore(store => store.readEvents(runtime.address)).filter(e => e.seq > afterSeq)
  for (const e of events) {
    const d = e.data as WorldJsonObject
    if (e.eventType === 'character.speak') {
      const scope = String(d.scope ?? 'scene_public')
      const to = Array.isArray(d.addresseeIds) ? ` → ${(d.addresseeIds as string[]).map(id => NAME[id]).join('、')}` : ''
      // NPC publications carry segments; the player's own line is plain text.
      const text = Array.isArray(d.segments)
        ? (d.segments as WorldJsonObject[]).map(s => (s.type === 'narration' ? `（${String(s.text)}）` : String(s.text))).join('')
        : String(d.text)
      transcript(`- **${NAME[String(d.characterId)]}**${scope === 'scene_public' ? '' : `（${scope}${to}）`}：${text}`)
    } else if (e.eventType === 'activity.updated') {
      const description = String(d.description ?? '')
      if (description) transcript(`  - _${description}_`)
    }
  }
  return events.at(-1)?.seq ?? afterSeq
}

async function playOne(index: number) {
  transcript(`\n## 第 ${index} 局\n`)
  let seq = withStore(store => store.head(runtime.address).headSeq)
  await request('start')
  const mine = (await game()).private
  transcript(`玩家身份：${String(mine['身份'])}${mine['狼同伴'] ? `（同伴 ${String(mine['狼同伴'])}）` : ''}\n`)
  let stuck = 0,
    lastKey = ''
  for (let step = 0; step < 400; step++) {
    const g = await game()
    seq = report(seq)
    if (!g.active) return g
    const key = `${g.phase}:${g.turn}:${String(g.public['第几天'])}`
    stuck = key === lastKey ? stuck + 1 : 0
    lastKey = key
    if (stuck >= 4) {
      transcript(`  - ⚠ ${NAME[g.turn ?? '']} 在 ${g.phase} 连续 4 次未推进，玩家结束本局`)
      await request('quit')
      seq = report(seq)
      return await game()
    }
    const living = (g.public['存活'] as string[]).filter(n => n !== '玩家')
    if (g.turn !== PLAYER) {
      await request('retry')
      continue
    }
    const own = g.private
    if (g.phase === 'day-speak') {
      const suspect = pick(living)
      const death = String(g.public['死讯'])
      await runtime.submit(
        `昨晚${death === '平安夜' ? '是平安夜' : '，' + death}。我没有什么特别的信息，不过 ${suspect} 刚才说话的样子让我有点在意，想听听她怎么解释。`,
      )
    } else if (g.phase === 'vote') await request('vote', { target: pick(living) })
    else if (own['身份'] === '狼人') await request('kill', { target: pick(living.filter(n => n !== own['狼同伴'])) })
    else if (own['身份'] === '预言家') await request('check', { target: pick(living) })
    else if (own['身份'] === '女巫') {
      const killed = String(own['今晚被刀'] ?? '无人')
      await request('potion', own['解药'] && killed !== '无人' ? { choice: 'save' } : { choice: 'none' })
    }
  }
  throw new Error('game did not finish')
}

try {
  transcript(`# 狼人杀真实模型试玩\n\n模型：${process.env.HCW_LOCAL_MODEL ?? PROVIDER_DEFAULTS.local.model}；数据目录：${data}`)
  const results = []
  for (let i = 1; i <= 2; i++) {
    const started = Date.now()
    const end = await playOne(i)
    results.push({ game: i, phase: end.phase, result: end.public['lastResult'], seconds: (Date.now() - started) / 1000 })
    transcript(`\n结果：${String(end.public['lastResult'])}（用时 ${Math.round((Date.now() - started) / 1000)} 秒）`)
  }
  // What each NPC was actually delivered, for checking leaks against the transcript.
  const observations = Object.fromEntries(
    NPCS.map(id => [
      NAME[id],
      withStore(store =>
        new CharacterViewBuilder(store).rebuildAt(runtime.address, brandId(id, 'CharacterId'), store.head(runtime.address).headSeq)
          .observations,
      ),
    ]),
  )
  writeFileSync(join(root, 'observations.json'), JSON.stringify(observations, null, 2))
  writeFileSync(join(root, 'results.json'), JSON.stringify(results, null, 2))
} finally {
  await runtime.close()
}
