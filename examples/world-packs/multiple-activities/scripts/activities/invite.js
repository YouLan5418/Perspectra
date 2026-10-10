globalThis.activityScript = {
  definition: {
    title: '约会邀请',
    participants: { mode: 'player-select', min: 1, max: 1 },
    operations: [
      { id: 'respond', label: '回应邀请', requiresTurn: true,
        schema: { type: 'object', additionalProperties: false, required: ['choice'],
          properties: { choice: { type: 'string', enum: ['接受', '拒绝'] } } } },
      { id: 'finish', label: '结束约会', requiresTurn: false,
        schema: { type: 'object', additionalProperties: false, properties: {} } },
      { id: 'cancel', label: '撤回邀请', requiresTurn: false,
        schema: { type: 'object', additionalProperties: false, properties: {} } }
    ]
  },
  initialize({ playerId, npcIds }) {
    return { active: true, phase: 'invited', turn: npcIds[0], round: 1,
      public: { inviter: playerId, invitee: npcIds[0], statusText: '等待对方回应约会邀请，尚未接受。' },
      private: Object.fromEntries([playerId, ...npcIds].map(id => [id, {}])), internal: {} };
  },
  policy(view, actorId) {
    return { speech: 'free', speechChoices: [], narration: true, move: view.game.phase === 'date', interactions: [],
      operations: actorId === view.game.public.invitee ? ['respond'] : view.game.phase === 'date' ? ['finish'] : ['cancel'] };
  },
  resolve(state, actorId, operation, parameters) {
    const game = JSON.parse(JSON.stringify(state.game));
    let description;
    if (operation === 'respond' && actorId === game.public.invitee && game.phase === 'invited') {
      if (parameters.choice === '接受') {
        game.phase = 'date'; game.turn = game.public.inviter;
        description = actorId + '接受了约会邀请。尚未移动或执行出行安排。';
      } else {
        game.active = false; game.phase = 'declined'; game.turn = null;
        description = actorId + '拒绝了约会邀请。';
      }
    } else if (actorId === game.public.inviter && ((operation === 'cancel' && game.phase === 'invited') || (operation === 'finish' && game.phase === 'date'))) {
      game.active = false; game.phase = operation === 'cancel' ? 'cancelled' : 'finished'; game.turn = null;
      description = operation === 'cancel' ? '邀请已撤回。' : '本次约会活动结束。';
    } else return { rejectReason: '当前不能执行此操作。' };
    game.round += 1; game.public.statusText = description;
    return { game, description, audience: 'participants' };
  },
  schedule(view) { return view.game.phase === 'invited' ? { kind: 'activate', characterId: view.game.public.invitee } : { kind: 'wait' }; },
  onOutcome() { return { kind: 'wait' }; }
};
