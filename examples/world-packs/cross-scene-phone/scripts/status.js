// 本包的物品规则：拿起、放下、交给由下面的作者模板定义，没有状态值。
// ---- 物品规则模板：拿起、放下、交给 ----
// 这些规则由作者定义，可以整段修改或删除。宿主只裁定结果：物品够得着、同一时间只有一个持有者、
// 交给的人在场、放下只能放在脚下；与对白和观察一起提交，目击者会记下谁拿着什么。
// ITEM_RULES 列出每种动作可用于哪些已登记物品。
const ITEM_RULES = { take: ['entity:brass-key', 'entity:thermos'], drop: ['entity:brass-key'], give: ['entity:brass-key'] }
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
  definition: { statuses: [], operations: itemOperations },
  initialize(characterIds) {
    return { public: {}, characters: Object.fromEntries(characterIds.map(id => [id, {}])) }
  },
  policy(known, actorId, place) {
    return { operations: itemOperations.map(op => op.id), targets: itemTargets(actorId, place) }
  },
  resolve(truth, actorId, operationId, parameters, world, targetId) {
    return resolveItem(actorId, operationId, parameters, world, targetId)
  },
}
