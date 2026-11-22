// Perspectra authored activity
const graph = {"key":"read-note","title":"读便笺","opening":"门廊的窗台上，压着一封尚未拆开的便笺。","choices":[{"id":"open-note","label":"展开便笺","condition":{"kind":"held","ref":"entity:opener"},"result":"你沿封口展开便笺，读到了信。","speech":"","next":"end"},{"id":"ask-alin","label":"请阿林帮忙","condition":{"kind":"present","ref":"character:companion"},"result":"你向阿林开口求助。","speech":"阿林，你能帮我看看这封信吗？","next":"end"},{"id":"leave","label":"先不拆","condition":{"kind":"always"},"result":"你把便笺放回窗台。","speech":"","next":"end"}]}
function available(choice, scene) {
  const condition = choice.condition
  if (condition.kind === 'always') return true
  return (condition.kind === 'present' ? scene.characterIds : scene.heldEntityIds).includes(condition.ref)
}
globalThis.activityScript = {
  definition: {
    title: graph.title, npcIds: [], readsScene: true,
    ...(graph.opening ? { opening: graph.opening } : {}),
    operations: graph.choices.map(choice => ({
      id: choice.id, label: choice.label, requiresTurn: true,
      schema: { type: 'object', additionalProperties: false, properties: {} }
    }))
  },
  initialize({playerId}) {
    return { active: true, phase: 'choice', turn: playerId, round: 1,
      public: {statusText:graph.opening}, private: {[playerId]:{}}, internal: {} }
  },
  policy(view) {
    return { speech:'free', speechChoices:[], narration:true, move:true, interactions:[],
      operations:graph.choices.filter(choice => available(choice, view.scene)).map(choice => choice.id) }
  },
  resolve(state, actor, operation, parameters, world) {
    const choice = graph.choices.find(c => c.id === operation)
    const scene = { characterIds: world.characterIds, heldEntityIds: world.items.current.filter(i => i.holderId === actor).map(i => i.entityId) }
    if (!choice || !available(choice, scene)) return {rejectReason:'条件已改变，请重新选择。'}
    const active = choice.next === 'stay'
    return { game:{...state.game, active, turn:active ? actor : null, phase:active ? 'choice' : 'ended',
      round:state.game.round+1, public:{...state.game.public,statusText:choice.result}},
      description:choice.result, audience:'self', ...(choice.speech ? {playerExpression:{text:choice.speech}} : {}) }
  },
  schedule() { return {kind:'wait'} },
  onOutcome() { return {kind:'wait'} }
}
