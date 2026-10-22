// 官方同居包的料理规则：作者写煮饭和吃饭的条件与结果，宿主裁定并提交那锅米外观的变化。
// 这里没有状态值，只用操作；在场的人都能看到锅里现在是生米、熟饭还是空锅。
const none = { type: 'object', additionalProperties: false, properties: {} }
// ---- 物品规则模板：拿起、放下、交给 ----
// 这些规则由作者定义，可以整段修改或删除。宿主只裁定结果：物品够得着、同一时间只有一个持有者、
// 交给的人在场、放下只能放在脚下；与对白和观察一起提交，目击者会记下谁拿着什么。
// ITEM_RULES 列出每种动作可用于哪些已登记物品。
const ITEM_RULES = { take: ['entity:rice-batch', 'entity:strawberry-cake'], drop: ['entity:rice-batch', 'entity:strawberry-cake'], give: ['entity:rice-batch', 'entity:strawberry-cake'] }
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
    statuses: [],
    operations: [
      { id: 'cook-rice', label: '用电饭煲煮一锅白米饭', targets: ['entity:rice-batch'], schema: none },
      { id: 'eat-rice', label: '把这锅饭吃完', targets: ['entity:rice-batch'], schema: none },
      ...itemOperations,
    ],
  },
  // 只给能成的选项：生米旁边放着电饭煲才能煮，熟饭才能吃。执行时宿主再检查一次。
  policy(known, actorId, place) {
    const rice = place.items.find(item => item.entityId === 'entity:rice-batch')
    const cooker = place.items.find(item => item.entityId === 'entity:rice-cooker')
    return {
      operations: ['cook-rice', 'eat-rice', ...itemOperations.map(op => op.id)],
      targets: {
        ...itemTargets(actorId, place),
        'cook-rice': rice?.kind === 'raw-rice-kit' && cooker?.holderId === null ? [rice.entityId] : [],
        'eat-rice': rice?.kind === 'cooked-rice' ? [rice.entityId] : [],
      },
    }
  },
  initialize(characterIds) {
    return { public: {}, characters: Object.fromEntries(characterIds.map(id => [id, {}])) }
  },
  resolve(truth, actorId, operationId, parameters, world, targetId) {
    if (['take', 'drop', 'give'].includes(operationId)) return resolveItem(actorId, operationId, parameters, world, targetId)
    const items = world.items.current
    const rice = items.find(item => item.entityId === targetId)
    if (operationId === 'cook-rice') {
      if (rice?.kind !== 'raw-rice-kit') return { rejectReason: '这份米已经不是生米了。' }
      const cooker = items.find(item => item.entityId === 'entity:rice-cooker')
      if (!cooker || cooker.holderId !== null || cooker.locationId !== world.locationId)
        return { rejectReason: '需要这里放着的电饭煲。' }
      return {
        changes: [],
        reveals: [],
        items: [{ entityId: targetId, kind: 'cooked-rice' }],
        description: '这一份米与水已煮成一锅白米饭；原食材不再可用。',
        audience: 'scene',
      }
    }
    if (rice?.kind !== 'cooked-rice') return { rejectReason: '这里没有煮好的饭。' }
    return {
      changes: [],
      reveals: [],
      items: [{ entityId: targetId, kind: 'empty-meal-container' }],
      description: '这一锅白米饭已经吃完，剩下空容器；不能再吃，也不能当作生米再煮。',
      audience: 'scene',
    }
  },
}
