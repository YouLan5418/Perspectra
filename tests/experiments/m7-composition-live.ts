/**
 * M7 real-model pass: the same packs and selections as the composition acceptance test, with a real model behind
 * every character. It reports what characters said and what the world committed; judging naturalness stays with a
 * reader of the transcript. Uses PERSPECTRA_MODEL_* and writes to a new directory; records no credentials.
 *
 *   node --import tsx tests/experiments/m7-composition-live.ts [.tmp/m7-live-<id>]
 */
import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { WorldJsonObject } from '@harness-world/contracts'
import { WorldStore } from '@harness-world/store-sqlite'
import { projectPlayerView } from '../../desktop/host/frontend-adapter.ts'
import { WorldHostRuntime } from '../../desktop/host/world-runtime.ts'
import { environmentRoleModels } from '../../desktop/model-connections.ts'
import { assembleRoleplay, type HostSeams, type WorldComposition } from '../../desktop/official-bundle.ts'
import { playSettings } from '../../desktop/play-settings.ts'

const models = environmentRoleModels(process.env)
const root = resolve(process.argv[2] ?? '.tmp/m7-live-' + randomUUID().slice(0, 6))
if (existsSync(root)) throw new Error('live play needs a new directory: ' + root)
mkdirSync(root, { recursive: true })
const log = (line: string) => (appendFileSync(join(root, 'transcript.md'), line + '\n'), console.log(line))
const obj = (value: unknown) => value as WorldJsonObject

const GAMEPLAY = ['knowledge', 'status', 'activities', 'communication', 'autonomy']
function selecting(...wanted: string[]): WorldComposition {
  const standard = assembleRoleplay()
  const mechanisms = { ...standard.mechanisms } as Record<string, unknown>
  for (const name of GAMEPLAY) if (!wanted.includes(name)) delete mechanisms[name]
  return { ...standard, mechanisms: mechanisms as unknown as HostSeams }
}

async function open(name: string, pack: string, composition: WorldComposition) {
  const dataDirectory = join(root, name)
  const runtime = await WorldHostRuntime.create({
    packPath: resolve('examples/world-packs', pack),
    dataDirectory,
    models,
    timeoutMs: 180_000,
    composition,
    playSettings: playSettings({ activityOpportunities: 20, activityDeadlineSeconds: 600 }),
  })
  const events = () => {
    const store = new WorldStore(join(runtime.dataDirectory, 'world.sqlite'))
    try {
      return store.readEvents(runtime.address)
    } finally {
      store.close()
    }
  }
  let shown = events().length
  const transcript = () => {
    const all = events()
    for (const event of all.slice(shown)) {
      const data = obj(event.data)
      if (event.eventType === 'character.speak') {
        const segments = (data.segments as WorldJsonObject[] | undefined) ?? [{ type: 'speech', text: data.text ?? '' }]
        log(`- **${String(data.characterId)}**：${segments.map(s => `[${String(s.type)}] ${String(s.text)}`).join(' ')}`)
      } else if (event.eventType === 'activity.updated' && data.description) log(`- 〔活动〕${String(data.description)}`)
      else if (event.eventType === 'status.updated' && data.description) {
        const rows = (data.reveals as WorldJsonObject[]).map(r => `${String(r.observerId)}知道${String(r.holderId)}.${String(r.key)}=${JSON.stringify(r.value)}`)
        log(`- 〔状态〕${String(data.description)}（${JSON.stringify(data.changes)}；${rows.join('，')}）`)
      }
      else if (event.eventType === 'entity.transferred')
        log(`- 〔物品〕${String(data.entityId)} → ${String(data.toHolderId ?? data.toLocationId)}`)
      else if (event.eventType === 'character.moved')
        log(`- 〔移动〕${String(data.characterId)} → ${String(data.toLocationId)}`)
    }
    shown = all.length
  }
  return { runtime, events, transcript }
}
type Game = Awaited<ReturnType<typeof open>>

async function say(game: Game, line: string) {
  log(`\n> 玩家：${line}`)
  const state = await game.runtime.submit(line)
  game.transcript()
  if (state.notice) log(`- 〔提示〕${state.notice}`)
}

async function roleplay() {
  log('\n## 默认 RP（dynamic-scheduling，完整默认组合）\n')
  const game = await open('rp', 'dynamic-scheduling', assembleRoleplay())
  try {
    for (const line of ['大家晚上好，今天过得怎么样？', '我刚才在门口好像看到有人落了东西，你们谁丢了什么吗？', '先不管了，你们想吃点什么？'])
      await say(game, line)
  } finally {
    await game.runtime.close()
  }
}

async function market() {
  log('\n## 状态集市（只选状态与知识）\n')
  const game = await open('market', 'status-market', selecting('status', 'knowledge'))
  try {
    await say(game, '老板，今天生意怎么样？')
    const take = projectPlayerView(await game.runtime.state()).actions.find(a => a.label.startsWith('拿起'))
    if (take) {
      log(`\n> 玩家操作：${take.label}`)
      await game.runtime.perform(take.action)
      game.transcript()
    }
    await say(game, '这个保温杯现在在我手里，谁想要吗？')
    const holder = game.events().findLast(e => e.eventType === 'entity.transferred')
    log(`\n〔事实核对〕最后一次物品转移：${JSON.stringify(holder?.data ?? null)}`)
  } finally {
    await game.runtime.close()
  }
}

async function rpg() {
  log('\n## RPG 回合战（只选状态与活动，同伴用真实模型）\n')
  const game = await open('rpg', 'rpg-turn-battle', selecting('status', 'activities'))
  const act = async (label: string, args: WorldJsonObject = {}) => {
    const option = projectPlayerView(await game.runtime.state()).actions.find(a => a.label === label)
    if (!option) return false
    log(`\n> 玩家操作：${label}`)
    const action = {
      ...option.action,
      parameters: {
        ...option.action.parameters,
        arguments: { ...obj(option.action.parameters.arguments), ...args },
      },
    }
    await game.runtime.perform(action as typeof option.action)
    game.transcript()
    return true
  }
  try {
    await act('让同伴使用真实模型决策')
    await act('进入遗迹迎战')
    for (let round = 0; round < 8; round++) {
      const battle = obj((await game.runtime.state()).activities!.find(a => a.activityKey === 'battle'))
      if (!obj(battle.game).active) break
      if (!(await act('火球术（3魔力）', { targetId: '遗迹守卫' }))) await act('普通攻击', { targetId: '遗迹守卫' })
    }
    const truth = game.runtime.creatorInspection().statusTruth
    log(`\n〔事实核对〕结束时真值：${JSON.stringify(truth)}`)
  } finally {
    await game.runtime.close()
  }
}

async function werewolf() {
  log('\n## 狼人杀（只选活动）\n')
  const game = await open('werewolf', 'model-girls-werewolf', selecting('activities'))
  const current = async () => obj((await game.runtime.state()).activities!.find(a => a.activityKey === 'werewolf'))
  const operate = async (operation: string, parameters: WorldJsonObject = {}) => {
    const a = await current()
    await game.runtime.activityAction({
      activityKey: 'werewolf',
      activityId: operation === 'start' ? null : String(a.id),
      revision: operation === 'start' ? 0 : Number(a.revision),
      operation,
      parameters,
      requestId: randomUUID(),
    })
    game.transcript()
  }
  try {
    await operate('start')
    log(`〔玩家身份〕${JSON.stringify(obj(obj(await current()).game).private)}`)
    for (let step = 0; step < 40; step++) {
      const a = await current(),
        g = obj(a.game)
      if (!g.active) break
      const options = (a.options as WorldJsonObject[] | undefined) ?? []
      // At night the visible turn stays on a neutral seat; only the actor is told privately that it is her turn.
      const mine = g.turn === 'character:player' || obj(g.private)['轮到你'] === true
      if (!mine || !options.length) {
        await operate('retry')
        continue
      }
      if (g.phase === 'day-speak') {
        await say(game, '我先听听大家的。')
        continue
      }
      const pass = options.map(o => String(obj(o.definitionRef).id).slice(9)).find(id => /pass|skip|abstain|sleep/u.test(id))
      if (pass) {
        await operate(pass)
        continue
      }
      const first = options[0]!,
        properties = obj(obj(first.argumentSchema).properties)
      const alive = (obj(g.public)['存活'] as string[]).filter(name => name !== '玩家')
      // Choose like a player who knows only their own view; a refused choice commits nothing, so try the next name.
      for (let offset = 0; offset < alive.length; offset++) {
        const parameters = Object.fromEntries(
          Object.keys(properties)
            .filter(key => key !== 'activityId' && key !== 'revision')
            .map(key => [key, alive[(step + offset) % alive.length]!]),
        ) as WorldJsonObject
        try {
          await operate(String(obj(first.definitionRef).id).slice(9), parameters)
          break
        } catch (error) {
          if (!(error instanceof TypeError)) throw error
          log(`- 〔玩家操作被拒〕${error.message}`)
        }
      }
    }
    const end = await current()
    log(`\n〔结局〕phase=${String(obj(end.game).phase)} 公开=${JSON.stringify(obj(end.game).public)}`)
  } finally {
    await game.runtime.close()
  }
}

const started = Date.now()
const results: Record<string, string> = {}
const only = process.env.M7_ONLY?.split(',')
for (const [name, run] of Object.entries({ roleplay, market, rpg, werewolf })) {
  if (only && !only.includes(name)) continue
  try {
    await run()
    results[name] = 'completed'
  } catch (error) {
    results[name] = 'failed: ' + (error instanceof Error ? error.message : String(error))
    log(`\n**${name} 中止**：${results[name]}`)
  }
}
log(`\n---\n结果：${JSON.stringify(results)}；用时 ${Math.round((Date.now() - started) / 1000)} 秒；模型 ${process.env.PERSPECTRA_MODEL}`)
log(`目录：${root}`)
