// Claude adjudicates. This script never compares a guess with the answer.
globalThis.activityScript = {
  definition: {
    title: 'Claude 主持的猜数字', npcIds: ['character:gpt', 'character:claude'],
    operations: [
      { id: 'open', label: '主持人开场', requiresTurn: true,
        schema: { type: 'object', additionalProperties: false, properties: {} } },
      { id: 'guess', label: '猜数字', requiresTurn: true,
        schema: { type: 'object', additionalProperties: false, required: ['value'],
          properties: { value: { title: '猜的数字', type: 'integer', minimum: 1, maximum: 100 } } } },
      { id: 'judge', label: '主持人裁决', requiresTurn: true,
        schema: { type: 'object', additionalProperties: false, required: ['verdict'],
          properties: { verdict: { title: '裁决', type: 'string', enum: ['偏大', '偏小', '猜中'] } } } },
      { id: 'pass', label: '主动让出回合', requiresTurn: true,
        schema: { type: 'object', additionalProperties: false, properties: {} } },
      { id: 'quit', label: '按玩法退出', requiresTurn: false,
        schema: { type: 'object', additionalProperties: false, properties: {} } },
    ],
  },
  initialize({ playerId, npcIds }) {
    const [guesserId, moderatorId] = npcIds;
    const answer = 1 + Math.floor(Math.random() * 100);
    return { active: true, phase: 'opening', turn: moderatorId, round: 1,
      public: { range: '1–100', guesses: 0, guessers: [playerId, guesserId], moderatorId,
        pending: null, nextGuesser: playerId, history: [], lastResult: '等待 Claude 主持人开场。',
        statusText: 'Claude 主持开场' },
      private: {
        [playerId]: { role: '猜测者' },
        [guesserId]: { role: '猜测者', instructions: '你与玩家轮流猜数。使用 guess 提交数字，等待主持人裁决；也可以主动 pass，不用对白代替游戏操作。' },
        [moderatorId]: { role: '主持人', answer,
          instructions: '你是主持人，只有你知道 answer。opening 阶段使用 open 开场；judging 阶段自己比较 pending.value 与 answer，使用 judge 提交偏大、偏小或猜中。脚本不会替你检查对错。不要向猜测者透露答案；先提交操作，再用 speech 串联和解释真实已提交的裁决。' },
      },
      internal: {},
    };
  },
  policy(view, actorId) {
    const host = actorId === view.game.public.moderatorId;
    const phase = view.game.phase;
    return { speech: 'free', speechChoices: [], narration: false, move: false, interactions: [],
      operations: host ? (phase === 'opening' ? ['open', 'quit'] : phase === 'judging' ? ['judge', 'quit'] : ['quit'])
        : phase === 'guessing' ? ['guess', 'pass', 'quit'] : ['quit'] };
  },
  resolve(state, actorId, operation, parameters) {
    const game = JSON.parse(JSON.stringify(state.game));
    const p = game.public;
    const host = actorId === p.moderatorId;
    let description;
    if (operation === 'quit') {
      game.active = false; game.phase = 'quit'; game.turn = null;
      p.statusText = '游戏已退出'; description = actorId + '退出了主持人猜数字游戏。';
    } else if (operation === 'open' && host && game.phase === 'opening') {
      game.phase = 'guessing'; game.turn = p.guessers[0]; p.statusText = '轮到玩家猜数';
      description = 'Claude 主持人宣布开场，玩家先猜，答案仅由主持人知晓。';
    } else if (operation === 'guess' && !host && game.phase === 'guessing') {
      p.guesses += 1; p.pending = { actorId, value: parameters.value };
      p.nextGuesser = p.guessers.find(id => id !== actorId);
      game.phase = 'judging'; game.turn = p.moderatorId; p.statusText = '等待 Claude 主持人裁决';
      description = actorId + '第' + p.guesses + '次提交猜测 ' + parameters.value + '，尚未裁决。';
    } else if (operation === 'judge' && host && game.phase === 'judging' && p.pending) {
      // Deliberately trust the moderator's verdict, including a mistaken verdict.
      const judged = { ...p.pending, verdict: parameters.verdict, judgedBy: actorId };
      p.history = [...p.history, judged].slice(-12);
      description = 'Claude 主持人对 ' + p.pending.actorId + ' 的猜测 ' + p.pending.value + ' 裁决为“' + parameters.verdict + '”。';
      game.round += 1; p.pending = null;
      if (parameters.verdict === '猜中') {
        p.winner = judged.actorId; game.active = false; game.phase = 'finished'; game.turn = null;
        p.statusText = '主持人宣布结束';
      } else {
        game.phase = 'guessing'; game.turn = p.nextGuesser;
        p.statusText = game.turn === p.guessers[0] ? '轮到玩家猜数' : '轮到 GPT 猜数';
      }
    } else if (operation === 'pass' && !host && game.phase === 'guessing') {
      game.round += 1; game.turn = p.guessers.find(id => id !== actorId);
      p.statusText = game.turn === p.guessers[0] ? '轮到玩家猜数' : '轮到 GPT 猜数';
      description = actorId + '主动让出了自己的猜数回合。';
    } else throw new TypeError('当前角色或阶段不能提交此操作');
    p.lastResult = description;
    return { game, description, audience: 'participants' };
  },
  schedule(view) {
    return view.game.active && view.game.turn !== view.participants[0]
      ? { kind: 'activate', characterId: view.game.turn } : { kind: 'wait' };
  },
  onOutcome(result, view) {
    return result.failure || result.status === 'interrupted' || result.performResult?.status !== 'accepted'
      ? { kind: 'wait' } : this.schedule(view);
  },
};
