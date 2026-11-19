// The final reply has been read. The player chooses how to close this scene.
const none = { type: 'object', additionalProperties: false, properties: {} }
globalThis.activityScript = {
  definition: {
    title: '游戏之夜的来信',
    npcIds: ['character:gpt'],
    handoff: { phase: 'closing', finish: 'finish', target: 'game-battle', label: '来一局 RPG' },
    operations: [
      { id: 'read', label: '读信', requiresTurn: true, schema: none },
      { id: 'finish', label: '收起信，回到日常', requiresTurn: true, schema: none },
    ],
  },
  initialize({ playerId, npcIds }) {
    return {
      active: true,
      phase: 'reading',
      turn: playerId,
      round: 1,
      public: { objective: '把信读完。' },
      private: Object.fromEntries([playerId, ...npcIds].map(id => [id, {}])),
      internal: {},
    }
  },
  policy(view, actor) {
    return {
      speech: 'free',
      speechChoices: [],
      narration: true,
      move: false,
      interactions: [],
      operations: actor !== view.game.turn ? [] : [view.game.phase === 'reading' ? 'read' : 'finish'],
    }
  },
  resolve(state, actor, op, args, world, truth) {
    const game = JSON.parse(JSON.stringify(state.game))
    if (op === 'read') {
      game.phase = 'closing'
      game.public.lastResult = '信读完了。GPT 把另一只手柄递给你。'
      return { game, audience: 'participants', description: game.public.lastResult }
    }
    game.phase = 'finished'
    game.active = false
    game.turn = null
    return {
      game,
      audience: 'participants',
      description: '你收起信封和信里的五元硬币。',
      status: { changes: [{ holderId: actor, key: 'money', value: truth.characters[actor].money + 5 }], reveals: [] },
    }
  },
  schedule() {
    return { kind: 'wait' }
  },
  onOutcome() {
    return { kind: 'wait' }
  },
}
