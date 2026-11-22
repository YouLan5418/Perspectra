import { currentLocation } from '@perspectra/core/kernel'
import type { ActivityState, StatusTruth, WorldJsonObject } from '@perspectra/sdk/contracts'
import type { LensSimulation, LensActionSpec } from '../simulation/simulation.ts'
import { readPartyList, rpgMaxStatKey, rpgStatKey } from '../official-pack-metadata.ts'
import type { rpgBook } from './rpg.ts'
import { op, playerControls, session, withRpgTrial } from './rpg-trial.ts'

type Book = ReturnType<typeof rpgBook>
type Request = Record<string, unknown>
const truth = async (sim: LensSimulation) => (await sim.statusTruth()) as unknown as StatusTruth
function sceneAt(book: Book, location: unknown) {
  const scene = book.scenes.find(s => s.location === location && s.location !== book.config?.vault)
  if (!scene) throw new TypeError('请选择有场景、可供角色进入的地点')
  return scene
}

async function rest(stage: string, book: Book, body: Request, signal?: AbortSignal) {
  const scene = sceneAt(book, body.location),
    config = book.config!,
    player = book.player
  const actor = config.characters[player]
  if (!actor) throw new TypeError('请先配置玩家的 RPG 属性')
  const opening = Object.fromEntries(
    Object.entries(actor.stats).map(([k, max]) => [rpgStatKey(k), Math.floor(max / 2)]),
  )
  return session(
    stage,
    {
      scenes: { [player]: scene.id },
      status: { characters: { [player]: opening } },
      skipAutoStart: book.activities.filter(a => a.location === scene.location).map(a => a.key),
    },
    signal,
    async sim => {
      const controls = playerControls(sim, player, signal),
        before = await controls.own()
      const offer = (await controls.view()).actions.find(a => op(a) === 'status:rpg-rest')
      if (!!offer !== (config.rest?.locations.includes(scene.location) ?? false))
        throw new Error('当前可用的休息操作与地点配置不符')
      if (offer) await controls.perform(offer, '缺少休息操作')
      const after = await controls.own()
      const values = config.stats.map(({ key, label }) => {
        const from = before[rpgStatKey(key)],
          to = after[rpgStatKey(key)],
          max = before[rpgMaxStatKey(key)]
        if (typeof from !== 'number' || typeof max !== 'number' || to !== (offer ? max : from))
          throw new Error('休息数值与配置不符：' + label)
        return { key, label, before: from, after: to, max }
      })
      return { kind: 'rest' as const, location: scene.location, available: !!offer, values }
    },
  )
}

async function battleEnd(stage: string, book: Book, body: Request, kind: 'defeat' | 'retreat', signal?: AbortSignal) {
  const scene = sceneAt(book, body.location),
    cfg = book.config!,
    key = book.activities.find(a => a.location === scene.location)?.key
  if (!key || !cfg.maps?.some(m => m.locationId === scene.location && m.enemies?.length))
    throw new TypeError('请选择有敌人的遭遇地图')
  const actors = Object.keys(cfg.characters)
  const scenes = Object.fromEntries(actors.map(id => [id, scene.id]))
  const characters = Object.fromEntries(
    actors.map(id => [id, { [rpgStatKey('hp')]: Math.min(cfg.characters[id]!.stats.hp!, id === book.player ? 2 : 1) }]),
  )
  return session(stage, kind === 'defeat' ? { scenes, status: { characters } } : { scenes }, signal, async sim => {
    const controls = playerControls(sim, book.player, signal)
    sim.setNpcPlans(
      Object.fromEntries(
        actors
          .filter(id => id !== book.player)
          .map(id => [
            id,
            Array.from({ length: 32 }, () => ({ kind: 'perform' as const, interact: 'activity:guard' })),
          ]),
      ),
    )
    let view = await controls.view()
    if (!view.activity?.active) {
      const start = view.actions.find(
        a => op(a) === 'host:activity-start' && a.target?.id === key && !a.participantSelection,
      )
      if (start) view = await controls.performOption(start)
      else {
        await controls.step({ kind: 'wait' })
        view = await controls.view()
      }
    }
    function state() {
      const e = sim
        .events()
        .findLast(e => e.eventType === 'activity.updated' && (e.data as WorldJsonObject).activityKey === key)
      return (e?.data as WorldJsonObject | undefined)?.state as ActivityState | undefined
    }
    async function act(operation: string) {
      const a = view.activity
      if (
        a?.key !== key ||
        !a?.active ||
        !a.id ||
        a.revision === undefined ||
        !view.actions.some(o => op(o) === 'activity:' + operation && o.target?.id === key)
      )
        throw new Error('遭遇当前没有可执行的操作：' + operation)
      await controls.step({
        kind: 'activity',
        request: { activityKey: key!, activityId: a.id, revision: a.revision, operation, parameters: {} },
      })
      view = await controls.view()
    }
    if (view.actions.some(o => op(o) === 'activity:engage' && o.target?.id === key)) await act('engage')
    const expected = kind === 'defeat' ? 'defeat' : 'fled'
    let before = await truth(sim)
    const operation = kind === 'defeat' ? 'guard' : 'flee'
    for (let i = 0; i < 32 && state()?.game.active; i++) {
      if (view.actions.some(a => op(a) === 'activity:' + operation && a.target?.id === key)) {
        if (kind === 'retreat') before = await truth(sim)
        await act(operation)
      } else {
        const retry = view.actions.find(a => op(a) === 'host:activity-retry' && a.target?.id === key)
        if (!retry) break
        const revision = view.activity?.revision
        view = await controls.performOption(retry)
        if (revision === view.activity?.revision) break
      }
    }
    const end = state()
    if (end?.game.phase !== expected || end.game.active)
      throw new Error('未能触发预期结算（' + (end?.game.phase ?? '未开战') + '），请检查敌人的伤害、速度或演出。')
    const after = await truth(sim)
    const destination = (kind === 'defeat' || cfg.retreat === 'back' ? cfg.defeat?.to : undefined) ?? scene.location
    const participants = end.participants.map(id => {
      const location = currentLocation(sim.events(), id)
      if (location !== destination) throw new Error('结算后的实际地点与配置不符：' + id)
      const values = cfg.stats.map(({ key: stat, label }) => {
        const value = after.characters[id]?.[rpgStatKey(stat)],
          prior = before.characters[id]?.[rpgStatKey(stat)]
        const restore = cfg.defeat?.restore?.[stat]
        const max = after.characters[id]?.[rpgMaxStatKey(stat)]
        if (
          typeof value !== 'number' ||
          typeof prior !== 'number' ||
          (kind === 'retreat' && value !== prior) ||
          (kind === 'defeat' &&
            restore !== undefined &&
            value !== (stat === 'hp' && typeof max === 'number' ? Math.min(max, restore) : restore))
        )
          throw new Error('结算属性与配置不符：' + id + ' / ' + label)
        return { key: stat, label, before: prior, after: value }
      })
      return { id, location, values }
    })
    if (!participants.some(p => p.id === book.player)) throw new Error('玩家未参与本次结算')
    return { kind, phase: expected, location: scene.location, destination, participants }
  })
}

async function party(stage: string, book: Book, body: Request, signal?: AbortSignal) {
  const leader = book.config!.party?.leader,
    member = book.characters.find(c => c.id === body.member && Object.hasOwn(book.config!.characters, c.id))?.id
  if (!leader || !member || member === leader) throw new TypeError('请配置队长，并选择另一名已配置 RPG 数值的角色试玩')
  const from = sceneAt(book, body.from),
    to = sceneAt(book, body.to)
  if (from.location === to.location) throw new TypeError('随行试玩需要两个不同的地点')
  const scenes = Object.fromEntries([book.player, leader, member].map(id => [id, from.id]))
  return session(
    stage,
    {
      scenes,
      skipAutoStart: book.activities.filter(a => [from.location, to.location].includes(a.location)).map(a => a.key),
    },
    signal,
    async sim => {
      const controls = playerControls(sim, book.player, signal)
      async function act(actor: string, spec: LensActionSpec) {
        if (actor !== book.player) {
          sim.setNpcPlans({ [actor]: [{ kind: 'perform', ...spec }] })
          await controls.step({ kind: 'say', text: '我们接下来怎么走？' })
        } else {
          const option = (await controls.view()).actions.find(a =>
            'move' in spec ? a.kind === 'move' && a.target?.id === spec.move : op(a) === spec.interact,
          )
          await controls.perform(option, '玩家当前无法执行队伍操作')
        }
      }
      const where = (id: string) => currentLocation(sim.events(), id)
      const members = async () => readPartyList((await truth(sim)).public)
      await act(member, { interact: 'status:rpg-join' })
      const joined = await members()
      if (!joined.includes(member)) throw new Error('成员未能在自己的行动中加入队伍')
      await act(leader, { move: to.location })
      const followed = where(member)
      if (where(leader) !== to.location || followed !== to.location)
        throw new Error('队长和成员未一同抵达目的地，请检查通行规则')
      if (where(book.player) !== to.location) await act(book.player, { move: to.location })
      await act(member, { interact: 'status:rpg-leave' })
      const left = await members()
      if (left.includes(member)) throw new Error('成员未能在自己的行动中离队')
      await act(leader, { move: from.location })
      const stayed = where(member)
      if (where(leader) !== from.location || stayed !== to.location) throw new Error('未核实队长返回后成员留在原地')
      return {
        kind: 'party' as const,
        leader,
        member,
        from: from.location,
        to: to.location,
        joined,
        followed,
        left,
        stayed,
      }
    },
  )
}
export async function playRpgJourney(source: string, body: Request, signal?: AbortSignal) {
  return withRpgTrial(source, async (stage, book) => {
    switch (body.kind) {
      case 'rest':
        return rest(stage, book, body, signal)
      case 'retreat':
      case 'defeat':
        return battleEnd(stage, book, body, body.kind, signal)
      case 'party':
        return party(stage, book, body, signal)
      default:
        throw new TypeError('请选择休息、战败、撤退或队伍试玩')
    }
  })
}
