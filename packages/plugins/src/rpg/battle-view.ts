import { EMPTY_BATTLE_VALUES, valueSkillProblem, type RpgValueDisplay } from './battle-values.ts'
import { onlyHealing, skillTargetSide } from './combat-effects.ts'
import type { ActivityHooks } from '@perspectra/sdk'
import type { OfficialRpgBattleView, WorldJsonObject } from '@perspectra/sdk/contracts'
import type { MapBattleConfig } from './battle.ts'

// Object identity, not a pack-supplied title, key or claimed mode. Weak keys follow the native instance lifetime.
const officialBattles = new WeakMap<ActivityHooks, MapBattleConfig>()
export function registerOfficialBattle(hooks: ActivityHooks, config: MapBattleConfig): void {
  if (config.enemies.length) officialBattles.set(hooks, config)
}

/** No truth/internal input: the Host supplies the player's already scoped view and visible company. */
export function officialRpgBattleView(
  hooks: ActivityHooks,
  scoped: WorldJsonObject,
  actorId: string,
  present: readonly string[],
): OfficialRpgBattleView | undefined {
  const config = officialBattles.get(hooks)
  if (!config || actorId !== config.playerId || scoped.suspended) return
  const game = scoped.game as WorldJsonObject | undefined
  if (!game || game.active !== true || game.phase !== 'fighting') return
  const pub = game.public as WorldJsonObject | undefined
  if (
    !pub ||
    !Array.isArray(pub.units) ||
    !pub.units.length ||
    typeof scoped.id !== 'string' ||
    typeof scoped.activityKey !== 'string' ||
    !Number.isSafeInteger(scoped.revision) ||
    !Number.isSafeInteger(game.round) ||
    !(game.turn === null || typeof game.turn === 'string')
  )
    return
  // Whitelist only the already authorized projection; never request activity internal or world truth.
  const numbers = (raw: unknown): RpgValueDisplay[] | undefined => {
    if (!Array.isArray(raw)) return
    const result: RpgValueDisplay[] = []
    for (const row of raw) {
      if (
        !row ||
        typeof row !== 'object' ||
        typeof row.key !== 'string' ||
        typeof row.label !== 'string' ||
        !Number.isSafeInteger(row.value) ||
        !Number.isSafeInteger(row.min) ||
        !Number.isSafeInteger(row.max) ||
        row.value < row.min ||
        row.value > row.max
      )
        return
      result.push({ key: row.key, label: row.label, value: row.value, min: row.min, max: row.max })
    }
    return result
  }
  const values = pub.battleValues as WorldJsonObject | undefined
  const shared = values ? numbers(values.shared) : []
  if (!shared || (values && !Array.isArray(values.units))) return
  const unitValues = new Map<string, { attributes: RpgValueDisplay[]; resources: RpgValueDisplay[] }>()
  for (const raw of (values?.units ?? []) as WorldJsonObject[]) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return
    const attributes = numbers(raw.attributes),
      resources = numbers(raw.resources)
    if (typeof raw.unitId !== 'string' || !attributes || !resources) return
    unitValues.set(raw.unitId, { attributes, resources })
  }
  const units: OfficialRpgBattleView['units'][number][] = []
  for (const raw of pub.units) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return
    if (raw.team !== 'party' && raw.team !== 'enemy') return
    if (
      typeof raw.id !== 'string' ||
      typeof raw.name !== 'string' ||
      typeof raw.hp !== 'number' ||
      typeof raw.maxHp !== 'number' ||
      !Number.isFinite(raw.hp) ||
      !Number.isFinite(raw.maxHp) ||
      raw.maxHp <= 0 ||
      raw.hp < 0 ||
      raw.hp > raw.maxHp
    )
      return
    if (raw.team === 'party' && !present.includes(raw.id)) continue
    const display = Array.isArray(pub.combatEffects)
      ? (pub.combatEffects.find(
          row => row && typeof row === 'object' && !Array.isArray(row) && row.unitId === raw.id,
        ) as WorldJsonObject | undefined)
      : undefined
    const shield = display?.shield as WorldJsonObject | undefined
    if (
      shield &&
      (!Number.isSafeInteger(shield.amount) ||
        Number(shield.amount) <= 0 ||
        !Number.isSafeInteger(shield.remaining) ||
        Number(shield.remaining) <= 0)
    )
      return
    const statuses: NonNullable<OfficialRpgBattleView['units'][number]['statuses']>[number][] = []
    if (display) {
      if (!Array.isArray(display.statuses)) return
      for (const row of display.statuses) {
        if (
          !row ||
          typeof row !== 'object' ||
          Array.isArray(row) ||
          typeof row.name !== 'string' ||
          !Number.isSafeInteger(row.remaining) ||
          Number(row.remaining) <= 0
        )
          return
        if (
          (row.timing !== 'after-action' && row.timing !== 'round-end') ||
          (row.polarity !== 'positive' && row.polarity !== 'negative')
        )
          return
        statuses.push({ name: row.name, remaining: Number(row.remaining), timing: row.timing, polarity: row.polarity })
      }
    }
    units.push({
      id: raw.id,
      name: raw.name,
      team: raw.team,
      hp: raw.hp,
      maxHp: raw.maxHp,
      ...(unitValues.has(raw.id) ? unitValues.get(raw.id)! : {}),
      ...(shield ? { shield: { amount: Number(shield.amount), remaining: Number(shield.remaining) } } : {}),
      ...(statuses.length ? { statuses } : {}),
    })
  }
  if (!units.some(unit => unit.id === actorId) || !units.some(unit => unit.team === 'enemy')) return
  const own = pub.units.find(
    raw => raw && typeof raw === 'object' && !Array.isArray(raw) && raw.id === actorId,
  ) as WorldJsonObject
  const stats = own.stats as WorldJsonObject | undefined
  const skills = config.skills
    .filter(skill => config.characters[actorId]?.skills.includes(skill.id))
    .map(skill => {
      const eligible = units.filter(
        unit => unit.hp > 0 && unit.team === skillTargetSide(skill) && (skill.target !== 'self' || unit.id === actorId),
      )
      const targets = eligible
        .filter(
          unit =>
            !onlyHealing(skill) ||
            (skill.scope === 'all' ? eligible.some(target => target.hp < target.maxHp) : unit.hp < unit.maxHp),
        )
        .map(unit => unit.name)
      const missing = Object.keys(skill.cost).find(
        key => typeof stats?.[key] !== 'number' || Number(stats[key]) < skill.cost[key]!,
      )
      const ownValues = unitValues.get(actorId)
      const numericProblem = valueSkillProblem(
        skill,
        config.battleValues ?? EMPTY_BATTLE_VALUES,
        Object.fromEntries((ownValues?.resources ?? []).map(row => [row.key, row.value])),
        ref =>
          (ref.scope === 'shared'
            ? shared
            : ref.kind === 'attribute'
              ? ownValues?.attributes
              : ownValues?.resources
          )?.find(row => row.key === ref.key)?.value ?? 0,
      )
      return {
        name: skill.name,
        targets,
        ...(missing
          ? { unavailable: (config.stats.find(stat => stat.key === missing)?.label ?? missing) + '不足' }
          : numericProblem
            ? { unavailable: numericProblem }
            : {}),
      }
    })
  return {
    kind: 'official-rpg-battle',
    activityKey: scoped.activityKey,
    activityId: scoped.id,
    revision: Number(scoped.revision),
    title: config.title,
    round: Number(game.round),
    turn: game.turn,
    lastResult: typeof pub.lastResult === 'string' ? pub.lastResult : '',
    units,
    ...(shared.length ? { sharedValues: shared } : {}),
    skills,
  }
}
