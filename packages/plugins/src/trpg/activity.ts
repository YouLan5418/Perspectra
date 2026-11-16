import type { ActivityState, WorldJsonObject, WorldJsonValue } from '@perspectra/sdk/contracts'
import type { ActivityHooks, DiceRoll } from '@perspectra/sdk'
import type { TrpgConfig, TrpgContent } from './config.ts'

/** 跑团活动在持久状态中允许出现的全部阶段标识，读档数据兼容校验按此核对。 */
export const TRPG_ACTIVITY_PHASES = ['setup', 'invited', 'playing', 'ended'] as const

export interface TrpgActivityConfig extends TrpgConfig {
  readonly playerId: string
  readonly names: Readonly<Record<string, string>>
}

interface TrpgSheetStat {
  label: string
  value: number
  max: number
}

interface TrpgSheetSkill {
  label: string
  modifier: number
}

interface TrpgSheet {
  name: string
  dice: string
  stats: Record<string, TrpgSheetStat>
  skills: Record<string, TrpgSheetSkill>
}

interface TrpgTableContent {
  id: string
  kind: TrpgContent['kind']
  name: string
  description: string
  location?: string
}

interface TrpgPendingAction {
  actorId: string
  name: string
  text: string
}

interface TrpgRollRecord {
  round: number
  targetId: string | null
  skill: string
  expression: string
  dice: readonly number[]
  diceModifier: number
  modifier: number
  total: number
  difficulty: number
  success: boolean
  hidden: boolean
}

interface TrpgParticipantPrivate {
  rolls: TrpgRollRecord[]
  notes?: string
  secret?: { truth: string; endings: readonly string[] } | null
  hiddenContent?: TrpgTableContent[]
  instructions?: string
}

interface TrpgPublicState {
  lastResult: string | null
  hostId: string | null
  title: string | null
  opening: string | null
  notes: string
  content: TrpgTableContent[]
  sheets: Record<string, TrpgSheet>
  pending: TrpgPendingAction[]
  choices?: {
    hosts: readonly string[] | null
    scenarios: { id: string; title: string }[]
    themes: readonly string[]
  }
  statusText: string
}

interface TrpgInternalState {
  hostDue: boolean
  followUp: boolean
  spotlight: string | null
  cursor: number
  opening: string | null
  nextContent: number
}

interface TrpgGameState {
  active: boolean
  phase: (typeof TRPG_ACTIVITY_PHASES)[number]
  turn: string | null
  round: number
  public: TrpgPublicState
  private: Record<string, TrpgParticipantPrivate>
  internal: TrpgInternalState
}

interface TrpgPublication {
  readonly scope?: string
  readonly addresseeIds?: readonly string[]
  readonly text?: string
  readonly segments?: readonly { readonly type?: string; readonly text?: string }[]
}

const NOTE_LIMIT = 6000
const PENDING_LIMIT = 8
const ROLL_LIMIT = 20
const CONTENT_LIMIT = 60
const HOST_OPERATIONS = ['check', 'announce', 'note', 'set-stat', 'content']
const KINDS: Readonly<Record<TrpgContent['kind'], string>> = {
  place: '地点',
  item: '物品',
  npc: 'NPC',
}

function stringField(title: string, max: number, min = 1): WorldJsonObject {
  return { title, type: 'string', minLength: min, maxLength: max }
}

function closedObjectSchema(properties: WorldJsonObject, required: readonly string[]): WorldJsonObject {
  return { type: 'object', additionalProperties: false, required: [...required], properties }
}

function signed(value: number): string {
  return value < 0 ? String(value) : `+${value}`
}

function cloneGame(value: unknown): TrpgGameState {
  return structuredClone(value) as TrpgGameState
}

function spokenText(publication: TrpgPublication | null): string {
  if (!publication) return ''
  const segments = publication.segments ?? [{ type: 'speech', text: publication.text ?? '' }]
  return segments
    .filter(segment => segment.type === 'speech' || segment.type === 'narration')
    .map(segment => segment.text ?? '')
    .join('')
}

function toWholeTable(
  publication: TrpgPublication | null,
  participants: readonly string[],
  hostId: string | null,
): boolean {
  if (!publication) return false
  if (publication.scope === undefined || publication.scope === 'scene_public') return true
  if (publication.scope !== 'direct' && publication.scope !== 'private') return false
  const heard = publication.addresseeIds ?? []
  return participants.every(id => id === hostId || heard.includes(id))
}

function appendRoll(rolls: readonly TrpgRollRecord[], entry: TrpgRollRecord): TrpgRollRecord[] {
  return [...rolls, entry].slice(-ROLL_LIMIT)
}

/** 构造原生 TypeScript 跑团桌面活动钩子：主持人邀请、角色卡、受控掷骰检定、全桌同步与私有笔记保护。 */
export function createTrpgActivityHooks(config: TrpgActivityConfig): ActivityHooks {
  const playerId = config.playerId
  const nameOf = (id: string): string => config.names[id] || id
  const scenarios = config.scenarios ?? []
  const themes = config.themes ?? []
  const skillOf = (key: string) => config.sheet.skills.find(skill => skill.key === key)

  const setupProperties: Record<string, WorldJsonValue> = {
    hostId: stringField('主持人', 200),
    ...(scenarios.length
      ? {
          scenario: {
            title: '剧本',
            type: 'string',
            enum: scenarios.map(s => s.id),
            description: scenarios.map(s => `${s.id}：${s.title}`).join('；'),
          },
        }
      : {}),
    theme: {
      ...stringField('题目', 200),
      description: themes.length ? `可选预设：${themes.join('；')}；也可以自己填写` : '自己填写一个题目',
    },
  }

  const operations: WorldJsonObject[] = [
    { id: 'setup', label: '筹备跑团', requiresTurn: false, schema: closedObjectSchema(setupProperties, ['hostId']) },
    {
      id: 'respond',
      label: '回应主持邀请',
      requiresTurn: false,
      schema: closedObjectSchema({ accept: { title: '接受', type: 'boolean' } }, ['accept']),
    },
    {
      id: 'propose',
      label: '提出行动',
      requiresTurn: false,
      schema: closedObjectSchema({ text: stringField('行动', 500) }, ['text']),
    },
    {
      id: 'check',
      label: '要求检定',
      requiresTurn: false,
      schema: closedObjectSchema(
        {
          targetId: stringField('检定对象', 200),
          skill: { title: '技能', type: 'string', enum: config.sheet.skills.map(s => s.key) },
          difficulty: { title: '难度', type: 'integer', minimum: 1, maximum: 1000 },
          hidden: { title: '暗骰', type: 'boolean' },
        },
        ['skill', 'difficulty', 'hidden'],
      ),
    },
    {
      id: 'announce',
      label: '宣布结果',
      requiresTurn: false,
      schema: closedObjectSchema({ text: stringField('宣布', 2000) }, ['text']),
    },
    {
      id: 'note',
      label: '写笔记',
      requiresTurn: false,
      schema: closedObjectSchema(
        {
          scope: { title: '范围', type: 'string', enum: ['public', 'private'] },
          text: stringField('内容', NOTE_LIMIT, 0),
          mode: { title: '写法', type: 'string', enum: ['append', 'replace'] },
        },
        ['scope', 'text', 'mode'],
      ),
    },
    {
      id: 'set-stat',
      label: '改数值',
      requiresTurn: false,
      schema: closedObjectSchema(
        {
          targetId: stringField('对象', 200),
          stat: { title: '数值', type: 'string', enum: config.sheet.stats.map(s => s.key) },
          value: { title: '新值', type: 'integer' },
        },
        ['targetId', 'stat', 'value'],
      ),
    },
    {
      id: 'content',
      label: '局内内容',
      requiresTurn: false,
      schema: closedObjectSchema(
        {
          kind: { title: '类型', type: 'string', enum: ['place', 'item', 'npc'] },
          name: stringField('名字', 40),
          description: stringField('描述', 500),
          location: stringField('所在地点', 40),
          public: { title: '公开', type: 'boolean' },
          id: stringField('修改的内容 ID', 16),
        },
        ['kind', 'name', 'description', 'public'],
      ),
    },
    {
      id: 'end',
      label: '结束跑团',
      requiresTurn: false,
      schema: closedObjectSchema({ ending: stringField('结局', 500) }, []),
    },
  ]

  const choices = () => ({
    hosts: config.hosts ?? null,
    scenarios: scenarios.map(s => ({ id: s.id, title: s.title })),
    themes,
  })

  const sheetFor = (id: string): TrpgSheet => {
    const own = config.characters?.[id]
    return {
      name: nameOf(id),
      dice: config.sheet.dice,
      stats: Object.fromEntries(
        config.sheet.stats.map(s => [s.key, { label: s.label, value: own?.stats?.[s.key] ?? s.max, max: s.max }]),
      ),
      skills: Object.fromEntries(
        config.sheet.skills.map(s => [s.key, { label: s.label, modifier: own?.skills?.[s.key] ?? s.modifier }]),
      ),
    }
  }

  const hostGuide = (withSecret: boolean): string =>
    '你是这局跑团的主持人，局内发生的一切只属于游戏。可用的工具：check 要求检定（程序掷骰，点数只告诉对象和你；hidden 为暗骰，只有你知道）、announce 宣布结果（全体参与者可见，会处理最早一条待处理行动；有待处理行动时，对全桌说出结果也算一次宣布，只对个别人说的悄悄话不算）、note 写公开或私密笔记（各至多 6000 字）、set-stat 改角色卡数值、content 新建或修改局内地点、物品、NPC、end 结束本局。宣布时可以用名字称呼参与者。' +
    (withSecret ? '' : '这局只有题目，没有写好的真相与结局，可以先用 note 写私密笔记定下来。')

  const backToSetup = (game: TrpgGameState, participants: readonly string[]) => {
    const p = game.public
    for (const id of participants) game.private[id] = { rolls: [] }
    Object.assign(p, {
      hostId: null,
      title: null,
      opening: null,
      notes: '',
      content: [],
      sheets: {},
      pending: [],
      choices: choices(),
      statusText: '筹备中：请选择主持人和剧本或题目',
    })
    game.phase = 'setup'
    game.turn = playerId
    game.internal.hostDue = false
    game.internal.followUp = false
    game.internal.spotlight = null
    game.internal.opening = null
  }

  const placeNames = (game: TrpgGameState): string[] => {
    const hostHidden = game.public.hostId ? (game.private[game.public.hostId]?.hiddenContent ?? []) : []
    return [...game.public.content, ...hostHidden].filter(c => c.kind === 'place').map(c => c.name)
  }

  const announced = (game: TrpgGameState, participants: readonly string[]) => {
    const internal = game.internal
    const hostId = game.public.hostId
    game.public.pending.shift()
    game.round += 1
    internal.hostDue = false
    internal.followUp = false
    const players = participants.filter(id => id !== hostId && id !== playerId)
    internal.spotlight = players.length ? players[internal.cursor++ % players.length]! : null
  }

  const scheduleState = (state: ActivityState): WorldJsonObject => {
    const game = state.game as unknown as TrpgGameState
    const internal = game.internal
    if (!game.active) return { kind: 'wait' }
    if ((game.phase === 'invited' || (game.phase === 'playing' && internal.hostDue)) && game.public.hostId !== null)
      return { kind: 'activate', characterId: game.public.hostId }
    if (game.phase === 'playing' && internal.spotlight !== null)
      return { kind: 'activate', characterId: internal.spotlight }
    return { kind: 'wait' }
  }

  return {
    definition: { title: '跑团', participants: { mode: 'player-select', min: 1, max: 8 }, operations },
    phases: TRPG_ACTIVITY_PHASES,

    initialize(input) {
      const startPlayerId = String(input.playerId ?? playerId)
      const npcIds = (input.npcIds as readonly string[] | undefined) ?? []
      const game: TrpgGameState = {
        active: true,
        phase: 'setup',
        turn: startPlayerId,
        round: 1,
        public: {
          lastResult: null,
          hostId: null,
          title: null,
          opening: null,
          notes: '',
          content: [],
          sheets: {},
          pending: [],
          statusText: '',
        },
        private: {},
        internal: { hostDue: false, followUp: false, spotlight: null, cursor: 0, opening: null, nextContent: 1 },
      }
      backToSetup(game, [startPlayerId, ...npcIds])
      return game as unknown as WorldJsonObject
    },

    policy(scoped, actorId) {
      const game = (scoped as unknown as { readonly game: TrpgGameState }).game
      const host = game.public.hostId !== null && actorId === game.public.hostId
      const isPlayer = actorId === playerId
      const ops =
        game.phase === 'setup'
          ? isPlayer
            ? ['setup', 'end']
            : []
          : game.phase === 'invited'
            ? host
              ? ['respond', 'end']
              : isPlayer
                ? ['end']
                : []
            : game.phase === 'playing'
              ? host
                ? [...HOST_OPERATIONS, 'end']
                : isPlayer
                  ? ['propose', 'end']
                  : ['propose']
              : []
      return { speech: 'free', speechChoices: [], narration: false, move: false, interactions: [], operations: ops }
    },

    resolve(state, actorId, operation, parameters, _world, _truth, rollDice?: (expression: string) => DiceRoll) {
      const game = cloneGame(state.game)
      const p = game.public
      const internal = game.internal
      const reject = (rejectReason: string): WorldJsonObject => ({ rejectReason })
      const mistake = (reason: string): WorldJsonObject => ({
        game: cloneGame(state.game) as unknown as WorldJsonObject,
        description: reason,
        audience: 'self',
      })
      const markHostToolUsed = () => {
        internal.hostDue = true
        internal.followUp = true
      }
      const hostId = p.hostId
      const isHost = hostId !== null && actorId === hostId
      const playing = game.phase === 'playing'
      const hostName = hostId === null ? '' : nameOf(hostId)
      const done = (
        description: string,
        audience: 'participants' | 'self' = 'participants',
        extra: WorldJsonObject = {},
      ): WorldJsonObject => ({
        game: game as unknown as WorldJsonObject,
        description,
        audience,
        ...extra,
      })
      const shown = (description: string): string => {
        p.lastResult = description
        return description
      }

      if (operation === 'end') {
        if (!game.active || !(actorId === playerId || (isHost && game.phase !== 'setup')))
          return reject('现在不能结束这局跑团。')
        game.active = false
        game.phase = 'ended'
        game.turn = null
        internal.hostDue = false
        const ending = typeof parameters.ending === 'string' ? parameters.ending : ''
        const description = ending ? `跑团结束：${ending}` : '跑团结束。'
        p.statusText = description
        return done(shown(description))
      }

      if (operation === 'setup') {
        if (game.phase !== 'setup' || actorId !== playerId) return reject('现在不能筹备。')
        const chosen = String(parameters.hostId ?? '')
        if (!state.participants.includes(chosen) || chosen === playerId)
          return reject('主持人需要是这局里的一名 AI 角色。')
        if (config.hosts && !config.hosts.includes(chosen))
          return reject(`${nameOf(chosen)}不在主持人候选名单里：${config.hosts.map(nameOf).join('、')}。`)
        if ((parameters.scenario === undefined) === (parameters.theme === undefined))
          return reject('剧本和题目需要恰好选一个。')
        const scenario = scenarios.find(s => s.id === parameters.scenario)
        const theme = typeof parameters.theme === 'string' ? parameters.theme.trim() : undefined
        if (theme === '') return reject('题目不能为空。')
        const hidden: TrpgTableContent[] = []
        p.content = []
        for (const entry of scenario ? scenario.content : []) {
          const row: TrpgTableContent = {
            id: `c${internal.nextContent++}`,
            kind: entry.kind,
            name: entry.name,
            description: entry.description,
            ...(entry.location !== undefined ? { location: entry.location } : {}),
          }
          ;(entry.public ? p.content : hidden).push(row)
        }
        p.hostId = chosen
        p.title = scenario ? scenario.title : (theme ?? '')
        p.sheets = Object.fromEntries(state.participants.filter(id => id !== chosen).map(id => [id, sheetFor(id)]))
        delete p.choices
        game.private[chosen] = {
          rolls: [],
          notes: '',
          secret: scenario ? { truth: scenario.truth, endings: scenario.endings } : null,
          hiddenContent: hidden,
          instructions: hostGuide(scenario !== undefined),
        }
        internal.opening = scenario ? scenario.opening : `题目：${theme ?? ''}`
        game.phase = 'invited'
        game.turn = chosen
        p.statusText = `等待${nameOf(chosen)}回应主持邀请`
        return done(shown(`${nameOf(playerId)}邀请${nameOf(chosen)}主持跑团《${p.title}》。`))
      }

      if (operation === 'respond') {
        if (game.phase !== 'invited' || !isHost || hostId === null) return reject('现在没有等你回应的主持邀请。')
        if (!parameters.accept) {
          const description = `${hostName}婉拒了主持邀请，可以另选主持人。`
          backToSetup(game, state.participants)
          return done(shown(description))
        }
        game.phase = 'playing'
        p.opening = internal.opening
        p.statusText = `进行中：《${p.title}》，主持人${hostName}`
        const privateNotes = Object.fromEntries(
          state.participants.filter(id => id !== hostId).map(id => [id, p.opening ?? '']),
        )
        return done(shown(`${hostName}接受了主持邀请，跑团《${p.title}》开始。`), 'participants', {
          privateNotes,
        })
      }

      if (!playing) return reject('跑团还没有开始。')

      if (operation === 'propose') {
        if (isHost) return reject('主持人不用提出行动，可以直接宣布。')
        if (p.pending.length >= PENDING_LIMIT) return mistake('待处理的行动已满，请等主持人处理。')
        const text = String(parameters.text ?? '')
        p.pending.push({ actorId, name: nameOf(actorId), text })
        internal.hostDue = true
        internal.spotlight = null
        return done(shown(`${nameOf(actorId)}提出行动：${text}`))
      }

      if (!isHost || hostId === null) return reject('只有主持人可以这样做。')

      if (operation === 'check') {
        const targetId = typeof parameters.targetId === 'string' ? parameters.targetId : undefined
        const hidden = Boolean(parameters.hidden)
        const difficulty = Number(parameters.difficulty)
        if (targetId === undefined && !hidden) return mistake('公开检定需要指明对象。')
        const sheet = targetId === undefined ? undefined : p.sheets[targetId]
        if (targetId !== undefined && !sheet) return mistake(`没有这名参与者的角色卡：${targetId}。`)
        const skill = skillOf(String(parameters.skill ?? ''))
        if (!skill) return mistake(`未知检定技能：${String(parameters.skill ?? '')}。`)
        if (!rollDice) throw new TypeError('跑团检定需要受控掷骰服务')
        const modifier = sheet ? (sheet.skills[skill.key]?.modifier ?? skill.modifier) : skill.modifier
        const rolled = rollDice(sheet ? sheet.dice : config.sheet.dice)
        const total = rolled.total + modifier
        const success = total >= difficulty
        const who = sheet ? sheet.name : '暗骰'
        const faces = rolled.dice.join('+') + (rolled.modifier ? signed(rolled.modifier) : '')
        const line = `${who}的${skill.label}检定：${faces}${signed(modifier)}=${total}，难度${difficulty}，${success ? '成功' : '失败'}`
        const entry: TrpgRollRecord = {
          round: game.round,
          targetId: targetId ?? null,
          skill: skill.key,
          expression: rolled.expression,
          dice: rolled.dice,
          diceModifier: rolled.modifier,
          modifier,
          total,
          difficulty,
          success,
          hidden,
        }
        const own = game.private[hostId]!
        own.rolls = appendRoll(own.rolls, entry)
        markHostToolUsed()
        if (hidden) {
          return done('你掷了一次暗骰。', 'self', {
            privateNotes: { [hostId]: `${sheet ? '暗骰·' : ''}${line}` },
          })
        }
        const targetKey = targetId!
        const targetPrivate = game.private[targetKey]!
        targetPrivate.rolls = appendRoll(targetPrivate.rolls, entry)
        return done(shown(`${sheet!.name}进行了一次${skill.label}检定。`), 'participants', {
          privateNotes: { [targetKey]: line, [hostId]: line },
        })
      }

      if (operation === 'announce') {
        announced(game, state.participants)
        return done(shown(String(parameters.text ?? '')))
      }

      if (operation === 'note') {
        const own = game.private[hostId]!
        const scope = parameters.scope === 'public' ? 'public' : 'private'
        const mode = parameters.mode === 'replace' ? 'replace' : 'append'
        const text = String(parameters.text ?? '')
        const current = scope === 'public' ? p.notes : (own.notes ?? '')
        if (mode === 'append' && !text.trim()) return mistake('追加的笔记不能为空。')
        const next = mode === 'replace' ? text : current ? `${current}\n${text}` : text
        if (next.length > NOTE_LIMIT) {
          return mistake(
            `${scope === 'public' ? '公开' : '私密'}笔记将超过 ${NOTE_LIMIT} 字（现有 ${current.length} 字），请用 replace 把整段改写整理后再写入。`,
          )
        }
        markHostToolUsed()
        if (scope === 'public') {
          p.notes = next
          return done(shown(`${hostName}更新了公开笔记。`))
        }
        own.notes = next
        return done('你更新了私密笔记。', 'self')
      }

      if (operation === 'set-stat') {
        const targetId = String(parameters.targetId ?? '')
        const statKeyName = String(parameters.stat ?? '')
        const value = Number(parameters.value)
        const sheet = p.sheets[targetId]
        if (!sheet) return mistake(`没有这名参与者的角色卡：${targetId}。`)
        const stat = sheet.stats[statKeyName]
        if (!stat) return mistake(`角色卡上没有数值 ${statKeyName}。`)
        if (value < 0 || value > stat.max) return mistake(`${stat.label}需要在 0 到 ${stat.max} 之间。`)
        const before = stat.value
        stat.value = value
        markHostToolUsed()
        return done(shown(`${hostName}把${sheet.name}的${stat.label}从 ${before} 改为 ${stat.value}。`))
      }

      if (operation === 'content') {
        const own = game.private[hostId]!
        own.hiddenContent ??= []
        const lists = [p.content, own.hiddenContent] as const
        let wasPublic = false
        let id = typeof parameters.id === 'string' ? parameters.id : undefined
        const kind = parameters.kind as TrpgContent['kind']
        const name = String(parameters.name ?? '')
        const description = String(parameters.description ?? '')
        const location = typeof parameters.location === 'string' ? parameters.location : undefined
        const isPublic = Boolean(parameters.public)
        if (id !== undefined) {
          const index = p.content.findIndex(c => c.id === id)
          const hiddenIndex = own.hiddenContent.findIndex(c => c.id === id)
          if (index < 0 && hiddenIndex < 0) return mistake(`没有局内内容 ${id}。`)
          wasPublic = index >= 0
          const old = wasPublic ? p.content[index]! : own.hiddenContent[hiddenIndex]!
          const used = lists.some(list => list.some(c => c.id !== id && c.location === old.name))
          if (old.kind === 'place' && used && (kind !== 'place' || name !== old.name))
            return mistake(`还有局内内容在地点「${old.name}」，先把它们移走，再改这个地点的类型或名字。`)
          if (wasPublic) p.content.splice(index, 1)
          else own.hiddenContent.splice(hiddenIndex, 1)
        } else {
          if (lists[0].length + lists[1].length >= CONTENT_LIMIT)
            return mistake(`局内内容已有 ${CONTENT_LIMIT} 项，请修改已有的项。`)
          id = `c${internal.nextContent++}`
        }
        if (location !== undefined && !placeNames(game).includes(location))
          return mistake(`局内没有地点「${location}」，可以先新建这个地点。`)
        if (isPublic && location !== undefined && !p.content.some(c => c.kind === 'place' && c.name === location))
          return mistake('公开内容只能引用已公开的地点；请先公开地点或把内容保留为私有。')
        if (!isPublic && wasPublic && kind === 'place' && p.content.some(c => c.location === name))
          return mistake('仍有公开内容引用这个地点，请先移走或收起这些内容。')
        const row: TrpgTableContent = {
          id,
          kind,
          name,
          description,
          ...(location !== undefined ? { location } : {}),
        }
        ;(isPublic ? p.content : own.hiddenContent).push(row)
        markHostToolUsed()
        const label = `${KINDS[row.kind]}「${row.name}」`
        if (isPublic) return done(shown(`${hostName}${wasPublic ? '修改了局内' : '加入了局内'}${label}。`))
        if (wasPublic) return done(shown(`${hostName}收起了局内${label}。`))
        return done(`你记下了只有你知道的${label}。`, 'self')
      }

      return reject('当前不能执行此操作。')
    },

    onPublished(state, actorId, publicationRaw) {
      const game = cloneGame(state.game)
      const internal = game.internal
      if (!game.active || game.phase !== 'playing') return null
      const publication = (publicationRaw ?? null) as unknown as TrpgPublication | null
      if (actorId === game.public.hostId) {
        if (game.public.pending.length && internal.hostDue && toWholeTable(publication, state.participants, actorId)) {
          announced(game, state.participants)
          const text = spokenText(publication)
          if (text) game.public.lastResult = text
          return game as unknown as WorldJsonObject
        }
        if (!internal.hostDue) return null
        if (internal.followUp) internal.followUp = false
        else internal.hostDue = false
        return game as unknown as WorldJsonObject
      }
      if (internal.hostDue && internal.spotlight === null) return null
      internal.hostDue = true
      internal.spotlight = null
      return game as unknown as WorldJsonObject
    },

    schedule: scheduleState,

    onOutcome(result, state) {
      const performResult = result.performResult as { readonly status?: unknown } | undefined
      const committed = result.status === 'published' || performResult?.status === 'accepted'
      return committed && !result.failure && result.status !== 'interrupted' ? scheduleState(state) : { kind: 'wait' }
    },
  }
}
