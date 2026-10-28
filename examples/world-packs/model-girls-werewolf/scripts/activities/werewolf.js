// 狼人杀（实验版）：玩家与六个模型娘的 7 人局，2 狼人、1 预言家、1 女巫、3 村民。
// 真实身份与夜间行动只在 internal；各人只在自己的 private 里看到本人身份与本人有权知道的夜间信息。
// 白天发言是自由对白，onPublished 只负责换到下一位；口头声明不改变任何裁定。
const NPCS = [
  'character:gpt',
  'character:claude',
  'character:deepseek',
  'character:glm',
  'character:gemini',
  'character:qwen',
]
const NAMES = {
  'character:player': '玩家',
  'character:gpt': 'GPT',
  'character:claude': 'Claude',
  'character:deepseek': 'DeepSeek',
  'character:glm': 'GLM',
  'character:gemini': 'Gemini',
  'character:qwen': 'Qwen',
}
const ROLES = ['狼人', '狼人', '预言家', '女巫', '村民', '村民', '村民']
const ABSTAIN = '弃票'
const RULES =
  '狼人杀 7 人局：2 狼人、1 预言家、1 女巫、3 村民，身份开局随机发。' +
  '夜晚狼人选择一人刀杀，女巫知道今晚被刀的是谁，可以用解药救人或用毒药毒人（各一瓶，同一晚只能用一瓶，不能自救），预言家查验一人是不是狼人。' +
  '天亮公布死讯；存活者按顺序各发言一次，然后依次投票放逐一人，全部投完才公布票型，平票无人出局。' +
  '狼人全部出局则好人获胜；存活狼人数不少于存活好人数则狼人获胜。死者不能再发言或投票。'
const TARGET = { type: 'string', enum: Object.values(NAMES) }
const none = { type: 'object', additionalProperties: false, properties: {} }

const copy = game => JSON.parse(JSON.stringify(game))
const nameOf = id => NAMES[id] ?? id
const idOf = (game, name) => game.internal.座位.find(id => nameOf(id) === name)
const isAlive = (game, id) => game.public.存活.includes(nameOf(id))
const roleOf = (game, id) => game.internal.身份表[id]
const alive = game => game.internal.座位.filter(id => isAlive(game, id))

function reminder(role, partner) {
  const speech = '白天轮到你时说一段话；你说的话不改变任何裁定，别人说的也只是她们的说法。'
  if (role === '狼人')
    return (
      `你是狼人，同伴是 ${nameOf(partner)}。夜晚轮到你时用 kill 选择今晚要刀的人；两名狼人依次提交，以后提交的为准。` +
      '想和同伴商量，就用定向发言只对同伴说，公开发言所有人都能听到。白天你可以隐藏身份。' +
      speech +
      '胜利条件：存活狼人数不少于存活好人数。'
    )
  const goal = '胜利条件：让所有狼人出局。'
  if (role === '预言家')
    return '你是预言家。夜晚轮到你时用 check 查验一名存活者，结果只记录在你自己的验人记录里。' + speech + goal
  if (role === '女巫')
    return (
      '你是女巫。夜晚轮到你时能看到今晚被刀的人，用 potion 选择 save（救被刀的人）、poison（毒一名存活者）或 none。' +
      '解药和毒药各一瓶，同一晚只能用一瓶，不能救自己。' +
      speech +
      goal
    )
  return '你是村民，夜晚没有行动。' + speech + goal
}

function winner(game) {
  const living = alive(game)
  const wolves = living.filter(id => roleOf(game, id) === '狼人').length
  if (wolves === 0) return '好人'
  if (wolves >= living.length - wolves) return '狼人'
  return null
}

function finish(game, text) {
  game.active = false
  game.turn = null
  game.public.身份公布 = Object.fromEntries(game.internal.座位.map(id => [nameOf(id), roleOf(game, id)]))
  const roles = game.internal.座位.map(id => `${nameOf(id)}是${roleOf(game, id)}`).join('，')
  game.public.statusText = text
  game.public.lastResult = `${text}身份公布：${roles}。`
  return game.public.lastResult
}

function startNight(game) {
  game.phase = 'night'
  game.public.phaseLabel = `第 ${game.public.第几天} 夜`
  const living = alive(game)
  game.internal.夜序 = [
    ...living.filter(id => roleOf(game, id) === '狼人'),
    ...living.filter(id => roleOf(game, id) === '女巫'),
    ...living.filter(id => roleOf(game, id) === '预言家'),
  ]
  game.internal.夜间 = { kill: null, save: false, poison: null }
  for (const id of living) if (roleOf(game, id) === '狼人') delete game.private[id].同伴提议
  game.turn = game.internal.夜序[0]
  game.public.statusText = `第 ${game.public.第几天} 夜，大家闭上了眼睛。`
}

// 轮到女巫时才把刀口写给她，之前的女巫视图里不会出现今晚的刀口。
function nextNightTurn(game) {
  game.internal.夜序 = game.internal.夜序.slice(1)
  game.turn = game.internal.夜序[0] ?? null
  if (game.turn !== null && roleOf(game, game.turn) === '女巫') {
    const kill = game.internal.夜间.kill
    game.private[game.turn].今晚被刀 = kill === null ? '无人' : nameOf(kill)
  }
}

function dawn(game) {
  const night = game.internal.夜间
  const deaths = new Set()
  if (night.kill !== null && !night.save) deaths.add(night.kill)
  if (night.poison !== null) deaths.add(night.poison)
  game.public.存活 = game.public.存活.filter(name => ![...deaths].some(id => nameOf(id) === name))
  game.public.死讯 = deaths.size ? `${[...deaths].map(nameOf).join('、')} 死了` : '平安夜'
  for (const id of game.internal.座位) if (roleOf(game, id) === '女巫') delete game.private[id].今晚被刀
  const announcement = `天亮了，第 ${game.public.第几天} 天。昨晚${deaths.size ? '，' + game.public.死讯 : '是平安夜'}。`
  const side = winner(game)
  if (side !== null) {
    game.phase = 'finished'
    return announcement + finish(game, `${side}获胜！`)
  }
  game.phase = 'day-speak'
  game.public.phaseLabel = `第 ${game.public.第几天} 天发言`
  const seats = game.internal.座位
  const start = (game.public.第几天 - 1) % seats.length
  game.internal.发言序 = [...seats.slice(start), ...seats.slice(0, start)].filter(id => isAlive(game, id))
  game.public.发言顺序 = game.internal.发言序.map(nameOf).join(' → ')
  game.turn = game.internal.发言序[0]
  game.public.statusText = `轮到 ${nameOf(game.turn)} 发言`
  game.public.lastResult = announcement
  return announcement
}

function closeVote(game) {
  const votes = game.internal.票
  const tally = {}
  for (const target of Object.values(votes)) if (target !== ABSTAIN) tally[target] = (tally[target] ?? 0) + 1
  const top = Math.max(0, ...Object.values(tally))
  const leaders = Object.keys(tally).filter(id => tally[id] === top)
  game.public.票型 = game.internal.发言序
    .filter(id => votes[id] !== undefined)
    .map(id => `${nameOf(id)}→${votes[id] === ABSTAIN ? ABSTAIN : nameOf(votes[id])}`)
  let text = `投票结束：${game.public.票型.join('，')}。`
  if (leaders.length === 1) {
    game.public.存活 = game.public.存活.filter(name => name !== nameOf(leaders[0]))
    text += `${nameOf(leaders[0])} 被放逐出局。`
  } else text += '平票，无人出局。'
  const side = winner(game)
  if (side !== null) {
    game.phase = 'finished'
    return text + finish(game, `${side}获胜！`)
  }
  game.public.第几天 += 1
  startNight(game)
  game.public.lastResult = text + '天黑了。'
  return game.public.lastResult
}

function npcToActivate(view) {
  const playerId = view.participants[0]
  return view.game.active && view.game.turn !== null && view.game.turn !== playerId
    ? { kind: 'activate', characterId: view.game.turn }
    : { kind: 'wait' }
}

const OPERATION_OF = { 狼人: 'kill', 预言家: 'check', 女巫: 'potion' }

globalThis.activityScript = {
  definition: {
    title: '狼人杀',
    opening: '茶几上摆好了七张身份牌，大家各抽一张、偷偷看过后扣在手边。“天黑请闭眼。”',
    npcIds: NPCS,
    operations: [
      {
        id: 'kill',
        label: '狼人：选择今晚刀谁',
        requiresTurn: true,
        schema: { type: 'object', additionalProperties: false, required: ['target'], properties: { target: TARGET } },
      },
      {
        id: 'check',
        label: '预言家：查验一人',
        requiresTurn: true,
        schema: { type: 'object', additionalProperties: false, required: ['target'], properties: { target: TARGET } },
      },
      {
        id: 'potion',
        label: '女巫：用药',
        requiresTurn: true,
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['choice'],
          properties: {
            choice: { type: 'string', enum: ['save', 'poison', 'none'], description: 'save 救今晚被刀的人，poison 毒一人，none 不用药' },
            target: { ...TARGET, description: '仅 poison 需要' },
          },
        },
      },
      {
        id: 'vote',
        label: '投票放逐',
        requiresTurn: true,
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['target'],
          properties: { target: { type: 'string', enum: [...Object.values(NAMES), ABSTAIN] } },
        },
      },
      { id: 'quit', label: '不玩了，收起身份牌', requiresTurn: false, schema: none },
    ],
  },
  initialize({ playerId, npcIds }) {
    const shuffle = list => {
      const out = [...list]
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1))
        ;[out[i], out[j]] = [out[j], out[i]]
      }
      return out
    }
    const seats = shuffle([playerId, ...npcIds])
    const roles = shuffle(ROLES)
    const table = Object.fromEntries(seats.map((id, i) => [id, roles[i]]))
    const wolves = seats.filter(id => table[id] === '狼人')
    const game = {
      active: true,
      phase: 'night',
      turn: null,
      round: 1,
      public: {
        规则: RULES,
        座位: seats.map(nameOf),
        存活: seats.map(nameOf),
        第几天: 1,
        死讯: '',
        phaseLabel: '',
        statusText: '',
        lastResult: '身份牌发下去了，每个人都偷偷看了一眼自己的身份。',
      },
      private: Object.fromEntries(
        seats.map(id => {
          const role = table[id]
          const partner = wolves.find(w => w !== id)
          const own = { 身份: role, 提醒: reminder(role, partner) }
          if (role === '狼人') own.狼同伴 = nameOf(partner)
          if (role === '预言家') own.验人记录 = []
          if (role === '女巫') Object.assign(own, { 解药: true, 毒药: true })
          return [id, own]
        }),
      ),
      internal: { 身份表: table, 座位: seats, 夜序: [], 夜间: {}, 发言序: [], 票: {} },
    }
    startNight(game)
    return game
  },
  policy(view, actorId) {
    const playerId = view.participants[0]
    const game = view.game
    const myTurn = game.active && game.turn === actorId && game.public.存活.includes(nameOf(actorId))
    // 宿主传入的是本人视图：private 已经是本人自己的那一份。
    const role = game.private.身份
    let speech = 'none'
    const operations = []
    if (myTurn && game.phase === 'night') {
      if (role === '狼人') speech = 'free'
      if (OPERATION_OF[role]) operations.push(OPERATION_OF[role])
    } else if (myTurn && game.phase === 'day-speak') speech = 'free'
    else if (myTurn && game.phase === 'vote') operations.push('vote')
    if (game.active && actorId === playerId) operations.push('quit')
    return { speech, speechChoices: [], narration: speech === 'free', move: false, interactions: [], operations }
  },
  resolve(state, actorId, operation, parameters) {
    const game = copy(state.game)
    const playerId = state.participants[0]
    if (operation === 'quit') {
      if (actorId !== playerId) return { rejectReason: '只有玩家可以结束游戏。' }
      game.phase = 'quit'
      game.round += 1
      const text = finish(game, '游戏中途结束。')
      return { game, description: `玩家收起了身份牌，这局狼人杀没有打完。${text}`, audience: 'participants' }
    }
    if (!game.active) return { rejectReason: '这局已经结束了。' }
    if (game.turn !== actorId) return { rejectReason: '还没轮到你。' }
    if (!isAlive(game, actorId)) return { rejectReason: '你已经出局了。' }
    const role = roleOf(game, actorId)
    const target = parameters.target === undefined ? undefined : idOf(game, parameters.target)
    if (parameters.target !== undefined && parameters.target !== ABSTAIN && target === undefined)
      return { rejectReason: `${parameters.target} 不在这局游戏里。` }
    if (target !== undefined && !isAlive(game, target)) return { rejectReason: `${nameOf(target)} 已经出局了。` }
    game.round += 1

    if (operation === 'vote') {
      if (game.phase !== 'vote') return { rejectReason: '现在不是投票时间。' }
      if (target === actorId) return { rejectReason: '不能投给自己。' }
      game.internal.票[actorId] = target ?? ABSTAIN
      const next = game.internal.发言序.find(id => isAlive(game, id) && game.internal.票[id] === undefined)
      if (next !== undefined) {
        game.turn = next
        game.public.statusText = `投票中，轮到 ${nameOf(next)}`
        return {
          game,
          description: `你投给了${target === undefined ? '弃票' : ' ' + nameOf(target)}。`,
          audience: 'self',
        }
      }
      return { game, description: closeVote(game), audience: 'participants' }
    }

    if (game.phase !== 'night' || OPERATION_OF[role] !== operation)
      return { rejectReason: '你现在不能做这个操作。' }
    let note
    if (operation === 'kill') {
      if (target === undefined || target === actorId) return { rejectReason: '请选择一名其他存活者。' }
      game.internal.夜间.kill = target
      const partner = game.internal.夜序.slice(1).find(id => roleOf(game, id) === '狼人')
      if (partner !== undefined) {
        game.private[partner].同伴提议 = `${nameOf(actorId)} 提议今晚刀 ${nameOf(target)}`
        note = `你提议今晚刀 ${nameOf(target)}，等同伴决定。`
      } else note = `今晚刀口定为 ${nameOf(target)}。`
    } else if (operation === 'check') {
      if (target === undefined || target === actorId) return { rejectReason: '请选择一名其他存活者。' }
      const result = roleOf(game, target) === '狼人' ? '狼人' : '好人'
      game.private[actorId].验人记录 = [...game.private[actorId].验人记录, `第 ${game.public.第几天} 夜：${nameOf(target)} 是${result}`]
      note = `你查验了 ${nameOf(target)}：${result}。`
    } else {
      const own = game.private[actorId]
      if (parameters.choice === 'save') {
        if (!own.解药) return { rejectReason: '解药已经用掉了。' }
        if (game.internal.夜间.kill === null) return { rejectReason: '今晚没有人被刀。' }
        if (game.internal.夜间.kill === actorId) return { rejectReason: '女巫不能救自己。' }
        own.解药 = false
        game.internal.夜间.save = true
        note = `你用解药救下了 ${nameOf(game.internal.夜间.kill)}。`
      } else if (parameters.choice === 'poison') {
        if (!own.毒药) return { rejectReason: '毒药已经用掉了。' }
        if (target === undefined || target === actorId) return { rejectReason: '请选择一名其他存活者下毒。' }
        own.毒药 = false
        game.internal.夜间.poison = target
        note = `你对 ${nameOf(target)} 用了毒药。`
      } else note = '你今晚没有用药。'
    }
    nextNightTurn(game)
    // 结束夜晚的那次操作改为公开天亮结果；本人的私密结果已经写在自己的 private 里。
    if (game.turn === null) return { game, description: dawn(game), audience: 'participants' }
    game.public.statusText = `第 ${game.public.第几天} 夜，大家闭着眼睛。`
    return { game, description: note, audience: 'self' }
  },
  onPublished(state, actorId) {
    const game = copy(state.game)
    if (!game.active || game.phase !== 'day-speak' || game.turn !== actorId) return null
    game.round += 1
    const order = game.internal.发言序
    const next = order[order.indexOf(actorId) + 1]
    if (next === undefined) {
      game.phase = 'vote'
      game.public.phaseLabel = `第 ${game.public.第几天} 天投票`
      game.internal.票 = {}
      game.turn = order[0]
      game.public.lastResult = `${nameOf(actorId)} 发言完毕。所有人都说完了，开始投票。`
    } else {
      game.turn = next
      game.public.lastResult = `${nameOf(actorId)} 发言完毕。`
    }
    game.public.statusText = game.phase === 'vote' ? `投票中，轮到 ${nameOf(game.turn)}` : `轮到 ${nameOf(game.turn)} 发言`
    return game
  },
  schedule: npcToActivate,
  onOutcome: (_result, view) => npcToActivate(view),
}
