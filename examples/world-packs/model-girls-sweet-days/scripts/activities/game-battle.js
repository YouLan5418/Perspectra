// 客厅游戏机里的合作 RPG：战斗数值只属于这一局游戏。
const NAMES = {
  'character:player': '屋主',
  'character:gpt': 'GPT',
  'character:claude': 'Claude',
  'character:deepseek': 'DeepSeek',
}
const none = { type: 'object', additionalProperties: false, properties: {} }
const healTarget = {
  type: 'object',
  additionalProperties: false,
  required: ['target'],
  properties: { target: { type: 'string', title: '治疗谁', enum: ['屋主', 'GPT', 'Claude', 'DeepSeek'] } },
}
const copy = value => JSON.parse(JSON.stringify(value))
const nameOf = id => NAMES[id] ?? id
const unitOf = (game, id) => game.public.party.find(unit => unit.id === id)
function summary(game) {
  game.public.队伍 = game.public.party
    .map(unit => `${nameOf(unit.id)} ${unit.hp}/${unit.maxHp}生命 ${unit.mp}魔力${unit.guard ? '（防御）' : ''}`)
    .join('；')
  game.public.敌人 = `遗迹守卫 ${game.public.enemyHp}/${game.public.enemyMaxHp}生命`
  game.public.当前回合 = game.turn ? nameOf(game.turn) : '战斗结束'
}
function finish(game, phase, messages) {
  game.active = false
  game.phase = phase
  game.turn = null
  game.public.phaseLabel = phase === 'victory' ? '冒险胜利' : phase === 'defeat' ? '冒险失败' : '退出冒险'
  messages.push(
    phase === 'victory'
      ? '遗迹守卫倒下，屏幕亮起通关画面！'
      : phase === 'defeat'
        ? '队伍全部倒下，这次冒险结束了。'
        : '大家暂时退出了冒险。',
  )
}
function advance(game, currentId, messages) {
  const party = game.public.party
  const index = party.findIndex(unit => unit.id === currentId)
  for (let i = index + 1; i < party.length; i++) {
    if (party[i].hp > 0) {
      game.turn = party[i].id
      return
    }
  }
  const targets = party.filter(unit => unit.hp > 0)
  if (!targets.length) {
    finish(game, 'defeat', messages)
    return
  }
  // 守卫攻击生命最低的角色；平血按队伍顺序选择。
  const target = targets.reduce((a, b) => (b.hp < a.hp ? b : a))
  const damage = target.guard ? 4 : 8
  target.guard = false
  target.hp = Math.max(0, target.hp - damage)
  messages.push(`遗迹守卫攻击${nameOf(target.id)}，造成${damage}点伤害，剩余${target.hp}生命。`)
  if (!party.some(unit => unit.hp > 0)) {
    finish(game, 'defeat', messages)
    return
  }
  game.round += 1
  game.turn = party.find(unit => unit.hp > 0).id
}
globalThis.activityScript = {
  definition: {
    title: '一起玩像素 RPG：遗迹守卫',
    opening: '游戏机的屏幕亮起，像素风的遗迹出现在电视上。大家准备组队挑战守卫。',
    participants: {
      mode: 'player-select',
      min: 1,
      max: 3,
      candidates: ['character:gpt', 'character:claude', 'character:deepseek'],
    },
    operations: [
      { id: 'attack', label: '普通攻击（8伤害）', requiresTurn: true, schema: none },
      { id: 'magic', label: '火球术（消耗2魔力，14伤害）', requiresTurn: true, schema: none },
      { id: 'heal', label: '治疗术（消耗2魔力，恢复10生命）', requiresTurn: true, schema: healTarget },
      { id: 'guard', label: '防御（下次受击减半）', requiresTurn: true, schema: none },
      { id: 'skip', label: '让等待中的队友本回合待命', requiresTurn: false, schema: none },
      { id: 'quit', label: '退出像素 RPG', requiresTurn: false, schema: none },
    ],
  },
  initialize({ playerId, npcIds, world }) {
    if (
      world.locationId !== 'location:living-room' ||
      !world.items.current.some(item => item.entityId === 'entity:game-console')
    )
      throw new TypeError('请在客厅游戏机旁开始 RPG。')
    const party = [playerId, ...npcIds].map(id => ({ id, hp: 24, maxHp: 24, mp: 4, guard: false }))
    const enemyMaxHp = 35 + party.length * 12
    const game = {
      active: true,
      phase: 'battle',
      turn: playerId,
      round: 1,
      public: {
        phaseLabel: '遗迹守卫战',
        objective:
          '你们在客厅一起玩回合制 RPG。队伍依次行动，随后守卫攻击生命最低的人；击败守卫获胜，全队倒下则失败。普通攻击8伤害；火球消耗2魔力造成14伤害；治疗消耗2魔力恢复10生命；防御使下次受击减半。生命和魔力仅属于游戏角色。轮到自己时可使用活动操作，也可以先聊天。',
        party,
        enemyHp: enemyMaxHp,
        enemyMaxHp,
        lastResult: '第一回合开始，屋主先操作。',
      },
      private: Object.fromEntries([playerId, ...npcIds].map(id => [id, {}])),
      internal: {},
    }
    summary(game)
    return game
  },
  policy(view, actorId) {
    const isPlayer = actorId === view.participants[0]
    const own = view.game.turn === actorId && view.game.active
    return {
      speech: 'free',
      speechChoices: [],
      narration: true,
      move: false,
      interactions: [],
      operations: [
        ...(own ? ['attack', 'magic', 'heal', 'guard'] : []),
        ...(isPlayer && view.game.active ? [...(!own ? ['skip'] : []), 'quit'] : []),
      ],
    }
  },
  resolve(state, actorId, operation, parameters, world) {
    const game = copy(state.game)
    const playerId = state.participants[0]
    if (!game.active) return { rejectReason: '这局游戏已经结束。' }
    if (!state.participants.every(id => world.characterIds.includes(id)))
      return { rejectReason: '参与游戏的人需要在同一个房间。' }
    const messages = []
    if (operation === 'quit') {
      if (actorId !== playerId) return { rejectReason: '只有屋主可以退出。' }
      finish(game, 'quit', messages)
    } else if (operation === 'skip') {
      if (actorId !== playerId || game.turn === playerId) return { rejectReason: '只能让等待中的队友暂时待命。' }
      const waiting = game.turn
      messages.push(`${nameOf(waiting)}的游戏角色本回合待命。`)
      advance(game, waiting, messages)
    } else {
      const own = unitOf(game, actorId)
      if (!own || own.hp <= 0 || game.turn !== actorId) return { rejectReason: '还没有轮到你，或游戏角色已经倒下。' }
      if (!['attack', 'magic', 'heal', 'guard'].includes(operation)) return { rejectReason: '未知游戏操作。' }
      if (['magic', 'heal'].includes(operation) && own.mp < 2) return { rejectReason: '魔力不足。' }
      if (operation === 'heal') {
        const target = game.public.party.find(unit => nameOf(unit.id) === parameters.target)
        if (!target || target.hp <= 0) return { rejectReason: '请选择仍在战斗的队友。' }
        if (target.hp >= target.maxHp) return { rejectReason: '目标生命已满。' }
        own.guard = false
        own.mp -= 2
        target.hp = Math.min(target.maxHp, target.hp + 10)
        messages.push(`${nameOf(actorId)}施放治疗术，${nameOf(target.id)}恢复至${target.hp}生命。`)
      } else if (operation === 'guard') {
        own.guard = true
        messages.push(`${nameOf(actorId)}的游戏角色防御，下次受到的伤害减半。`)
      } else {
        own.guard = false
        const damage = operation === 'magic' ? 14 : 8
        if (operation === 'magic') own.mp -= 2
        game.public.enemyHp = Math.max(0, game.public.enemyHp - damage)
        messages.push(
          `${nameOf(actorId)}${operation === 'magic' ? '施放火球术' : '普通攻击'}，造成${damage}点伤害；守卫剩余${game.public.enemyHp}生命。`,
        )
      }
      if (game.public.enemyHp === 0) finish(game, 'victory', messages)
      else advance(game, actorId, messages)
    }
    game.public.lastResult = messages.join(' ')
    summary(game)
    return { game, description: game.public.lastResult, audience: 'participants' }
  },
  schedule(view) {
    return view.game.active && view.game.turn !== view.participants[0]
      ? { kind: 'activate', characterId: view.game.turn }
      : { kind: 'wait' }
  },
  onOutcome(result, view) {
    return result.status !== 'abstained' &&
      result.failure === undefined &&
      view.game.active &&
      view.game.turn !== view.participants[0]
      ? { kind: 'activate', characterId: view.game.turn }
      : { kind: 'wait' }
  },
}
