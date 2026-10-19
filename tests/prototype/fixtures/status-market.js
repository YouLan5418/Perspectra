// Test author script shared by the status bar tests: a small market with money, time and duel HP.
const object = { type: 'object', additionalProperties: false }
globalThis.statusScript = {
  definition: {
    statuses: [
      { key: 'money', label: '余额', type: 'number', owner: 'character' },
      { key: 'time', label: '时间', type: 'number', owner: 'public', alwaysKnown: true },
      { key: 'hp', label: '生命', type: 'number', owner: 'character', activities: ['duel'] },
    ],
    operations: [
      { id: 'buy', label: '购买', schema: { ...object, required: ['price'],
        properties: { price: { type: 'integer', minimum: 1, maximum: 1000 } } } },
      { id: 'steal', label: '偷窃', characterParameters: ['targetId'], actors: 'npc',
        schema: { ...object, required: ['targetId'], properties: { targetId: { type: 'string' } } } },
      { id: 'check-purse', label: '查看钱包', schema: { ...object, properties: {} } },
      { id: 'set-time', label: '设置时间', actors: 'player', schema: { ...object, required: ['value'],
        properties: { value: { type: 'integer', minimum: 0 } } } },
      { id: 'drink-potion', label: '喝药水', activities: ['duel'], schema: { ...object, properties: {} } },
    ],
  },
  initialize(characterIds) {
    return { public: { time: 0 },
      characters: Object.fromEntries(characterIds.map(id => [id, { money: 100, hp: 20 }])) }
  },
  resolve(truth, actorId, operationId, parameters) {
    const own = truth.characters[actorId]
    const purse = { observerId: actorId, holderId: actorId, key: 'money' }
    if (operationId === 'buy') {
      if (own.money < parameters.price) return { changes: [], reveals: [purse], description: '余额不足', audience: 'self' }
      return { changes: [{ holderId: actorId, key: 'money', value: own.money - parameters.price }],
        reveals: [purse], description: '购买成功', audience: 'scene' }
    }
    if (operationId === 'steal') {
      if (parameters.targetId === actorId) return { rejectReason: '不能偷自己的钱袋' }
      const victim = truth.characters[parameters.targetId]
      const amount = Math.min(30, victim.money)
      return { changes: [{ holderId: parameters.targetId, key: 'money', value: victim.money - amount },
        { holderId: actorId, key: 'money', value: own.money + amount }],
      reveals: [purse], description: '偷到了' + amount, audience: 'self' }
    }
    if (operationId === 'check-purse') return { changes: [], reveals: [purse], description: '查看了钱包', audience: 'self' }
    if (operationId === 'set-time') {
      return { changes: [{ holderId: null, key: 'time', value: parameters.value }], reveals: [], description: '时间已设置', audience: 'self' }
    }
    if (operationId === 'drink-potion') {
      return { changes: [{ holderId: actorId, key: 'hp', value: own.hp + 5 }], reveals: [], description: '喝下药水', audience: 'scene' }
    }
    return { rejectReason: '没有这个操作' }
  },
  onRoundEnd(truth) {
    return { changes: [{ holderId: null, key: 'time', value: truth.public.time + 10 }], reveals: [] }
  },
}
