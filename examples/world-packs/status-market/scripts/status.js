// 集市状态脚本：每个角色有自己的余额，时间公开可见并在每轮结束时推进 10 分钟。
// 真实值只记录在世界事件里；每个角色只知道告知给自己的值（之后可能过期）。
const object = { type: 'object', additionalProperties: false }

// ---- 物品规则模板：拿起、放下、交给 ----
// 这些规则由作者定义，可以整段修改或删除。宿主只裁定结果：物品够得着、同一时间只有一个持有者、
// 交给的人在场、放下只能放在脚下；与对白和观察一起提交，目击者会记下谁拿着什么。
// ITEM_RULES 列出每种动作可用于哪些已登记物品。
const ITEM_RULES = { take: ['entity:thermos'], drop: ['entity:thermos'], give: ['entity:thermos'] }
const noItemInput = { type: 'object', additionalProperties: false, properties: {} }
const itemOperations = [
  { id: 'take', label: '拿起{item}', targets: ITEM_RULES.take, schema: noItemInput },
  { id: 'drop', label: '放下{item}', targets: ITEM_RULES.drop, schema: noItemInput },
  {
    id: 'give',
    label: '把{item}交给',
    targets: ITEM_RULES.give,
    characterParameters: ['recipientId'],
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['recipientId'],
      properties: { recipientId: { type: 'string', title: '交给谁' } },
    },
  },
].filter(op => op.targets.length)
// 只给能成的选项：地上的才能拿，自己拿着的才能放下或交出去。
function itemTargets(actorId, place) {
  const where = (ids, held) =>
    place.items
      .filter(item => ids.includes(item.entityId) && (held ? item.holderId === actorId : item.holderId === null))
      .map(item => item.entityId)
  const targets = { take: where(ITEM_RULES.take, false), drop: where(ITEM_RULES.drop, true), give: where(ITEM_RULES.give, true) }
  return Object.fromEntries(itemOperations.map(op => [op.id, targets[op.id]]))
}
function resolveItem(actorId, operationId, parameters, world, targetId) {
  const item = world.items.current.find(entry => entry.entityId === targetId)
  if (!item) return { rejectReason: '看不到这件东西。' }
  const name = item.name ?? item.kind
  const done = (to, description) => ({
    changes: [],
    reveals: [],
    items: [{ entityId: targetId, to }],
    description,
    audience: 'scene',
  })
  if (operationId === 'take') {
    if (item.holderId !== null) return { rejectReason: '已经有人拿着了。' }
    return done({ holderId: actorId }, '拿起了' + name + '。')
  }
  if (item.holderId !== actorId) return { rejectReason: '你手里没有这件东西。' }
  if (operationId === 'drop') return done({ locationId: world.locationId }, '把' + name + '放在了这里。')
  if (parameters.recipientId === actorId) return { rejectReason: '不能交给自己。' }
  return done({ holderId: parameters.recipientId }, '把' + name + '交了过去。')
}
// ---- 模板结束 ----

globalThis.statusScript = {
  definition: {
    statuses: [
      { key: 'money', label: '余额', type: 'number', owner: 'character' },
      { key: 'time', label: '时间', type: 'number', owner: 'public', alwaysKnown: true },
      { key: 'quests', label: '委托记录', type: 'object', owner: 'character', schema: {
        type: 'object', maxProperties: 32, additionalProperties: {
          type: 'object', additionalProperties: false, required: ['stage', 'notes'], properties: {
            stage: { type: 'string', enum: ['active', 'done', 'claimed'] },
            notes: { type: 'array', maxItems: 16, items: { type: 'string', maxLength: 200 } },
          },
        },
      } },
    ],
    operations: [
      { id: 'buy', label: '购买', schema: { ...object, required: ['price'],
        properties: { price: { type: 'integer', minimum: 1, maximum: 1000 } } } },
      // 只有 NPC 可以偷；目标必须是当前场景里的角色，由宿主校验。
      { id: 'steal', label: '偷窃', characterParameters: ['targetId'], actors: 'npc',
        schema: { ...object, required: ['targetId'], properties: { targetId: { type: 'string' } } } },
      // 与偷窃同样是“别人暗中改动你的余额”，只是方向相反：悄悄把钱塞进对方钱袋。
      { id: 'slip-money', label: '悄悄往别人钱袋里塞钱', characterParameters: ['targetId'], actors: 'npc',
        schema: { ...object, required: ['targetId', 'amount'], properties: { targetId: { type: 'string' },
          amount: { type: 'integer', minimum: 1, maximum: 1000 } } } },
      { id: 'check-purse', label: '查看钱包', schema: { ...object, properties: {} } },
      { id: 'accept-task', label: '领取演示委托', schema: { ...object, properties: {} } },
      { id: 'finish-task', label: '完成演示委托', schema: { ...object, properties: {} } },
      { id: 'claim-reward', label: '领取委托报酬', schema: { ...object, properties: {} } },
      ...itemOperations,
    ],
  },
  initialize(characterIds) {
    return { public: { time: 0 },
      characters: Object.fromEntries(characterIds.map(id => [id, { money: 100, quests: {} }])) }
  },
  // Only known values and what is within reach decide which options appear. The host applies this again when executing.
  policy(known, actorId, place) {
    const stage = known.self.quests?.market?.stage
    return { operations: ['buy', 'steal', 'slip-money', 'check-purse', 'take', 'drop', 'give',
      ...(!stage ? ['accept-task'] : stage === 'active' ? ['finish-task'] : stage === 'done' ? ['claim-reward'] : [])],
    targets: itemTargets(actorId, place) }
  },
  resolve(truth, actorId, operationId, parameters, world, targetId) {
    if (['take', 'drop', 'give'].includes(operationId)) return resolveItem(actorId, operationId, parameters, world, targetId)
    const own = truth.characters[actorId]
    // 告知只写“告诉谁、谁的哪个状态”，值由宿主按本次结果填入。
    const purse = { observerId: actorId, holderId: actorId, key: 'money' }
    // This deliberately small demo uses explicit operations for progress, never narrative text.
    const quest = own.quests.market
    if (operationId === 'accept-task') {
      if (quest) return { rejectReason: '已经领取过这个委托' }
      return { changes: [{ holderId: actorId, key: 'quests', value: {
        ...own.quests, market: { stage: 'active', notes: ['领取委托'] },
      } }], reveals: [], description: '领取了演示委托，可以执行完成操作。', audience: 'self' }
    }
    if (operationId === 'finish-task') {
      if (quest?.stage !== 'active') return { rejectReason: '没有正在进行的委托' }
      return { changes: [{ holderId: actorId, key: 'quests', value: {
        ...own.quests, market: { stage: 'done', notes: [...quest.notes, '完成演示流程'] },
      } }], reveals: [], description: '演示委托已完成，现在可以领取 30 报酬。', audience: 'self' }
    }
    if (operationId === 'claim-reward') {
      if (quest?.stage !== 'done') return { rejectReason: '委托未完成或已经领取过报酬' }
      return { changes: [
        { holderId: actorId, key: 'money', value: own.money + 30 },
        { holderId: actorId, key: 'quests', value: { ...own.quests, market: { ...quest, stage: 'claimed' } } },
      ], reveals: [], description: '已领取 30 报酬，这个委托不能再次领奖。', audience: 'self' }
    }
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
    if (operationId === 'slip-money') {
      if (parameters.targetId === actorId) return { rejectReason: '不能往自己的钱袋里塞钱' }
      if (own.money < parameters.amount) return { changes: [], reveals: [purse], description: '钱不够，没塞成', audience: 'self' }
      const receiver = truth.characters[parameters.targetId]
      // 收钱的人同样不会被告知：状态栏继续显示上次确认的余额，并标为可能已过期。
      return { changes: [{ holderId: parameters.targetId, key: 'money', value: receiver.money + parameters.amount },
        { holderId: actorId, key: 'money', value: own.money - parameters.amount }],
      reveals: [purse], description: '悄悄往对方钱袋里塞了 ' + parameters.amount, audience: 'self' }
    }
    if (operationId === 'check-purse') return { changes: [], reveals: [purse], description: '低头看了看钱包', audience: 'self' }
    return { rejectReason: '没有这个操作' }
  },
  onRoundEnd(truth) {
    return { changes: [{ holderId: null, key: 'time', value: truth.public.time + 10 }], reveals: [] }
  },
}
