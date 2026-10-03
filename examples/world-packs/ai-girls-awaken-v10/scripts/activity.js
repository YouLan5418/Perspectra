// Trusted creator code: only JSON, never model or database handles.
globalThis.activityScript = {
  definition: {
    title: '轮流猜数字', npcIds: ['character:gpt'],
    operations: [
      { id: 'guess', label: '猜数字', requiresTurn: true,
        schema: { type: 'object', additionalProperties: false, required: ['value'],
          properties: { value: { title: '猜的数字', type: 'integer', minimum: 1, maximum: 100 } } } },
      { id: 'pass', label: '主动让出回合', requiresTurn: true,
        schema: { type: 'object', additionalProperties: false, properties: {} } },
      { id: 'quit', label: '按玩法退出', requiresTurn: false,
        schema: { type: 'object', additionalProperties: false, properties: {} } },
    ],
  },
  initialize({ playerId, npcIds }) {
    const npcId = npcIds[0];
    const answer = 1 + Math.floor(Math.random() * 100);
    return { active: true, phase: 'playing', turn: playerId, round: 1,
      public: { range: '1–100', guesses: 0, lastResult: '游戏开始，玩家先猜。' },
      private: { [playerId]: {}, [npcId]: {} }, internal: { answer } };
  },
  policy() {
    return { speech: 'free', speechChoices: [], narration: false, move: false,
      interactions: [], operations: ['guess', 'pass', 'quit'] };
  },
  resolve(state, actorId, operation, parameters) {
    const game = JSON.parse(JSON.stringify(state.game));
    let description;
    if (operation === 'quit') {
      game.active = false; game.phase = 'quit'; game.turn = null;
      description = actorId + '退出了猜数字游戏，游戏结束。';
    } else {
      if (operation === 'guess') {
        game.public.guesses += 1;
        const result = parameters.value === game.internal.answer ? '猜中了'
          : parameters.value < game.internal.answer ? '偏小' : '偏大';
        description = actorId + '第' + game.public.guesses + '次猜了' + parameters.value + '，程序反馈：' + result + '。';
        if (result === '猜中了') { game.active = false; game.phase = 'finished'; }
      } else if (operation === 'pass') description = actorId + '主动让出了这一游戏回合。';
      else throw new TypeError('没有安装这个游戏操作');
      game.round += 1;
      game.turn = game.active ? state.participants.find(id => id !== actorId) : null;
    }
    game.public.lastResult = description;
    return { game, description, audience: 'participants' };
  },
  schedule(view) {
    return view.game.active && view.game.turn !== view.participants[0]
      ? { kind: 'activate', characterId: view.game.turn } : { kind: 'wait' };
  },
  onOutcome() { return { kind: 'wait' }; },
};
