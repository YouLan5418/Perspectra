// Test activity script for the status bar: a duel whose attacks change the activity-scoped hp.
const object = { type: 'object', additionalProperties: false, properties: {} }
globalThis.activityScript = {
  definition: {
    title: '决斗', npcIds: ['character:companion'],
    operations: [
      { id: 'attack', label: '攻击', requiresTurn: false, schema: object },
      { id: 'yield', label: '认输', requiresTurn: false, schema: object },
    ],
  },
  initialize({ playerId, npcIds }) {
    return { active: true, phase: 'fighting', turn: playerId, round: 1, public: {},
      private: { [playerId]: {}, [npcIds[0]]: {} }, internal: {} }
  },
  policy() {
    return { speech: 'free', speechChoices: [], narration: false, move: false,
      interactions: ['status:drink-potion'], operations: ['attack', 'yield'] }
  },
  resolve(state, actorId, operation, parameters, world, truth) {
    const game = JSON.parse(JSON.stringify(state.game))
    const target = state.participants.find(id => id !== actorId)
    game.round += 1
    if (operation === 'yield') {
      game.active = false; game.phase = 'finished'; game.turn = null
      return { game, description: actorId + '认输，决斗结束。', audience: 'participants' }
    }
    game.turn = target
    const hp = truth.characters[target].hp - 5
    // Both fighters, and anyone watching in the actor's scene, see the blow land.
    return { game, description: actorId + '攻击了' + target, audience: 'participants',
      status: { changes: [{ holderId: target, key: 'hp', value: hp }],
        reveals: [...new Set([actorId, target, ...world.characterIds])].map(observerId => ({ observerId, holderId: target, key: 'hp' })) } }
  },
  schedule(view) {
    return view.game.active && view.game.turn !== view.participants[0]
      ? { kind: 'activate', characterId: view.game.turn } : { kind: 'wait' }
  },
  onOutcome() { return { kind: 'wait' } },
}
