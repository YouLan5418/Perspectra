// Trusted creator script. simulate substitutes a response, never an execution.
globalThis.activityScript = {
  definition: {
    title: '雨夜来信', npcIds: ['character:companion', 'character:friend'],
    operations: [
      { id: 'beat', label: '推进演出节点', requiresTurn: true,
        schema: { type: 'object', additionalProperties: false, required: ['cue'],
          properties: { cue: { type: 'string', enum: ['opening', 'reply', 'closing'] },
            choice: { type: 'string', enum: ['hear', 'leave'] } } } },
      { id: 'choose', label: '选择回应', requiresTurn: true,
        schema: { type: 'object', additionalProperties: false, required: ['choice'],
          properties: { choice: { type: 'string', enum: ['hear', 'leave'] } } } },
      { id: 'quit', label: '退出演出', requiresTurn: false,
        schema: { type: 'object', additionalProperties: false, properties: {} } },
    ],
  },
  initialize({ playerId, npcIds }) {
    return { active: true, phase: 'opening', turn: npcIds[0], round: 1,
      public: { choice: null }, private: { [playerId]: {}, [npcIds[0]]: {}, [npcIds[1]]: {} }, internal: {} };
  },
  policy(view, actorId) {
    const player = actorId === view.participants[0];
    return { speech: 'free', speechChoices: [], narration: true, move: false, interactions: [],
      operations: player ? (view.game.phase === 'choice' ? ['choose', 'quit'] : ['quit']) : ['beat'] };
  },
  resolve(state, actorId, operation, parameters) {
    const game = JSON.parse(JSON.stringify(state.game));
    if (operation === 'quit') {
      game.active = false; game.phase = 'quit'; game.turn = null;
    } else if (operation === 'choose') {
      if (actorId !== state.participants[0] || game.phase !== 'choice') throw new TypeError('现在不能选择');
      game.public.choice = parameters.choice; game.phase = 'closing'; game.turn = state.participants[1];
    } else if (operation === 'beat') {
      if (parameters.cue !== game.phase || (game.phase === 'closing' && parameters.choice !== game.public.choice)) throw new TypeError('演出节点已经失效');
      if (game.phase === 'opening') { game.phase = 'reply'; game.turn = state.participants[2]; }
      else if (game.phase === 'reply') { game.phase = 'choice'; game.turn = state.participants[0]; }
      else if (game.phase === 'closing') { game.active = false; game.phase = 'finished'; game.turn = null; }
      else throw new TypeError('当前没有演出节点');
    } else throw new TypeError('未知操作');
    game.round += 1;
    const description = operation === 'quit' ? '你结束了这段谈话。'
      : operation === 'choose' ? (parameters.choice === 'hear' ? '你示意愿意继续听。' : '你示意今天先到这里。')
      : parameters.cue === 'opening' ? '同行者想说起一封信。'
      : parameters.cue === 'reply' ? '留守者回应了这份迟疑。' : '同行者回应了你的选择。';
    return { game, description, audience: 'participants' };
  },
  schedule(view) {
    return view.game.active && view.game.turn !== view.participants[0]
      ? { kind: 'activate', characterId: view.game.turn } : { kind: 'wait' };
  },
  onOutcome(result, view) {
    // A failed or unpublished beat must not trigger the next character.
    return result.status === 'published' && !result.failure ? this.schedule(view) : { kind: 'wait' };
  },
  simulate(request) {
    if (request.continuation) {
      if (request.result?.status !== 'accepted') return { decision: 'abstain' };
      const cue = request.result.action.parameters.arguments.cue;
      const choice = request.result.action.parameters.arguments.choice;
      const segments = cue === 'opening' ? [
        { type: 'narration', text: '同行者抬起眼，话到嘴边又停了一瞬。' },
        { type: 'speech', text: '有封信，我一直没念。不是因为字难认，是怕念完以后，就得给它一个答复。' },
      ] : cue === 'reply' ? [
        { type: 'narration', text: '留守者没有催促，只把声音放轻。' },
        { type: 'speech', text: '那就先别急着答复。有人愿意听，和你必须答应，是两回事。你想听下去吗？' },
      ] : choice === 'leave' ? [
        { type: 'speech', text: '好，今天到这里。等你愿意听的时候，我再从这句话接下去。' },
      ] : [
        { type: 'narration', text: '同行者慢慢吐出一口气。' },
        { type: 'speech', text: '谢谢。信里只有一句：如果你还记得，明晚请来。可我连自己记得什么，都不敢说准。' },
      ];
      return { decision: 'publish', segments };
    }
    const activity = request.context.activity;
    if (!activity) return null;
    return { decision: 'perform', actionType: 'interact', parameters: {
      targetRef: { kind: 'character', id: request.context.character.characterId },
      bindingId: activity.id, definitionRef: { id: 'activity:beat', version: 1 },
      arguments: { activityId: activity.id, revision: activity.revision, cue: activity.game.phase,
        ...(activity.game.phase === 'closing' ? { choice: activity.game.public.choice } : {}) },
    } };
  },
};
