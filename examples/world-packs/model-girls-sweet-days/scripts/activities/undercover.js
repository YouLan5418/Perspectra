// 可反复玩的小游戏：谁是卧底（试玩版）。
// 每人私下拿到一个词，其中一人的词和别人不同；轮流各描述两轮，再投票找卧底。
// 卧底身份只在 internal，词只在各自 private；结算前没人知道谁是卧底，卧底自己也不知道。
const HEROINES = ['character:gpt', 'character:claude', 'character:deepseek']
const NAMES = {
  'character:gpt': 'GPT',
  'character:claude': 'Claude',
  'character:deepseek': 'DeepSeek',
}
const DESCRIBE_ROUNDS = 2
const PLAYER_PRIZE = 30
const SLOTS = ['清晨', '午后', '傍晚', '深夜']
const WORD_PAIRS = [
  ['草莓蛋糕', '草莓大福'],
  ['红茶', '咖啡'],
  ['布丁', '果冻'],
  ['游乐园', '动物园'],
  ['书签', '便利贴'],
  ['吹风机', '电风扇'],
  ['蛋炒饭', '炒面'],
  ['雨伞', '雨衣'],
  ['游戏手柄', '键盘'],
  ['饺子', '包子'],
  ['奶茶', '豆浆'],
  ['烟花', '流星'],
  ['枕头', '抱枕'],
  ['冰淇淋', '雪糕'],
  ['眼镜', '墨镜'],
  ['火锅', '麻辣烫'],
  ['钢琴', '吉他'],
  ['水族馆', '游泳池'],
]
const RULES =
  '谁是卧底：每人私下拿到一个词，其中一人的词和大家不同，那个人就是卧底——拿到词的人自己也不知道自己是不是卧底。' +
  `按发言顺序轮流用一句话描述自己的词，不能直接说出词本身，共 ${DESCRIBE_ROUNDS} 轮；之后依次公开投票给最可疑的一位（不能投自己），投票时附上一句理由。` +
  '得票唯一最多的人是卧底则平民获胜，否则卧底获胜。' +
  `玩完一局度过一个时段；屋主赢了得 ${PLAYER_PRIZE} 元生活费，每位赢家都可以向输了的人提一个小要求。`
const none = { type: 'object', additionalProperties: false, properties: {} }

const nameOf = (id, playerId) => (id === playerId ? '屋主' : (NAMES[id] ?? id))
const copy = game => JSON.parse(JSON.stringify(game))

function nextSpeaker(game) {
  const order = game.internal.order
  const index = order.indexOf(game.turn) + 1
  if (index < order.length) return { turn: order[index], round: game.internal.describeRound }
  if (game.internal.describeRound < DESCRIBE_ROUNDS) return { turn: order[0], round: game.internal.describeRound + 1 }
  return null
}

// 投票阶段先让少女按发言顺序依次投，屋主随时可投。
function nextVoter(game, playerId) {
  return game.internal.order.find(id => id !== playerId && game.internal.votes[id] === undefined) ?? playerId
}

// 一局玩完度过一个时段，与 status.js 的 advanceSlot 一致：第 2 天进入傍晚时雷雨跳闸；深夜不再往后推。
function settle(truth, state, winners) {
  const playerId = state.participants[0]
  const slot = String(truth.public.slot)
  const nextSlot = SLOTS[Math.min(SLOTS.indexOf(slot) + 1, SLOTS.length - 1)]
  const isBlackout = truth.public.day === 2 && nextSlot === '傍晚'
  const privilege = `第 ${truth.public.day} 天${slot}的谁是卧底赢家：可以向这局输了的人提一个小要求，对方可以讨价还价`
  const changes = [
    ...(nextSlot === slot ? [] : [{ holderId: null, key: 'slot', value: nextSlot }]),
    ...(isBlackout ? [{ holderId: null, key: 'power-on', value: false }] : []),
    ...state.participants.map(id => ({
      holderId: id,
      key: 'undercover-privilege',
      value: winners.includes(id) ? privilege : '',
    })),
  ]
  if (winners.includes(playerId)) {
    const money = truth.characters[playerId]?.money ?? 0
    changes.push({ holderId: playerId, key: 'money', value: money + PLAYER_PRIZE })
  }
  const reveals = state.participants.flatMap(observerId =>
    state.participants.map(holderId => ({ observerId, holderId, key: 'undercover-privilege' })),
  )
  if (winners.includes(playerId)) reveals.push({ observerId: playerId, holderId: playerId, key: 'money' })
  const time = nextSlot === slot ? '' : `时间来到了${nextSlot}。${isBlackout ? '窗外雷声一响，全屋跳闸停电了！' : ''}`
  const prize = winners.includes(playerId) ? `屋主赢得 ${PLAYER_PRIZE} 元生活费。` : ''
  const names = winners.map(id => nameOf(id, playerId)).join('、')
  return { status: { changes, reveals }, text: `${prize}赢家 ${names} 可以向输了的人提一个小要求。${time}` }
}

function npcToActivate(view) {
  const playerId = view.participants[0]
  return view.game.active && view.game.turn !== null && view.game.turn !== playerId
    ? { kind: 'activate', characterId: view.game.turn }
    : { kind: 'wait' }
}

function statusFor(game, playerId) {
  if (game.phase === 'describe')
    return `第 ${game.internal.describeRound}/${DESCRIBE_ROUNDS} 轮描述：轮到 ${nameOf(game.turn, playerId)}`
  const voted = Object.keys(game.internal.votes).length
  return `投票中：${voted}/${game.internal.order.length} 人已投` +
    (game.turn === playerId ? '，等屋主投票' : `，等 ${nameOf(game.turn, playerId)} 投票`)
}

globalThis.activityScript = {
  definition: {
    title: '谁是卧底',
    opening: '你从抽屉里翻出一叠便签纸，给每人写了一张对折递过去：“来玩谁是卧底吧。”',
    participants: { mode: 'player-select', min: 2, max: 3, candidates: HEROINES },
    operations: [
      {
        id: 'vote',
        label: '投票指认卧底',
        requiresTurn: false,
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['target'],
          properties: {
            target: { type: 'string', enum: ['屋主', 'GPT', 'Claude', 'DeepSeek'] },
            reason: { type: 'string', maxLength: 80, description: '一句话说明为什么觉得对方可疑' },
          },
        },
      },
      { id: 'quit', label: '不玩了，收起便签', requiresTurn: false, schema: none },
    ],
  },
  initialize({ playerId, npcIds }) {
    const everyone = [playerId, ...npcIds]
    const pair = WORD_PAIRS[Math.floor(Math.random() * WORD_PAIRS.length)]
    const flip = Math.random() < 0.5
    const civilianWord = flip ? pair[1] : pair[0]
    const undercoverWord = flip ? pair[0] : pair[1]
    const undercover = everyone[Math.floor(Math.random() * everyone.length)]
    const order = [...everyone]
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[order[i], order[j]] = [order[j], order[i]]
    }
    const game = {
      active: true,
      phase: 'describe',
      turn: order[0],
      round: 1,
      public: {
        phaseLabel: '描述阶段',
        规则: RULES,
        发言顺序: order.map(id => nameOf(id, playerId)).join(' → '),
        statusText: '',
        lastResult: '便签都发下去了，每个人都偷偷看了一眼自己的词。',
      },
      private: Object.fromEntries(
        everyone.map(id => [
          id,
          {
            我的词: id === undercover ? undercoverWord : civilianWord,
            提醒:
              '你不知道自己是不是卧底。描述时别直接说出这个词。' +
              '如果听下来觉得自己的词和大家不一样，你很可能就是卧底：别承认，也别点破区别，往大家描述的共同点上靠，混过投票。',
          },
        ]),
      ),
      internal: { order, undercover, civilianWord, undercoverWord, describeRound: 1, votes: {} },
    }
    game.public.statusText = statusFor(game, playerId)
    return game
  },
  policy(view, actorId) {
    const playerId = view.participants[0]
    const game = view.game
    const operations = []
    if (game.active && actorId === playerId) {
      if (game.phase === 'vote' && game.public.屋主已投票 !== true) operations.push('vote')
      operations.push('quit')
    } else if (game.active && game.phase === 'vote' && game.turn === actorId) {
      operations.push('vote')
    }
    return {
      speech: 'free',
      speechChoices: [],
      narration: true,
      move: false,
      interactions: [],
      operations,
    }
  },
  resolve(state, actorId, operation, parameters, _world, truth) {
    const game = copy(state.game)
    const playerId = state.participants[0]
    if (operation === 'quit') {
      if (actorId !== playerId) return { rejectReason: '只有屋主可以结束游戏。' }
      game.active = false
      game.phase = 'quit'
      game.turn = null
      game.round += 1
      game.public.statusText = '游戏中途结束'
      game.public.lastResult = `答案揭晓：大家的词是「${game.internal.civilianWord}」，卧底 ${nameOf(game.internal.undercover, playerId)} 的词是「${game.internal.undercoverWord}」。`
      return { game, description: `屋主收起了便签，这局谁是卧底没有玩完。${game.public.lastResult}`, audience: 'participants' }
    }
    if (operation !== 'vote') return { rejectReason: '未知操作。' }
    if (game.phase !== 'vote') return { rejectReason: '还没到投票的时候，先轮流描述。' }
    if (game.internal.votes[actorId] !== undefined) return { rejectReason: '你已经投过票了。' }
    if (actorId !== playerId && game.turn !== actorId) return { rejectReason: '还没轮到你投票。' }
    const target = state.participants.find(id => nameOf(id, playerId) === parameters.target)
    if (target === undefined) return { rejectReason: `${parameters.target} 没有参加这局游戏。` }
    if (target === actorId) return { rejectReason: '不能投给自己。' }

    game.internal.votes[actorId] = target
    if (actorId === playerId) game.public.屋主已投票 = true
    game.round += 1
    const voterName = nameOf(actorId, playerId)

    const reason = typeof parameters.reason === 'string' && parameters.reason.trim() ? `：“${parameters.reason.trim()}”` : '。'
    const ballot = `${voterName} 投给了 ${nameOf(target, playerId)}${reason}`
    game.public.已投票 = [...(game.public.已投票 ?? []), `${voterName}→${nameOf(target, playerId)}`]

    if (Object.keys(game.internal.votes).length < state.participants.length) {
      game.turn = nextVoter(game, playerId)
      game.public.statusText = statusFor(game, playerId)
      game.public.lastResult = ballot
      return { game, description: ballot, audience: 'participants' }
    }

    const tally = {}
    for (const id of Object.values(game.internal.votes)) tally[id] = (tally[id] ?? 0) + 1
    const top = Math.max(...Object.values(tally))
    const leaders = Object.keys(tally).filter(id => tally[id] === top)
    const caught = leaders.length === 1 && leaders[0] === game.internal.undercover
    const undercoverName = nameOf(game.internal.undercover, playerId)
    const voteLines = state.participants
      .map(id => `${nameOf(id, playerId)}→${nameOf(game.internal.votes[id], playerId)}`)
      .join('，')
    game.active = false
    game.phase = 'finished'
    game.turn = null
    game.public.phaseLabel = '结算'
    game.public.statusText = caught ? '平民获胜' : '卧底获胜'
    const winners = caught
      ? state.participants.filter(id => id !== game.internal.undercover)
      : [game.internal.undercover]
    const { status, text } = settle(truth, state, winners)
    game.public.lastResult =
      `投票：${voteLines}。卧底是 ${undercoverName}（「${game.internal.undercoverWord}」），` +
      `其他人的词是「${game.internal.civilianWord}」。${caught ? '卧底被揪出来了，平民获胜！' : '卧底成功藏住了，卧底获胜！'}${text}`
    return { game, description: `${ballot}\n谁是卧底揭晓。${game.public.lastResult}`, audience: 'participants', status }
  },
  onPublished(state, actorId) {
    const game = copy(state.game)
    const playerId = state.participants[0]
    if (!game.active || game.phase !== 'describe' || game.turn !== actorId) return null
    const next = nextSpeaker(game)
    game.round += 1
    if (next === null) {
      game.phase = 'vote'
      game.public.phaseLabel = '投票阶段'
      game.turn = nextVoter(game, playerId)
      game.public.lastResult = `${nameOf(actorId, playerId)} 描述完了。两轮描述结束，开始投票！`
    } else {
      game.turn = next.turn
      game.internal.describeRound = next.round
      game.public.lastResult = `${nameOf(actorId, playerId)} 描述完了。`
    }
    game.public.statusText = statusFor(game, playerId)
    return game
  },
  schedule: npcToActivate,
  onOutcome: (_result, view) => npcToActivate(view),
}
