// Independent creator activity. Progress is committed by the host, never held in script globals.
globalThis.activityScript = {
  definition: {
    title: '讨论周末计划', npcIds: ['character:companion'],
    operations: [
      { id: 'vote', label: '表达周末偏好', requiresTurn: true,
        schema: { type: 'object', additionalProperties: false, required: ['choice'],
          properties: { choice: { title: '偏好', type: 'string', enum: ['在家休息', '出门散步'] } } } },
      { id: 'quit', label: '结束讨论', requiresTurn: false,
        schema: { type: 'object', additionalProperties: false, properties: {} } },
    ],
  },
  initialize({ playerId, npcIds }) {
    return { active: true, phase: 'discussion', turn: playerId, round: 1,
      public: { topic: '这个周末想怎样度过？可以先聊聊，再正式表达偏好。', votes: {}, lastResult: '玩家先表达偏好。' },
      private: Object.fromEntries([playerId, ...npcIds].map(id => [id, {}])), internal: {} };
  },
  policy() {
    return { speech: 'free', speechChoices: [], narration: true, move: false,
      interactions: [], operations: ['vote', 'quit'] };
  },
  resolve(state, actorId, operation, parameters) {
    const game = JSON.parse(JSON.stringify(state.game));
    let description;
    if (operation === 'quit') {
      game.active = false; game.phase = 'finished'; game.turn = null;
      description = '这次周末计划讨论结束，尚未替任何人安排实际出行。';
    } else if (operation === 'vote') {
      if (Object.hasOwn(game.public.votes, actorId)) return { rejectReason: '本次已经表达过偏好。' };
      game.public.votes[actorId] = parameters.choice;
      game.round += 1;
      const next = state.participants.find(id => !Object.hasOwn(game.public.votes, id));
      game.turn = next || null;
      if (!next) { game.active = false; game.phase = 'finished'; }
      description = actorId + '表达了偏好：' + parameters.choice + '。这只是意见，不代表已经移动或执行计划。';
    } else throw new TypeError('未声明的操作');
    game.public.lastResult = description;
    return { game, description, audience: 'participants' };
  },
  resume(view, world) {
    return view.participants.every(id => world.characterIds.includes(id))
      ? null : { rejectReason: '等讨论的参与者回到同一场景后再继续。' };
  },
  schedule(view) {
    return view.game.active && view.game.turn !== view.participants[0]
      ? { kind: 'activate', characterId: view.game.turn } : { kind: 'wait' };
  },
  onOutcome() { return { kind: 'wait' }; },
};
