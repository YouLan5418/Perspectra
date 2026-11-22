import {
  EMPTY_BATTLE_VALUES,
  initialBattleValues,
  clampValue,
  adjustedAmount,
  valueSkillProblem,
  costShortfall,
  type RpgBattleValues,
  type RpgValueState,
  type RpgValueRef,
  type RpgValuesProjection,
} from './battle-values.ts'
import {
  activeModifiers,
  combatAttributes,
  damageAfterMitigation,
  onlyHealing,
  skillTargetSide,
} from './combat-effects.ts'
import { registerOfficialBattle } from './battle-view.ts'
import type { ActivityState, StatusTruth, WorldJsonObject } from '@perspectra/sdk/contracts'
import type { ActivityHooks, MemoryRequest } from '@perspectra/sdk'
import type {
  RpgCharacter,
  RpgCombatStatus,
  RpgCue,
  RpgDefeat,
  RpgEnemy,
  RpgEquipment,
  RpgEngage,
  RpgNarration,
  RpgRetreat,
  RpgSkill,
  RpgStat,
} from './config.ts'
import { RPG_MAP_ACTIVITY_PHASES, heldEquipmentBonus, maxStatKey, statKey, type RpgItemSnapshot } from './state.ts'

export interface MapBattleConfig {
  readonly battleValues?: RpgBattleValues
  readonly title: string
  readonly playerId: string
  readonly npcIds: readonly string[]
  readonly names: Readonly<Record<string, string>>
  readonly locationId: string
  readonly narration: RpgNarration
  readonly engage: RpgEngage
  readonly enemies: readonly (RpgEnemy & { readonly id: string })[]
  readonly drops: readonly string[]
  readonly scripted: readonly RpgCue[]
  readonly stats: readonly Readonly<RpgStat>[]
  readonly characters: Readonly<Record<string, RpgCharacter>>
  readonly skills: readonly RpgSkill[]
  readonly combatStatuses: Readonly<Record<string, RpgCombatStatus>>
  readonly equipment: Readonly<Record<string, RpgEquipment>>
  readonly defeat?: RpgDefeat
  readonly retreat: RpgRetreat
  readonly lockDuringBattle: boolean
}

interface IndexedCue extends RpgCue {
  readonly index: number
}

interface PartyUnit {
  id: string
  name: string
  team: 'party'
  characterId: string
  hp: number | null
  maxHp: number | null
  stats: Record<string, number>
  attack?: number
  defense?: number
  speed: number
  guarded: boolean
}

interface EnemyUnit {
  id: string
  name: string
  team: 'enemy'
  hp: number
  maxHp: number
  attack: number
  defense: number
  speed: number
  guarded: boolean
}

type BattleUnit = PartyUnit | EnemyUnit

interface BattleShield {
  unitId: string
  amount: number
  remaining: number
}

interface BattleCondition {
  unitId: string
  statusId: string
  remaining: number
}

interface MapBattlePublicState {
  arrivedAtSeq: number
  visit: number
  cleared: boolean
  units: BattleUnit[]
  order: string[]
  cursor: number
  pending: number[]
  said: number[]
  noted: number[]
  lastCue: number | null
  lastResult: string
  phaseLabel: string
  instructions: string
  队伍?: string
  敌人?: string
  状态?: string
  battleValues?: RpgValuesProjection
  数值?: string
  combatEffects?: {
    unitId: string
    statuses: {
      name: string
      remaining: number
      timing: RpgCombatStatus['timing']
      polarity: RpgCombatStatus['polarity']
    }[]
    shield?: { amount: number; remaining: number }
  }[]
}

interface MapBattleGameState {
  active: boolean
  phase: (typeof RPG_MAP_ACTIVITY_PHASES)[number]
  turn: string | null
  round: number
  public: MapBattlePublicState
  private: Record<string, Record<string, never>>
  internal: {
    values?: RpgValueState
    present: string[]
    conditions: BattleCondition[]
    shields?: BattleShield[]
  }
}

interface MapWorldInput {
  readonly locationId?: string | null
  readonly arrivedAtSeq?: number
  readonly characterIds?: readonly string[]
  readonly participantHeldItems?: readonly RpgItemSnapshot[]
  readonly items?: {
    readonly current?: readonly RpgItemSnapshot[]
  }
}

const NO_INPUT_SCHEMA: WorldJsonObject = {
  type: 'object',
  additionalProperties: false,
  properties: {},
}

const BATTLE_PHASES = new Set(['encounter', 'fighting'])
const CUE_PHASES = new Set(['enter', 'encounter', 'aftermath'])
const ITEM_OPERATIONS = [
  'status:take',
  'status:drop',
  'status:give',
  'status:rpg-use',
  'status:rpg-equip',
  'status:rpg-unequip',
  'status:rpg-unlock',
  'status:rpg-rest',
  'status:rpg-join',
  'status:rpg-leave',
]

function cloneGame(value: unknown): MapBattleGameState {
  return structuredClone(value) as MapBattleGameState
}

/** 构造单张地图的探索演出与回合战斗原生活动钩子。 */
export function createRpgMapBattleHooks(config: MapBattleConfig): ActivityHooks {
  const playerId = config.playerId
  const party = [playerId, ...config.npcIds]
  // Target buttons and their schema share display names. Distinguish homonyms within this encounter only.
  const unitsById = [...party.map(id => ({ id, name: config.names[id] || id })), ...config.enemies]
  const reserved = new Set(unitsById.map(u => u.name))
  const battleNames = new Map<string, string>()
  for (const unit of unitsById) {
    if (!unitsById.some(other => other.id !== unit.id && other.name === unit.name)) continue
    let label = unit.name + ' · ' + unit.id
    while (reserved.has(label)) label += '·'
    reserved.add(label)
    battleNames.set(unit.id, label)
  }
  const nameOf = (id: string): string => battleNames.get(id) || config.names[id] || id
  const statLabel = (key: string): string => config.stats.find(stat => stat.key === key)?.label ?? key
  const skillById = (id: string): RpgSkill | undefined => config.skills.find(skill => skill.id === id)
  const statusById = (id: string): RpgCombatStatus | undefined => config.combatStatuses[id]
  const valueDefs = config.battleValues ?? EMPTY_BATTLE_VALUES
  const initialFor = (id: string) =>
    config.characters[id]?.battleValues ?? config.enemies.find(e => e.id === id)?.battleValues
  const attributeValue = (game: MapBattleGameState, id: string, key: string) => {
    const def = valueDefs.attributes[key]!
    const modifiers = game.internal.conditions
      .filter(row => row.unitId === id)
      .reduce((sum, row) => sum + (statusById(row.statusId)?.attributeModifiers?.[key] ?? 0), 0)
    return clampValue((initialFor(id)?.attributes?.[key] ?? def.initial) + modifiers, def)
  }
  const readValue = (game: MapBattleGameState, actor: string, target: string, ref: RpgValueRef): number =>
    ref.scope === 'shared'
      ? game.internal.values!.shared[ref.key]!
      : ref.kind === 'attribute'
        ? attributeValue(game, ref.scope === 'actor' ? actor : target, ref.key)
        : (game.internal.values!.units[ref.scope === 'actor' ? actor : target]?.[ref.key] ?? 0)
  const valueProblem = (game: MapBattleGameState, actor: string, skill: RpgSkill) =>
    valueSkillProblem(skill, valueDefs, game.internal.values?.units[actor] ?? {}, ref =>
      readValue(game, actor, actor, ref),
    )
  const enemies = config.enemies.map(e => ({ ...e, name: battleNames.get(e.id) ?? e.name }))
  const enemyName = (id: string): string => enemies.find(enemy => enemy.id === id)?.name ?? id
  const unitNames = [...party.map(nameOf), ...enemies.map(enemy => enemy.name)]
  const skillNames: string[] = []
  for (const id of party) {
    for (const skillId of config.characters[id]?.skills ?? []) {
      const skill = skillById(skillId)
      if (skill && !skillNames.includes(skill.name)) skillNames.push(skill.name)
    }
  }

  const cues: IndexedCue[] = config.scripted
    .map((cue, index) => ({ ...cue, index }))
    .filter(cue => config.npcIds.includes(cue.characterId))
  const cueAt = (index: number | null | undefined): IndexedCue | undefined =>
    typeof index === 'number' ? cues.find(cue => cue.index === index) : undefined
  const cuesFor = (when: RpgCue['when']): IndexedCue[] => cues.filter(cue => cue.when === when)
  const turnCue = (characterId: string, round: number): IndexedCue | undefined =>
    cues.find(cue => cue.when === 'turn' && cue.round === round && cue.characterId === characterId)
  const skillOf = (cue: IndexedCue | undefined): RpgSkill | undefined => (cue?.skill ? skillById(cue.skill) : undefined)

  const fighting = enemies.length > 0
  const battleOperations = config.lockDuringBattle ? [] : ['status:rpg-leave']

  const operations: WorldJsonObject[] = []
  if (fighting) {
    operations.push({
      id: 'skill',
      label: '使用技能',
      requiresTurn: true,
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['skill', 'target'],
        properties: {
          skill: { title: '技能', type: 'string', enum: skillNames },
          target: { title: '目标', type: 'string', enum: unitNames },
        },
      },
    })
    operations.push({ id: 'guard', label: '防御', requiresTurn: true, schema: NO_INPUT_SCHEMA })
    operations.push({ id: 'flee', label: '撤退', requiresTurn: true, schema: NO_INPUT_SCHEMA })
    if (config.engage === 'optional') {
      operations.push({ id: 'engage', label: '开战', requiresTurn: true, schema: NO_INPUT_SCHEMA })
      operations.push({ id: 'leave', label: '离开', requiresTurn: true, schema: NO_INPUT_SCHEMA })
    }
  }

  const freshEnemies = (): EnemyUnit[] =>
    enemies.map(enemy => ({
      id: enemy.id,
      name: enemy.name,
      team: 'enemy',
      hp: enemy.hp,
      maxHp: enemy.hp,
      attack: enemy.attack,
      defense: enemy.defense,
      speed: enemy.speed,
      guarded: false,
    }))

  const partyUnits = (): PartyUnit[] =>
    party.map(id => ({
      id,
      name: nameOf(id),
      team: 'party',
      characterId: id,
      hp: null,
      maxHp: null,
      stats: {},
      speed: config.characters[id]?.speed ?? 0,
      guarded: false,
    }))

  const isAlive = (unit: BattleUnit): boolean => unit.hp === null || unit.hp > 0
  const enemyLine = (enemy: BattleUnit, line: 'encounter' | 'defeated'): string => {
    const text = enemies.find(entry => entry.id === enemy.id)?.lines[line]
    return text ? `${enemy.name}说：「${text}」` : ''
  }
  const words = (list: readonly (string | undefined | null | false)[]): string => list.filter(Boolean).join(' ')

  const summarize = (game: MapBattleGameState): MapBattleGameState => {
    const pub = game.public
    if (game.internal.values) {
      const display = (group: RpgBattleValues['shared'], read: (key: string) => number) =>
        Object.entries(group).map(([key, def]) => ({
          key,
          label: def.label,
          min: def.min,
          max: def.max,
          value: read(key),
        }))
      pub.battleValues = {
        shared: display(valueDefs.shared, key => game.internal.values!.shared[key]!),
        units: pub.units
          .filter(unit => unit.team === 'enemy' || game.internal.present.includes(unit.id))
          .map(unit => ({
            unitId: unit.id,
            attributes: display(valueDefs.attributes, key => attributeValue(game, unit.id, key)),
            resources: display(valueDefs.resources, key => game.internal.values!.units[unit.id]?.[key] ?? 0),
          })),
      }
      pub['数值'] = [
        ...pub.battleValues.shared.map(row => `${row.label} ${row.value}`),
        ...pub.battleValues.units.flatMap(unit =>
          [...unit.attributes, ...unit.resources].map(
            row =>
              `${nameOf(unit.unitId) === unit.unitId ? enemyName(unit.unitId) : nameOf(unit.unitId)}：${row.label} ${row.value}/${row.max}`,
          ),
        ),
      ].join('；')
    }
    pub['队伍'] = pub.units
      .filter((unit): unit is PartyUnit => unit.team === 'party' && unit.hp !== null)
      .map(unit => {
        const extra = config.stats
          .filter(stat => stat.key !== 'hp')
          .map(stat => `${stat.label} ${unit.stats[stat.key] ?? 0}`)
        return `${unit.name}：生命 ${unit.hp}/${unit.maxHp}${extra.length ? `，${extra.join('，')}` : ''}`
      })
      .join('；')
    pub['敌人'] = pub.units
      .filter((unit): unit is EnemyUnit => unit.team === 'enemy')
      .map(unit => `${unit.name}：生命 ${unit.hp}/${unit.maxHp}${unit.hp <= 0 ? '（倒下）' : ''}`)
      .join('；')
    pub['状态'] = (game.internal.conditions ?? [])
      .map(({ unitId, statusId, remaining }) => {
        const unit = pub.units.find(entry => entry.id === unitId)
        const status = statusById(statusId)
        return `${unit?.name ?? unitId}：${status?.name ?? statusId}（剩余 ${remaining} 回合）`
      })
      .join('；')
    pub.combatEffects = pub.units.map(unit => {
      const shield = game.internal.shields?.find(entry => entry.unitId === unit.id)
      return {
        unitId: unit.id,
        statuses: (game.internal.conditions ?? [])
          .filter(entry => entry.unitId === unit.id)
          .map(entry => ({
            name: statusById(entry.statusId)!.name,
            remaining: entry.remaining,
            timing: statusById(entry.statusId)!.timing,
            polarity: statusById(entry.statusId)!.polarity,
          })),
        ...(shield ? { shield: { amount: shield.amount, remaining: shield.remaining } } : {}),
      }
    })
    const shieldText = (game.internal.shields ?? [])
      .map(
        shield =>
          `${pub.units.find(unit => unit.id === shield.unitId)?.name}：护盾 ${shield.amount}（剩余 ${shield.remaining} 次行动）`,
      )
      .join('；')
    if (shieldText) pub['状态'] = [pub['状态'], shieldText].filter(Boolean).join('；')
    const phaseMap: Partial<Record<MapBattleGameState['phase'], string>> = {
      enter: config.title,
      standby: '敌人就在前方',
      encounter: '遇敌',
      fighting: `战斗中 · 第${game.round}轮`,
      aftermath: '战斗胜利',
    }
    pub.phaseLabel = phaseMap[game.phase] ?? pub.phaseLabel
    return game
  }

  const finish = (game: MapBattleGameState, phase: MapBattleGameState['phase'], label: string): MapBattleGameState => {
    game.active = false
    game.phase = phase
    game.turn = null
    game.internal.conditions = []
    game.internal.shields = []
    game.public['状态'] = ''
    game.public.phaseLabel = label
    return game
  }

  const queue = (
    game: MapBattleGameState,
    phase: MapBattleGameState['phase'],
    list: readonly IndexedCue[],
    after: (state: MapBattleGameState) => MapBattleGameState,
  ): MapBattleGameState => {
    if (!list.length) return after(game)
    game.phase = phase
    game.public.pending = list.map(cue => cue.index)
    game.turn = list[0]!.characterId
    return summarize(game)
  }

  const startFighting = (game: MapBattleGameState): MapBattleGameState => {
    const here = game.internal.present || party
    const order = game.public.units
      .filter(unit => (unit.hp ?? 0) > 0 && (unit.team === 'enemy' || here.includes(unit.id)))
      .slice()
      .sort((a, b) => b.speed - a.speed)
      .map(unit => unit.id)
    game.public.order = order
    game.public.cursor = order.findIndex(id => party.includes(id) && here.includes(id))
    if (game.public.cursor === -1) return finish(game, 'left', '队伍无人能够战斗')
    game.phase = 'fighting'
    game.turn = order[game.public.cursor]!
    game.round = 1
    return summarize(game)
  }

  const encounter = (game: MapBattleGameState): MapBattleGameState => {
    const here = game.internal.present
    const standing = game.public.units.filter(
      unit => unit.team === 'party' && here.includes(unit.id) && (unit.hp ?? 0) > 0,
    )
    if (!standing.length) {
      game.public.lastResult = '队伍无人能够战斗。'
      return finish(game, 'left', '队伍无人能够战斗')
    }
    game.public.lastResult = words([
      game.public.lastResult,
      ...game.public.units.filter(u => u.team === 'enemy').map(u => enemyLine(u, 'encounter')),
    ])
    const openingCues = cuesFor('encounter').filter(
      cue => !cue.skill || standing.some(unit => unit.id === cue.characterId),
    )
    return queue(game, 'encounter', openingCues, startFighting)
  }

  const afterEnter = (game: MapBattleGameState): MapBattleGameState => {
    if (!fighting || game.public.cleared) return finish(game, 'done', config.title)
    if (config.engage === 'optional') {
      game.phase = 'standby'
      game.turn = playerId
      return summarize(game)
    }
    return encounter(game)
  }

  const afterVictory = (game: MapBattleGameState): MapBattleGameState => finish(game, 'victory', '战斗胜利')

  const nextAfterCue = (game: MapBattleGameState): MapBattleGameState => {
    if (game.public.pending.length) {
      const nextCue = cueAt(game.public.pending[0])
      if (nextCue) game.turn = nextCue.characterId
      return summarize(game)
    }
    if (game.phase === 'enter') return afterEnter(game)
    if (game.phase === 'encounter') return startFighting(game)
    return afterVictory(game)
  }

  const syncPartyStats = (game: MapBattleGameState, truth: StatusTruth | null | undefined, world: MapWorldInput) => {
    const items = world.items?.current ?? []
    for (const unit of game.public.units) {
      if (unit.team !== 'party') continue
      const own = (truth?.characters[unit.id] ?? {}) as WorldJsonObject
      unit.hp = Number(own[statKey('hp')] ?? 0)
      unit.maxHp = Number(own[maxStatKey('hp')] ?? 0)
      for (const stat of config.stats) unit.stats[stat.key] = Number(own[statKey(stat.key)] ?? 0)
      const base = config.characters[unit.id]
      const bonus = heldEquipmentBonus(config.equipment, truth, items, unit.id)
      unit.attack = (base?.attack ?? 0) + bonus.attack
      unit.defense = (base?.defense ?? 0) + bonus.defense
    }
  }

  const unavailableCueReason = (cue: IndexedCue | undefined, game: MapBattleGameState): string | null => {
    const used = skillOf(cue)
    if (!cue || !used) return null
    const own = game.public.units.find(
      (unit): unit is PartyUnit => unit.team === 'party' && unit.id === cue.characterId,
    )
    if (!own || own.hp === null) return null
    if (own.hp <= 0) return `${nameOf(cue.characterId)}已经倒下`
    for (const key of Object.keys(used.cost)) {
      if (costShortfall(own.stats[key] ?? 0, used.cost[key]!) > 0) return `${statLabel(key)}不足`
    }
    const unavailableValue = valueProblem(game, cue.characterId, used)
    if (unavailableValue) return unavailableValue
    if (cue.target) {
      const target = game.public.units.find(unit => unit.id === cue.target)
      if (!target || (target.hp ?? 0) <= 0) return `${enemyName(cue.target)}已经倒下`
    }
    return null
  }

  const noteUnavailable = (
    game: MapBattleGameState,
    cue: IndexedCue | undefined,
    notes: string[],
    explicitReason?: string | null,
  ) => {
    if (!cue || !cue.skill || game.public.noted.includes(cue.index)) return
    const reason = explicitReason ?? unavailableCueReason(cue, game)
    if (!reason) return
    const used = skillOf(cue)
    if (!used) return
    game.public.noted.push(cue.index)
    notes.push(`写死的技能不可用：${reason}（${nameOf(cue.characterId)}的${used.name}）。`)
  }

  const scheduleState = (state: ActivityState): WorldJsonObject => {
    const game = state.game as unknown as MapBattleGameState
    return game.active && game.turn !== playerId && game.turn !== null
      ? { kind: 'activate', characterId: game.turn }
      : { kind: 'wait' }
  }

  const hooks: ActivityHooks = {
    definition: { title: config.title, npcIds: [...config.npcIds], operations },
    phases: RPG_MAP_ACTIVITY_PHASES,

    autoStart(_truth, worldRaw, previousRaw) {
      const world = worldRaw as unknown as MapWorldInput
      const previous = previousRaw as { readonly game?: { readonly public?: Partial<MapBattlePublicState> } } | null
      const first = previous === null
      const cleared = !first && previous?.game?.public?.cleared === true
      const text = first ? config.narration.first : config.narration.again || config.narration.first
      const greets =
        fighting && !cleared && config.engage !== 'optional' && !(first && cuesFor('enter').length)
          ? enemies.map(enemy => (enemy.lines.encounter ? `${enemy.name}说：「${enemy.lines.encounter}」` : ''))
          : []
      const notice = words([text, ...greets]).slice(0, 500)
      const presentIds = world.characterIds ?? []
      return {
        when: [
          [`玩家在${config.title}`, world.locationId === config.locationId],
          ['刚刚到达这里', first || previous?.game?.public?.arrivedAtSeq !== world.arrivedAtSeq],
          ['同行的人都在场', config.npcIds.every(id => presentIds.includes(id))],
        ],
        notice,
        sceneNotice: notice,
      }
    },

    initialize(input) {
      const npcIds = (input.npcIds as readonly string[] | undefined) ?? []
      const world = (input.world ?? {}) as unknown as MapWorldInput
      const previous = (input.previous ?? null) as {
        readonly game?: { readonly public?: Partial<MapBattlePublicState> }
      } | null
      const truth = (input.truth ?? null) as StatusTruth | null
      const prior = previous?.game?.public ?? null
      const presentIds = world.characterIds ?? []
      const game: MapBattleGameState = {
        active: true,
        phase: 'enter',
        turn: playerId,
        round: 1,
        public: {
          arrivedAtSeq: Number(world.arrivedAtSeq ?? 0),
          visit: Number(prior?.visit ?? 0) + 1,
          cleared: Boolean(prior?.cleared),
          units: [...partyUnits(), ...(prior?.cleared ? [] : freshEnemies())],
          order: [],
          cursor: 0,
          pending: [],
          said: [],
          noted: [],
          lastCue: null,
          lastResult: '',
          phaseLabel: config.title,
          instructions: fighting
            ? '轮到你时，用“使用技能”选择技能和目标，或“防御”。敌人按规则行动；伤害与数值以程序结果为准。'
            : '',
        },
        private: Object.fromEntries([playerId, ...npcIds].map(id => [id, {}])),
        internal: {
          present: party.filter(id => id === playerId || presentIds.includes(id)),
          conditions: [],
        },
      }
      game.internal.values = initialBattleValues(
        valueDefs,
        game.public.units.map(unit => {
          const values = initialFor(unit.id)
          return { id: unit.id, ...(values ? { values } : {}) }
        }),
      )
      if (fighting && !game.public.cleared) syncPartyStats(game, truth, world)
      const enter = game.public.visit === 1 ? cuesFor('enter') : []
      return queue(game, 'enter', enter, afterEnter) as unknown as WorldJsonObject
    },

    policy(scoped, actorId) {
      const game = (scoped as unknown as { readonly game: MapBattleGameState }).game
      const own = game.public.units.find(unit => unit.id === actorId)
      const battle = BATTLE_PHASES.has(game.phase)
      let ops: string[] = []
      if (game.turn === actorId && own && isAlive(own)) {
        if (game.phase === 'fighting') ops = ['skill', 'guard', ...(actorId === playerId ? ['flee'] : [])]
        if (game.phase === 'encounter' && skillOf(cueAt(game.public.pending[0]))) ops = ['skill', 'guard']
      }
      if (game.phase === 'standby' && actorId === playerId) ops = ['engage', 'leave']
      return {
        speech: 'free',
        speechChoices: [],
        narration: true,
        move: false,
        interactions: battle ? battleOperations : ITEM_OPERATIONS,
        operations: ops,
      }
    },

    resolve(state, actorId, operation, parameters, worldRaw, truth, roll) {
      const world = worldRaw as unknown as MapWorldInput
      const game = cloneGame(state.game)
      const pub = game.public
      game.internal.conditions ??= []
      game.internal.shields ??= []
      const refreshedShields = new Set<string>()
      const reject = (rejectReason: string): WorldJsonObject => ({ rejectReason })
      const worldCharacters = world.characterIds ?? []
      const present = party.filter(id => id === actorId || worldCharacters.includes(id))
      game.internal.present = present
      const remains = (id: string) => !party.includes(id) || present.includes(id)
      game.internal.conditions = game.internal.conditions.filter(row => remains(row.unitId))
      game.internal.shields = game.internal.shields.filter(row => remains(row.unitId))
      const descriptions: string[] = []
      const notes: string[] = []
      const out: Record<string, unknown> = { audience: 'participants' }
      pub.lastCue = null
      syncPartyStats(game, truth, world)
      const before = structuredClone(pub.units.filter((unit): unit is PartyUnit => unit.team === 'party'))

      const finalize = (): WorldJsonObject => {
        const changes: { holderId: string; key: string; value: number }[] = []
        for (const unit of pub.units) {
          if (unit.team !== 'party') continue
          const was = before.find(entry => entry.id === unit.id)
          unit.stats.hp = unit.hp ?? 0
          for (const stat of config.stats) {
            const currentVal = unit.stats[stat.key] ?? 0
            if (was && was.stats[stat.key] !== currentVal) {
              changes.push({ holderId: unit.id, key: statKey(stat.key), value: currentVal })
            }
          }
        }
        if (changes.length) {
          const reveals: { observerId: string; holderId: string; key: string }[] = []
          for (const change of changes) {
            for (const observerId of present) {
              reveals.push({ observerId, holderId: change.holderId, key: change.key })
            }
          }
          out.status = { changes, reveals }
        }
        const description = words([...descriptions, ...notes]) || '无事发生。'
        pub.lastResult = description
        summarize(game)
        return { game: game as unknown as WorldJsonObject, description, ...out } as WorldJsonObject
      }

      if (operation === 'leave' || operation === 'engage') {
        if (game.phase !== 'standby' || actorId !== playerId) return reject('现在不能这样做。')
        if (operation === 'leave') {
          finish(game, 'left', config.title)
          descriptions.push('你们没有惊动敌人。')
        } else {
          descriptions.push('你们向敌人发起了挑战。')
          pub.lastResult = ''
          const next = encounter(game)
          descriptions.push(pub.lastResult)
          if (next.phase === 'encounter') noteUnavailable(game, cueAt(pub.pending[0]), notes)
        }
        return finalize()
      }

      const units = pub.units
      const heldSource = world.participantHeldItems ?? world.items?.current ?? []
      const effective = new Map(
        units
          .filter((unit): unit is PartyUnit => unit.team === 'party')
          .map(unit => {
            const bonus = heldEquipmentBonus(config.equipment, truth, heldSource, unit.id)
            const base = config.characters[unit.id]
            return [
              unit.id,
              {
                attack: (base?.attack ?? 0) + bonus.attack,
                defense: (base?.defense ?? 0) + bonus.defense,
                fire: Math.min(75, bonus.fire),
              },
            ]
          }),
      )
      const own = units.find((unit): unit is PartyUnit => unit.team === 'party' && unit.id === actorId)
      const cueNow =
        game.phase === 'encounter'
          ? cueAt(pub.pending[0])
          : game.phase === 'fighting'
            ? turnCue(actorId, game.round)
            : undefined
      if (!BATTLE_PHASES.has(game.phase) || game.turn !== actorId || !own) return reject('尚未轮到你。')
      if ((own.hp ?? 0) <= 0) return reject('你已失去战斗能力。')
      if (operation === 'flee' && (actorId !== playerId || game.phase !== 'fighting')) return reject('现在不能撤退。')

      const isHere = (unit: BattleUnit): boolean => unit.team === 'enemy' || present.includes(unit.id)
      const outcome = (): 'defeat' | 'victory' | null =>
        !units.some(unit => unit.team === 'party' && isHere(unit) && (unit.hp ?? 0) > 0)
          ? 'defeat'
          : !units.some(unit => unit.team === 'enemy' && unit.hp > 0)
            ? 'victory'
            : null

      const attributes = (unit: BattleUnit) =>
        combatAttributes(
          {
            attack: effective.get(unit.id)?.attack ?? unit.attack ?? 0,
            defense: effective.get(unit.id)?.defense ?? unit.defense ?? 0,
            fireResistance: effective.get(unit.id)?.fire ?? 0,
          },
          activeModifiers(unit.id, game.internal.conditions, config.combatStatuses),
        )

      const applyStatus = (victim: BattleUnit, statusId: string) => {
        const status = statusById(statusId)!
        const current = game.internal.conditions.find(
          entry => entry.unitId === victim.id && entry.statusId === statusId,
        )
        if (current) current.remaining = status.turns
        else game.internal.conditions.push({ unitId: victim.id, statusId, remaining: status.turns })
        descriptions.push(`${victim.name}${current ? '的状态持续时间刷新：' : '获得状态：'}${status.name}。`)
      }
      const changeValue = (scope: 'shared' | 'unit', key: string, delta: number, unit?: BattleUnit) => {
        const def = scope === 'shared' ? valueDefs.shared[key]! : valueDefs.resources[key]!
        const bag = scope === 'shared' ? game.internal.values!.shared : game.internal.values!.units[unit!.id]!
        const before = bag[key]!,
          after = clampValue(before + delta, def)
        bag[key] = after
        if (before !== after) descriptions.push(`${unit ? unit.name + '的' : ''}${def.label} ${before} → ${after}。`)
        // One positive-to-zero transition, one status; status application cannot write resources or recurse.
        if (scope === 'unit' && before > 0 && after === 0 && (unit!.hp ?? 0) > 0) {
          const status = valueDefs.resources[key]!.onZeroStatus
          if (status) applyStatus(unit!, status)
        }
      }
      const hurt = (victim: BattleUnit, damage: number, label: string) => {
        const shield = game.internal.shields!.find(entry => entry.unitId === victim.id)
        if (shield) {
          const absorbed = Math.min(shield.amount, damage)
          shield.amount -= absorbed
          damage -= absorbed
          descriptions.push(`${victim.name}的护盾吸收 ${absorbed} 点伤害，剩余 ${shield.amount}。`)
          if (!shield.amount) {
            game.internal.shields = game.internal.shields!.filter(entry => entry !== shield)
            descriptions.push(`${victim.name}的护盾破碎。`)
          }
        }
        const from = victim.hp ?? 0
        victim.hp = Math.max(0, from - damage)
        descriptions.push(`${label}，${victim.name}生命 ${from} → ${victim.hp}。`)
        if (victim.hp > 0) {
          if (victim.hp < from)
            for (const [key, def] of Object.entries(valueDefs.resources))
              if (def.onHpLoss) changeValue('unit', key, def.onHpLoss, victim)
          return
        }
        game.internal.conditions = game.internal.conditions.filter(effect => effect.unitId !== victim.id)
        game.internal.shields = game.internal.shields!.filter(effect => effect.unitId !== victim.id)
        if (victim.team === 'enemy') descriptions.push(enemyLine(victim, 'defeated'))
      }

      const applySkill = (actor: BattleUnit, used: RpgSkill, targets: readonly BattleUnit[]) => {
        if (actor.team === 'party') {
          for (const key of Object.keys(used.cost)) actor.stats[key] = (actor.stats[key] ?? 0) - used.cost[key]!
        }
        for (const [key, cost] of Object.entries(used.resourceCost ?? {})) changeValue('unit', key, -cost, actor)
        const once = new Set<number>()
        for (const victim of targets) {
          const label = `${actor.name}使用${used.name}`
          for (const [effectIndex, effect] of used.effects.entries()) {
            if ((victim.hp ?? 0) <= 0 && !(effect.kind === 'value' && effect.scope !== 'target')) continue
            if (effect.kind === 'value') {
              if (effect.scope !== 'target' && once.has(effectIndex)) continue
              once.add(effectIndex)
              changeValue(
                effect.scope === 'shared' ? 'shared' : 'unit',
                effect.key,
                effect.delta,
                effect.scope === 'shared' ? undefined : effect.scope === 'actor' ? actor : victim,
              )
            } else if (effect.kind === 'heal') {
              const from = victim.hp ?? 0
              victim.hp = Math.min(
                victim.maxHp ?? from,
                from +
                  adjustedAmount(effect.amount, effect.adjustments, ref => readValue(game, actor.id, victim.id, ref)),
              )
              descriptions.push(`${label}，${victim.name}生命 ${from} → ${victim.hp}。`)
            } else if (effect.kind === 'damage') {
              const source = attributes(actor),
                target = attributes(victim)
              const damage = damageAfterMitigation(
                adjustedAmount(effect.amount, effect.adjustments, ref => readValue(game, actor.id, victim.id, ref)),
                source.attack,
                target.defense,
                Math.min(
                  75,
                  (effect.element === 'fire' ? target.fireResistance : 0) +
                    (effect.resistance ? attributeValue(game, victim.id, effect.resistance) : 0),
                ),
                effect.resistance ? 'fire' : effect.element,
                victim.guarded,
              )
              hurt(victim, damage, label)
              victim.guarded = false
              if (effect.element === 'fire' && target.fireResistance > 0)
                descriptions.push(`${victim.name}的火焰抗性降低了伤害。`)
            } else if (effect.kind === 'cleanse') {
              const removed = game.internal.conditions.filter(
                entry => entry.unitId === victim.id && statusById(entry.statusId)?.polarity === effect.polarity,
              )
              game.internal.conditions = game.internal.conditions.filter(entry => !removed.includes(entry))
              descriptions.push(
                `${label}，${victim.name}${removed.length ? '解除：' + removed.map(entry => statusById(entry.statusId)!.name).join('、') : '没有可解除的负面状态'}。`,
              )
            } else if (effect.kind === 'status') {
              applyStatus(victim, effect.status)
            } else if (effect.kind === 'shield') {
              game.internal.shields = game.internal.shields!.filter(entry => entry.unitId !== victim.id)
              game.internal.shields.push({ unitId: victim.id, amount: effect.amount, remaining: effect.turns })
              if (victim.id === actor.id) refreshedShields.add(victim.id)
              descriptions.push(
                `${label}，${victim.name}的护盾替换为 ${effect.amount}，持续 ${effect.turns} 次有效行动。`,
              )
            }
          }
        }
      }

      const settleConditions = (unit: BattleUnit, timing: RpgCombatStatus['timing']) => {
        for (const effect of game.internal.conditions.filter(entry => entry.unitId === unit.id)) {
          const status = statusById(effect.statusId)
          if (!status || status.timing !== timing) continue
          const tick = status.tick
          if (tick?.kind === 'damage') {
            const target = attributes(unit)
            const damage = damageAfterMitigation(
              adjustedAmount(tick.amount, tick.adjustments, ref => readValue(game, unit.id, unit.id, ref)),
              0,
              0,
              Math.min(
                75,
                (tick.element === 'fire' ? target.fireResistance : 0) +
                  (tick.resistance ? attributeValue(game, unit.id, tick.resistance) : 0),
              ),
              tick.resistance ? 'fire' : tick.element,
              false,
              true,
            )
            hurt(unit, damage, `${status.name}造成 ${damage} 点伤害`)
            if (tick.element === 'fire' && target.fireResistance > 0)
              descriptions.push(`${unit.name}的火焰抗性降低了伤害。`)
          } else if (tick?.kind === 'heal') {
            const from = unit.hp ?? 0
            unit.hp = Math.min(
              unit.maxHp ?? from,
              from + adjustedAmount(tick.amount, tick.adjustments, ref => readValue(game, unit.id, unit.id, ref)),
            )
            descriptions.push(`${status.name}恢复生命，${unit.name}生命 ${from} → ${unit.hp}。`)
          }
          effect.remaining--
          if ((unit.hp ?? 0) <= 0) break
          if (effect.remaining === 0) descriptions.push(`${unit.name}的${status.name}结束。`)
        }
        game.internal.conditions = game.internal.conditions.filter(effect => effect.remaining > 0)
      }
      const endTurn = (unit: BattleUnit) => {
        if (outcome()) return
        settleConditions(unit, 'after-action')
        const shield = game.internal.shields!.find(entry => entry.unitId === unit.id)
        if (shield && !refreshedShields.has(unit.id) && --shield.remaining === 0) {
          game.internal.shields = game.internal.shields!.filter(entry => entry !== shield)
          descriptions.push(`${unit.name}的护盾到期。`)
        }
      }

      const advance = () => {
        for (let step = 0; step <= pub.order.length; step++) {
          pub.cursor = (pub.cursor + 1) % pub.order.length
          if (pub.cursor === 0) {
            for (const unit of units) if (isHere(unit) && (unit.hp ?? 0) > 0) settleConditions(unit, 'round-end')
            if (outcome()) return
            game.round += 1
          }
          const next = units.find(unit => unit.id === pub.order[pub.cursor])
          if (!next || (next.hp ?? 0) <= 0 || !isHere(next)) continue
          if (next.team === 'party') {
            game.turn = next.id
            noteUnavailable(game, turnCue(next.id, game.round), notes)
            return
          }
          next.guarded = false
          const enemy = enemies.find(entry => entry.id === next.id)
          const targetsFor = (skill: RpgSkill) =>
            units.filter(
              unit =>
                unit.team === skillTargetSide(skill, next.team) &&
                (skill.target !== 'self' || unit.id === next.id) &&
                isHere(unit) &&
                (unit.hp ?? 0) > 0 &&
                (!onlyHealing(skill) || (unit.hp ?? 0) < (unit.maxHp ?? 0)),
            )
          // All actors use the same effect list; the enemy policy chooses the first currently legal skill.
          const used = enemy?.skills
            .map(skillById)
            .find(
              (skill): skill is RpgSkill =>
                !!skill && !valueProblem(game, next.id, skill) && targetsFor(skill).length > 0,
            )
          const standing = used ? targetsFor(used) : []
          if (!used || !standing.length) {
            next.guarded = true
            descriptions.push(`${next.name}采取防御。`)
          } else {
            const pick =
              enemy?.strategy === 'random'
                ? standing[
                    standing.length === 1
                      ? 0
                      : (() => {
                          if (!roll) throw new TypeError('受控骰子不可用')
                          return roll(`1d${standing.length}`).total - 1
                        })()
                  ]!
                : standing.slice().sort((a, b) => (a.hp ?? 0) - (b.hp ?? 0))[0]!
            applySkill(next, used, used.scope === 'all' ? standing : [pick])
          }
          endTurn(next)
          if (outcome()) return
        }
      }

      const settle = () => {
        const result = outcome()
        if (result === 'victory') {
          game.internal.conditions = []
          game.internal.shields = []
          pub.cleared = true
          descriptions.push('敌人全部倒下，战斗胜利。')
          if (config.drops.length) {
            out.items = config.drops.map(entityId => ({ entityId, to: { locationId: config.locationId } }))
            descriptions.push('有东西掉在了地上。')
          }
          const last = cueAt(pub.lastCue)
          const owed = last?.say ? [last] : []
          queue(game, 'aftermath', [...owed, ...cuesFor('enemy-defeated')], afterVictory)
        } else if (result === 'defeat') {
          finish(game, 'defeat', '战斗失败')
          descriptions.push('队伍全部倒下，战斗失败。')
          if (config.defeat) {
            out.moves = present.map(characterId => ({ characterId, locationId: config.defeat!.to }))
            for (const unit of units) {
              if (unit.team !== 'party' || !present.includes(unit.id)) continue
              for (const key of Object.keys(config.defeat.restore)) {
                const value = config.defeat.restore[key]!
                if (key === 'hp') unit.hp = Math.min(unit.maxHp ?? value, value)
                unit.stats[key] = key === 'hp' ? (unit.hp ?? value) : value
              }
            }
            descriptions.push(`醒来时，大家已经回到了${nameOf(config.defeat.to)}。`)
          }
        }
      }

      if (operation === 'skill') {
        const actorConfig = config.characters[actorId]
        // Published operations carry display names. An outstanding authored cue also identifies its skill and target by ID.
        const cueSkill = skillOf(cueNow)
        const scripted =
          !!cueNow &&
          !!cueSkill &&
          cueNow.characterId === actorId &&
          actorConfig?.skills.includes(cueSkill.id) === true &&
          cueSkill.name === parameters.skill &&
          (!cueNow.target || enemyName(cueNow.target) === parameters.target) &&
          !pub.said.includes(cueNow.index) &&
          !pub.noted.includes(cueNow.index)
        const used = scripted
          ? cueSkill
          : config.skills.find(skill => skill.name === parameters.skill && actorConfig?.skills.includes(skill.id))
        if (!used) return reject('你没有学会这个技能。')
        const victim =
          scripted && cueNow.target
            ? units.find(unit => unit.id === cueNow.target)
            : units.find(unit => unit.name === parameters.target)
        const heal = onlyHealing(used)
        const validTarget = (unit: BattleUnit | undefined): unit is BattleUnit =>
          Boolean(
            unit &&
              isHere(unit) &&
              (unit.hp ?? 0) > 0 &&
              unit.team === skillTargetSide(used) &&
              (used.target !== 'self' || unit.id === actorId),
          )
        const targets = used.scope === 'all' ? units.filter(validTarget) : victim ? [victim] : []
        const missingCost = Object.keys(used.cost).find(key => costShortfall(own.stats[key] ?? 0, used.cost[key]!) > 0)
        const problem =
          (scripted ? unavailableCueReason(cueNow, game) : null) ||
          (!validTarget(victim) ? '这个技能不能对该目标使用。' : null) ||
          (missingCost ? `${statLabel(missingCost)}不足，什么都没有发生。` : null) ||
          valueProblem(game, actorId, used) ||
          (heal && targets.every(unit => unit.hp === unit.maxHp) ? '目标生命已满，不消耗魔力。' : null)
        if (problem) {
          if (!scripted) return reject(problem)
          noteUnavailable(game, cueNow, notes, problem)
          return finalize()
        }
        if (scripted && cueNow) {
          pub.lastCue = cueNow.index
          pub.said.push(cueNow.index)
        }
        own.guarded = false
        applySkill(own, used, targets)
      } else if (operation === 'guard') {
        own.guarded = true
        descriptions.push(`${own.name}采取防御，下次受击伤害减半。`)
      } else if (operation === 'flee') {
        finish(game, 'fled', '已撤退')
        descriptions.push('队伍撤退了。')
        if (config.retreat === 'back' && config.defeat) {
          out.moves = present.map(characterId => ({ characterId, locationId: config.defeat!.to }))
          descriptions.push(`一路退回了${nameOf(config.defeat.to)}。`)
        }
        return finalize()
      } else {
        return reject('没有这个战斗操作。')
      }

      endTurn(own)
      if (pub.lastCue === null) noteUnavailable(game, cueNow, notes)

      if (game.phase === 'encounter' && !outcome()) {
        pub.pending.shift()
        nextAfterCue(game)
        if (game.phase === 'encounter') noteUnavailable(game, cueAt(pub.pending[0]), notes)
      } else if (!outcome()) {
        advance()
      }
      settle()
      return finalize()
    },

    onPublished(state, actorId) {
      const game = cloneGame(state.game)
      const pub = game.public
      if (!game.active || game.turn !== actorId) return null
      if (CUE_PHASES.has(game.phase)) {
        const cue = cueAt(pub.pending[0])
        if (!cue || cue.characterId !== actorId || (cue.skill && game.phase !== 'aftermath')) return null
        pub.pending.shift()
        pub.said.push(cue.index)
        return nextAfterCue(game) as unknown as WorldJsonObject
      }
      const cue = game.phase === 'fighting' ? turnCue(actorId, game.round) : undefined
      if (!cue || cue.skill || pub.said.includes(cue.index)) return null
      pub.said.push(cue.index)
      return game as unknown as WorldJsonObject
    },

    schedule: scheduleState,

    onOutcome(result, state) {
      const performResult = result.performResult as { readonly status?: unknown } | undefined
      const acted = result.status === 'published' || performResult?.status === 'accepted'
      return acted && !result.failure ? scheduleState(state) : { kind: 'wait' }
    },

    simulate(request: MemoryRequest) {
      const context = request.context as unknown as {
        readonly character: { readonly characterId: string }
        readonly activity?: {
          readonly id: string
          readonly revision: number
          readonly game: MapBattleGameState
        }
      }
      const me = context.character.characterId
      const activity = context.activity
      const publish = (text: string): WorldJsonObject => ({
        decision: 'publish',
        segments: [{ type: 'speech', text }],
      })
      const req = request as unknown as {
        readonly continuation?: boolean
        readonly result?: { readonly status?: string; readonly action?: unknown }
      }
      if (req.continuation) {
        const result = req.result
        if (!result || result.status !== 'accepted' || !result.action) return null
        const cue = activity ? cueAt(activity.game.public.lastCue) : undefined
        return cue && cue.characterId === me && cue.skill && cue.say ? publish(cue.say) : null
      }
      if (!activity || !activity.game.active || activity.game.turn !== me) return null
      const game = activity.game
      const pub = game.public
      const cue = CUE_PHASES.has(game.phase)
        ? cueAt(pub.pending[0])
        : game.phase === 'fighting'
          ? turnCue(me, game.round)
          : undefined
      if (!cue || cue.characterId !== me) return null
      if (game.phase === 'aftermath' && cue.skill) return cue.say ? publish(cue.say) : null
      if (pub.said.includes(cue.index)) return null
      if (!cue.skill) return cue.say ? publish(cue.say) : null
      if (pub.noted.includes(cue.index)) return null
      const used = skillOf(cue)
      if (!used) return null
      const team = skillTargetSide(used)
      const candidates = pub.units.filter(unit => unit.team === team && (used.target !== 'self' || unit.id === me))
      const standing = candidates.filter(unit => (unit.hp ?? 0) > 0)
      const fallbackUnit =
        (onlyHealing(used) ? standing.slice().sort((a, b) => (a.hp ?? 0) - (b.hp ?? 0))[0] : standing[0]) ??
        candidates[0]
      const target = cue.target ? enemyName(cue.target) : (fallbackUnit?.name ?? '')
      return {
        decision: 'perform',
        actionType: 'interact',
        parameters: {
          targetRef: { kind: 'character', id: me },
          bindingId: activity.id,
          definitionRef: { id: 'activity:skill', version: 1 },
          arguments: { activityId: activity.id, revision: activity.revision, skill: used.name, target },
        },
      }
    },
  }
  registerOfficialBattle(hooks, config)
  return hooks
}
