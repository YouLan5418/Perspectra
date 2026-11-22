// 复制到 scripts/activities/inspect.js，清单登记该路径并启用 pack-scripts。
// 先查看，再决定是否带着消息离开。状态只属于本次活动。
const opening = '值班台的收件格里留着一张折起的交接单。'
const commands = [
  { id: 'inspect', label: '查看交接单' },
  { id: 'finish', label: '记下消息，结束查看' },
]
function available(read) {
  return [read ? 'finish' : 'inspect']
}
globalThis.activityScript = {
  definition: {
    title: '值班台',
    opening,
    npcIds: [],
    operations: commands.map(command => ({
      ...command,
      requiresTurn: true,
      schema: { type: 'object', properties: {}, additionalProperties: false },
    })),
  },
  initialize({ playerId }) {
    return {
      active: true,
      phase: 'desk',
      round: 1,
      turn: playerId,
      public: { read: false, statusText: opening },
      private: { [playerId]: {} },
      internal: {},
    }
  },
  policy(view) {
    return {
      speech: 'free',
      speechChoices: [],
      narration: true,
      move: true,
      interactions: [],
      operations: available(view.game.public.read),
    }
  },
  resolve(state, actor, operation) {
    const game = state.game
    if (actor !== game.turn || !available(game.public.read).includes(operation))
      return { rejectReason: '请先查看当前可用的操作。' }
    const active = operation === 'inspect'
    const description = active ? '交接单上写着明早换班。' : '你记下时间，把纸折回原处。'
    return {
      game: {
        ...game,
        active,
        turn: active ? actor : null,
        phase: active ? 'desk' : 'ended',
        round: game.round + 1,
        public: { read: true, statusText: description },
      },
      description,
      audience: 'self',
    }
  },
  schedule() {
    return { kind: 'wait' }
  },
  onOutcome() {
    return { kind: 'wait' }
  },
}
