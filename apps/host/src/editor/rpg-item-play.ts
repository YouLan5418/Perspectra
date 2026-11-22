import type { ActivityState, WorldJsonObject } from '@perspectra/sdk/contracts'
import {
  EQUIPMENT_STATUS,
  isSpentItem,
  rpgStatKey,
  rpgMaxStatKey,
  type OfficialRpgBattleView,
} from '../official-pack-metadata.ts'
import type { rpgBook } from './rpg.ts'
import { op, session, playerControls, withRpgTrial } from './rpg-trial.ts'

type Book = ReturnType<typeof rpgBook>
type Item = Book['items'][number]
function itemScene(book: Book, item: Item) {
  if (item.location === book.config?.vault) throw new TypeError('物品尚在掉落仓库，此项试玩需要从地上可拾取的物品开始')
  const scene = book.scenes.find(s => s.location === item.location)
  if (!scene) throw new TypeError('物品起始地点还没有场景')
  return scene.id
}
async function playConsumable(
  stage: string,
  book: Book,
  item: Item,
  body: Record<string, unknown>,
  signal?: AbortSignal,
) {
  const restore = book.config?.consumables?.[item.id]?.restore,
    actor = book.config?.characters[book.player]
  if (!restore || !actor) throw new TypeError('请先配置玩家和物品的消耗品效果')
  const initial = body.initial ?? {}
  if (
    !initial ||
    typeof initial !== 'object' ||
    Array.isArray(initial) ||
    Object.keys(initial).some(k => !Object.hasOwn(restore, k))
  )
    throw new TypeError('起始数值只能使用此物品的恢复字段')
  const opening: Record<string, number> = {}
  for (const [key, amount] of Object.entries(restore)) {
    const max = actor.stats[key]!,
      value = Object.hasOwn(initial, key)
        ? (initial as Record<string, unknown>)[key]
        : Math.max(key === 'hp' && max > 0 ? 1 : 0, max - Math.max(1, Math.ceil(amount / 2)))
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > max)
      throw new TypeError('起始数值超出范围：' + key)
    opening[rpgStatKey(key)] = value
  }
  return session(
    stage,
    {
      scenes: { [book.player]: itemScene(book, item) },
      status: { characters: { [book.player]: opening } },
      skipAutoStart: book.activities.filter(a => a.location === item.location).map(a => a.key),
    },
    signal,
    async sim => {
      const controls = playerControls(sim, book.player, signal)
      await controls.itemAction(item.id, 'status:take', '当前不能拿起此物品，请核对物品操作和起始地点')
      const before = await controls.own()
      const use = await controls.itemAction(item.id, 'status:rpg-use', '拾取后没有可用的消耗品操作')
      const after = await controls.own(),
        view = await controls.view()
      const values = Object.entries(restore).map(([key, amount]) => {
        const from = before[rpgStatKey(key)],
          to = after[rpgStatKey(key)],
          max = before[rpgMaxStatKey(key)]
        if (
          typeof from !== 'number' ||
          typeof to !== 'number' ||
          typeof max !== 'number' ||
          to !== Math.min(max, from + amount)
        )
          throw new Error('实际恢复与配置不符：' + key)
        return { key, label: book.config!.stats.find(s => s.key === key)!.label, before: from, after: to, max, amount }
      })
      const spent = view.items?.find(i => i.id === item.id)
      if (
        !spent ||
        !isSpentItem(spent) ||
        view.actions.some(a => op(a) === 'status:rpg-use' && a.target?.id === item.id)
      )
        throw new Error('使用后未核实物品已用完')
      signal?.throwIfAborted()
      const retry = await sim.step({ kind: 'action', action: use.action })
      if (retry.fault) throw new Error('重复使用时发生插件错误')
      const refusal = retry.resolutions?.find(r => r.actorId === book.player && r.actionType === use.action.actionType)
      if (refusal?.accepted !== false && retry.error !== '当前已知条件不允许这个操作，什么都没有发生。')
        throw new Error(retry.error ?? '重复使用没有被拒绝')
      const last = await controls.own()
      if (values.some(v => last[rpgStatKey(v.key)] !== v.after)) throw new Error('重复操作改变了恢复数值')
      return {
        kind: 'consumable' as const,
        item: item.id,
        values,
        reason: String(refusal?.reason ?? retry.error),
        spent: spent.kind,
      }
    },
  )
}
async function playEquipment(
  stage: string,
  book: Book,
  item: Item,
  body: Record<string, unknown>,
  signal?: AbortSignal,
) {
  const cfg = book.config!,
    gear = cfg.equipment?.[item.id],
    player = book.player
  if (!gear || !cfg.characters[player]?.slots?.includes(gear.slot)) throw new TypeError('玩家没有此装备需要的槽位')
  const map = cfg.maps?.find(m => m.locationId === body.location),
    scene = book.scenes.find(s => s.location === map?.locationId)
  const skill = cfg.skills?.find(
    s =>
      s.id === body.skill &&
      cfg.characters[player]?.skills?.includes(s.id) &&
      s.target === 'opponent' &&
      s.effects.some(e => e.kind === 'damage'),
  )
  if (!map?.enemies?.length || !scene || !skill) throw new TypeError('请选择有敌人的遭遇地图和玩家已学会的伤害技能')
  const location = map.locationId,
    skillName = skill.name,
    slot = gear.slot
  if (cfg.skills?.some(s => s.id !== skill.id && s.name === skillName && cfg.characters[player]!.skills.includes(s.id)))
    throw new TypeError('玩家有多个同名技能，当前操作无法区分：' + skillName)
  const activity = book.activities.find(a => a.location === location)!.key
  const scenes = Object.fromEntries(
    Object.keys(cfg.characters).map(c => [c, c === player ? itemScene(book, item) : scene.id]),
  )
  async function hit(equipped: boolean, targetId?: string) {
    return session(
      stage,
      { scenes, skipAutoStart: book.activities.filter(a => a.location === item.location).map(a => a.key) },
      signal,
      async sim => {
        const controls = playerControls(sim, player, signal)
        await controls.itemAction(item.id, 'status:take', '玩家在起始地点无法拾取装备')
        if (equipped) {
          await controls.itemAction(item.id, 'status:rpg-equip', '当前没有装备此物品的操作')
          const worn = (await controls.own())[EQUIPMENT_STATUS] as WorldJsonObject | undefined
          if (worn?.[slot] !== item.id) throw new Error('装备未进入目标槽位')
        } else await controls.step({ kind: 'wait' })
        let view = await controls.view()
        if (view.scene?.locationId !== location) {
          await controls.perform(
            view.actions.find(a => a.kind === 'move' && a.target?.id === location),
            '无法从物品起点进入所选遭遇',
          )
          view = await controls.view()
        }
        if (!view.activity?.active) {
          const start = view.actions.find(
            a => op(a) === 'host:activity-start' && a.target?.id === activity && !a.participantSelection,
          )
          if (start) view = await controls.performOption(start)
          else {
            await controls.step({ kind: 'wait' })
            view = await controls.view()
          }
        }
        async function act(operation: string, parameters: WorldJsonObject) {
          const active = view.activity
          if (
            active?.key !== activity ||
            !active.active ||
            !active.id ||
            active.revision === undefined ||
            !view.actions.some(a => op(a) === 'activity:' + operation && a.target?.id === activity)
          )
            throw new Error('当前遭遇没有可执行的' + operation + '操作')
          return controls.step({
            kind: 'activity',
            request: { activityKey: activity, activityId: active.id, revision: active.revision, operation, parameters },
          })
        }
        if (view.actions.some(a => op(a) === 'activity:engage' && a.target?.id === activity)) {
          await act('engage', {})
          view = await controls.view()
        }
        const battle =
          view.activityStage?.renderer === 'official-rpg.battle'
            ? (view.activityStage.payload as unknown as OfficialRpgBattleView)
            : undefined
        const offer = battle?.skills.find(s => s.name === skillName)
        const target = battle?.units.find(
          u => u.team === 'enemy' && u.hp > 0 && (!targetId || u.id === targetId) && offer?.targets.includes(u.name),
        )
        if (!target || !offer || offer.unavailable)
          throw new Error(offer?.unavailable ?? '遭遇没有可供此技能攻击的目标')
        if (battle?.units.some(u => u.id !== target.id && u.name === target.name))
          throw new Error('参战单位重名，当前操作无法区分：' + target.name)
        const trace = await act('skill', { skill: skillName, target: target.name })
        const line = trace.lines.find(l => l.kind === 'activity' && l.activityKey === activity && l.actorId === player)
        const update = sim.events().find(e => e.seq === line?.seq && e.eventType === 'activity.updated')
        const state = (update?.data as WorldJsonObject | undefined)?.state as ActivityState | undefined
        const units = state?.game.public.units
        const victim = Array.isArray(units)
          ? units.find(u => typeof u === 'object' && u !== null && !Array.isArray(u) && u.id === target.id)
          : undefined
        if (!victim || typeof victim !== 'object' || Array.isArray(victim) || typeof victim.hp !== 'number')
          throw new Error('缺少玩家本次出招后目标的生命记录')
        return {
          target: target.id,
          name: target.name,
          before: target.hp,
          after: victim.hp,
          damage: target.hp - victim.hp,
        }
      },
    )
  }
  const without = await hit(false),
    withGear = await hit(true, without.target)
  if (without.before !== withGear.before) throw new Error('两次出招前目标生命不同，无法直接对照，请更换遭遇或技能')
  return {
    kind: 'equipment' as const,
    item: item.id,
    location: map.locationId,
    skill: skill.name,
    without,
    withGear,
    difference: withGear.damage - without.damage,
  }
}
export async function playRpgItem(source: string, body: Record<string, unknown>, signal?: AbortSignal) {
  return withRpgTrial(source, async (stage, book) => {
    const item = book.items.find(i => i.id === body.id)
    if (!item || !book.enabled || !book.config) throw new TypeError('请选择已启用 RPG 的包内物品')
    if (body.kind === 'consumable') return await playConsumable(stage, book, item, body, signal)
    if (body.kind === 'equipment') return await playEquipment(stage, book, item, body, signal)
    throw new TypeError('请选择消耗品或装备试玩')
  })
}
