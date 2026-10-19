// 集市状态脚本：每个角色有自己的余额，时间公开可见并在每轮结束时推进 10 分钟。
// 真实值只记录在世界事件里；每个角色只知道告知给自己的值（之后可能过期）。
const object = { type: 'object', additionalProperties: false }
globalThis.statusScript = {
  definition: {
    statuses: [
      { key: 'money', label: '余额', type: 'number', owner: 'character' },
      { key: 'time', label: '时间', type: 'number', owner: 'public', alwaysKnown: true },
    ],
    operations: [
      { id: 'buy', label: '购买', schema: { ...object, required: ['price'],
        properties: { price: { type: 'integer', minimum: 1, maximum: 1000 } } } },
      // 只有 NPC 可以偷；目标必须是当前场景里的角色，由宿主校验。
      { id: 'steal', label: '偷窃', characterParameters: ['targetId'], actors: 'npc',
        schema: { ...object, required: ['targetId'], properties: { targetId: { type: 'string' } } } },
      { id: 'check-purse', label: '查看钱包', schema: { ...object, properties: {} } },
    ],
  },
  initialize(characterIds) {
    return { public: { time: 0 },
      characters: Object.fromEntries(characterIds.map(id => [id, { money: 100 }])) }
  },
  resolve(truth, actorId, operationId, parameters) {
    const own = truth.characters[actorId]
    // 告知只写“告诉谁、谁的哪个状态”，值由宿主按本次结果填入。
    const purse = { observerId: actorId, holderId: actorId, key: 'money' }
    if (operationId === 'buy') {
      if (own.money < parameters.price) return { changes: [], reveals: [purse], description: '余额不足，没有买成', audience: 'self' }
      return { changes: [{ holderId: actorId, key: 'money', value: own.money - parameters.price }],
        reveals: [purse], description: '花 ' + parameters.price + ' 买下了东西', audience: 'scene' }
    }
    if (operationId === 'steal') {
      if (parameters.targetId === actorId) return { rejectReason: '不能偷自己的钱袋' }
      const victim = truth.characters[parameters.targetId]
      const amount = Math.min(30, victim.money)
      // 失主不会被告知：它的状态栏继续显示上次确认的余额，并标为可能已过期。
      return { changes: [{ holderId: parameters.targetId, key: 'money', value: victim.money - amount },
        { holderId: actorId, key: 'money', value: own.money + amount }],
      reveals: [purse], description: '偷偷摸走了 ' + amount, audience: 'self' }
    }
    if (operationId === 'check-purse') return { changes: [], reveals: [purse], description: '低头看了看钱包', audience: 'self' }
    return { rejectReason: '没有这个操作' }
  },
  onRoundEnd(truth) {
    return { changes: [{ holderId: null, key: 'time', value: truth.public.time + 10 }], reveals: [] }
  },
}
