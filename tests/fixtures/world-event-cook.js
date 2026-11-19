// Isolated author fixture; the Host owns instance, turn and revision.
const steps = [
  ['heat-stove', '把汤煨上', 'simmer', '汤已煨上，盖好锅盖。'],
  ['plate', '盛汤收锅', 'finished', '用余温完成了料理。'],
]
globalThis.activityScript = {
  definition: {
    title: '料理',
    npcIds: ['character:companion'],
    operations: [...steps, ['electric-finish', '用电炉收汁']].map(([id, label]) => ({
      id,
      label,
      requiresTurn: true,
      schema: { type: 'object', properties: {}, additionalProperties: false },
    })),
  },
  initialize({ playerId, npcIds }) {
    return {
      active: true,
      phase: 'ready',
      turn: playerId,
      round: 1,
      public: { completed: 0, portions: 1 },
      private: Object.fromEntries([playerId, ...npcIds].map(id => [id, {}])),
      internal: {},
    }
  },
  policy(view) {
    const step = steps[view.game.public.completed]
    const asking = view.game.phase === 'simmer'
    return {
      speech: asking ? 'choices' : 'free',
      speechChoices: asking ? ['我想调查停电。'] : [],
      narration: true,
      move: false,
      interactions: [],
      operations: asking ? ['plate', 'electric-finish'] : step ? [step[0]] : [],
    }
  },
  resolve(state, actor, op, parameters, world, truth) {
    const game = JSON.parse(JSON.stringify(state.game))
    const step = steps[game.public.completed]
    const electric = game.phase === 'simmer' && op === 'electric-finish'
    if (electric && truth?.public.power !== true) return { rejectReason: '停电，电炉无法加热。' }
    if (!step || (!electric && op !== step[0])) return { rejectReason: '当前步骤不允许这个操作。' }
    game.phase = step[2]
    game.public.completed++
    game.round++
    if (game.phase === 'finished') {
      game.public.portions--
      game.active = false
      game.turn = null
    }
    return { game, description: electric ? '电炉收汁完成。' : step[3], audience: 'participants' }
  },
  schedule() {
    return { kind: 'wait' }
  },
  onOutcome() {
    return { kind: 'wait' }
  },
}
