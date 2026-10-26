// All tactics and rules belong to this pack; the host supplies ordinary activity execution.
const PLAYER = 'character:player', ALLY = 'character:companion', ENEMY = 'character:friend'
const names = { [PLAYER]: '冒险者', [ALLY]: '澄', [ENEMY]: '遗迹守卫' }
const maxHp = { [PLAYER]: 32, [ALLY]: 24, [ENEMY]: 70 }
const empty = { type: 'object', additionalProperties: false, properties: {} }
const target = { ...empty, required: ['targetId'], properties: {
  targetId: { title: '目标', type: 'string', enum: ['冒险者', '澄', '遗迹守卫'] },
} }
globalThis.activityScript = {
  definition: {
    title: '遗迹守卫战', opening: '守卫举起石刃。你先行动，澄随后支援。', npcIds: [ALLY, ENEMY],
    operations: [
      { id: 'strike', label: '普通攻击', requiresTurn: true, schema: target },
      { id: 'fire', label: '火球术（3魔力）', requiresTurn: true, schema: target },
      { id: 'mend', label: '治疗术（3魔力）', requiresTurn: true, schema: target },
      { id: 'guard', label: '防御（下次受击减半）', requiresTurn: true, schema: empty },
      { id: 'potion', label: '使用药水（恢复16生命）', requiresTurn: true, schema: target },
      { id: 'flee', label: '撤退', requiresTurn: true, schema: empty },
    ],
  },
  autoStart(truth, world, previous) {
    return { when: [previous === null, truth.public.encounter === 'ready',
      [PLAYER, ALLY, ENEMY].every(id => world.characterIds.includes(id))] }
  },
  initialize({ playerId, npcIds }) {
    const order = [playerId, ...npcIds]
    return { active: true, phase: 'fighting', turn: playerId, round: 1,
      public: { order, standing: order, guarded: [], phaseLabel: '战斗中',
        instructions: '玩家 → 澄 → 守卫。击倒守卫获胜；全员倒下失败。攻击选敌方，治疗选己方。',
        lastResult: '你先行动；敌我生命与魔力见状态面板。' },
      private: Object.fromEntries(order.map(id => [id, {}])), internal: {} }
  },
  policy(view, actorId) {
    const ownTurn = view.game.turn === actorId && view.game.public.standing.includes(actorId)
    return { speech: 'free', speechChoices: [], narration: true, move: false, interactions: [],
      operations: !ownTurn ? [] : actorId === ENEMY ? ['strike', 'guard']
        : ['strike', 'fire', 'mend', 'guard', ...(actorId === PLAYER ? ['potion', 'flee'] : [])] }
  },
  resolve(state, actorId, operation, parameters, world, truth) {
    if (state.game.turn !== actorId || truth.characters[actorId].hp <= 0) return { rejectReason: '尚未轮到你，或你已倒下。' }
    if (![PLAYER, ALLY, ENEMY].every(id => world.characterIds.includes(id))) return { rejectReason: '战斗参与者已不在同一现场。' }
    const game = JSON.parse(JSON.stringify(state.game))
    const stats = JSON.parse(JSON.stringify(truth.characters))
    const changes = []
    const set = (holderId, key, value) => {
      changes.push({ holderId, key, value })
      if (holderId !== null) stats[holderId][key] = value
    }
    const allied = id => id === PLAYER || id === ALLY
    const targetId = Object.keys(names).find(id => names[id] === parameters.targetId)
    if (['strike', 'fire', 'mend', 'potion'].includes(operation)) {
      if (!state.participants.includes(targetId) || stats[targetId].hp <= 0) return { rejectReason: '目标不存在或已经倒下。' }
      const friendly = allied(actorId) === allied(targetId)
      if (friendly !== ['mend', 'potion'].includes(operation)) return { rejectReason: '攻击只能指向敌方，治疗只能指向己方。' }
    }
    if (['fire', 'mend'].includes(operation) && stats[actorId].mp < 3) return { rejectReason: '魔力不足，什么都没有发生。' }
    if (operation === 'potion' && truth.public.potions < 1) return { rejectReason: '药水已经用完。' }
    game.public.guarded = game.public.guarded.filter(id => id !== actorId)
    let description
    if (operation === 'strike' || operation === 'fire') {
      const raw = operation === 'fire' ? 18 : actorId === ENEMY ? 12 : actorId === ALLY ? 7 : 9
      const damage = game.public.guarded.includes(targetId) ? Math.ceil(raw / 2) : raw
      game.public.guarded = game.public.guarded.filter(id => id !== targetId)
      if (operation === 'fire') set(actorId, 'mp', stats[actorId].mp - 3)
      const hp = Math.max(0, stats[targetId].hp - damage)
      set(targetId, 'hp', hp)
      description = names[actorId] + (operation === 'fire' ? '施放火球术' : '普通攻击') + '，对' + names[targetId] + '造成' + damage + '点伤害，剩余' + hp + '生命。'
    } else if (operation === 'mend' || operation === 'potion') {
      const hp = Math.min(maxHp[targetId], stats[targetId].hp + (operation === 'mend' ? 12 : 16))
      if (hp === stats[targetId].hp) return { rejectReason: '目标生命已满，不消耗资源。' }
      if (operation === 'mend') set(actorId, 'mp', stats[actorId].mp - 3)
      else set(null, 'potions', truth.public.potions - 1)
      set(targetId, 'hp', hp)
      description = names[actorId] + (operation === 'mend' ? '施放治疗术' : '使用一瓶药水') + '，' + names[targetId] + '恢复至' + hp + '生命。'
    } else if (operation === 'guard') {
      game.public.guarded.push(actorId)
      description = names[actorId] + '采取防御，下次受到的攻击伤害减半，持续至自己下次行动。'
    } else if (operation === 'flee') {
      game.active = false; game.phase = 'fled'; game.turn = null
      game.public.phaseLabel = '已撤退'
      description = '队伍撤退，保留当前生命、魔力与剩余药水，没有获得奖励。'
    } else return { rejectReason: '没有这个战斗操作。' }
    game.public.standing = state.participants.filter(id => stats[id].hp > 0)
    if (game.active && (stats[ENEMY].hp === 0 || ![PLAYER, ALLY].some(id => stats[id].hp > 0))) {
      const won = stats[ENEMY].hp === 0
      game.active = false; game.phase = won ? 'victory' : 'defeat'; game.turn = null
      game.public.phaseLabel = won ? '胜利' : '失败'
      if (won) set(PLAYER, 'gold', stats[PLAYER].gold + 30)
      description += won ? ' 守卫倒下，队伍胜利，获得30金币。' : ' 队伍全部倒下，战斗失败。'
    }
    if (!game.active) set(null, 'encounter', game.phase)
    else {
      const order = game.public.order
      let index = order.indexOf(actorId)
      do { index = (index + 1) % order.length; if (index === 0) game.round += 1 }
      while (stats[order[index]].hp <= 0)
      game.turn = order[index]
    }
    game.public.lastResult = description
    return { game, description, audience: 'participants', status: { changes,
      reveals: changes.filter(c => c.holderId !== null && ['hp', 'mp'].includes(c.key))
        .flatMap(c => state.participants.map(observerId => ({ observerId, holderId: c.holderId, key: c.key }))) } }
  },
  schedule(view) {
    return view.game.active && view.game.turn !== PLAYER
      ? { kind: 'activate', characterId: view.game.turn } : { kind: 'wait' }
  },
  onOutcome(result, view) {
    return result.status === 'published' && !result.failure ? this.schedule(view) : { kind: 'wait' }
  },
  simulate(request) {
    const activity = request.context.activity
    const actorId = request.context.character.characterId
    const known = request.context.knownStatus
    const value = (holderId, key) => known.find(v => v.holderId === holderId && v.key === key && v.current)?.value
    if (actorId === ALLY && value(null, 'ally-model')) return null
    if (request.continuation) {
      // The final continuation may have no active activity; always use the actual execution result.
      if (request.result?.status !== 'accepted') return { decision: 'abstain' }
      return { decision: 'publish', segments: [{ type: 'speech', text: '这一手已经落定。' }] }
    }
    if (!activity) return null
    if (activity.game.turn !== actorId) return { decision: 'abstain' }
    let operation = 'strike', parameters = {}
    if (actorId === ENEMY) parameters.targetId = value(PLAYER, 'hp') > 0 ? PLAYER : ALLY
    else {
      const hurt = [PLAYER, ALLY].find(id => value(id, 'hp') > 0 && value(id, 'hp') <= 12)
      if (hurt && value(actorId, 'mp') >= 3) { operation = 'mend'; parameters.targetId = hurt }
      else { operation = value(actorId, 'mp') >= 3 ? 'fire' : 'strike'; parameters.targetId = ENEMY }
    }
    return { decision: 'perform', actionType: 'interact', parameters: {
      targetRef: { kind: 'character', id: actorId }, bindingId: activity.id,
      definitionRef: { id: 'activity:' + operation, version: 1 },
      arguments: { activityId: activity.id, revision: activity.revision,
        ...('targetId' in parameters ? { targetId: names[parameters.targetId] } : {}) },
    } }
  },
}
