// 晚宴的修理和料理规则：作者写条件和结果，宿主裁定并提交灶台、食材外观的变化。
// 工具、灶台和蒸馏器要在手里或就在这里；在场的人都能看到灶台修好了、桌上是哪道菜。
const none = { type: 'object', additionalProperties: false, properties: {} }
const BROKEN_STOVE = '灶台：打不着火。点火器外壳有被拆开又装回去的痕迹，两颗螺丝没拧紧'
const READY_STOVE = '灶台：点火正常，可以开火'
const RAW = '晚宴食材：一只整鸡、香菇、嫩豆腐、一把青菜，够五个人吃'
const COLD = '凉拌冷盘：凉拌豆腐、生拌青菜、香菇，中间郑重地摆着一只完全没处理的整鸡'
const HOME = '家常晚饭：鸡汤、香菇炖豆腐、炒青菜，朴素但热乎'
const FEAST = '蒸馏高汤赔罪大餐：用蒸馏器提纯的清澈鸡汤、香菇豆腐煲、清炒青菜，香得过分'

// ---- 物品规则模板：拿起、放下、交给 ----
// 这些规则由作者定义，可以整段修改或删除。宿主只裁定结果：物品够得着、同一时间只有一个持有者、
// 交给的人在场、放下只能放在脚下；与对白和观察一起提交，目击者会记下谁拿着什么。
// ITEM_RULES 列出每种动作可用于哪些已登记物品。
const ITEM_RULES = { take: ['entity:distiller', 'entity:notebook', 'entity:toolbox', 'entity:ingredients'], drop: ['entity:distiller', 'entity:notebook', 'entity:toolbox', 'entity:ingredients'], give: ['entity:distiller', 'entity:notebook', 'entity:toolbox', 'entity:ingredients'] }
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
      { id: 'repair', label: '修理灶台', targets: ['entity:stove'], schema: none },
      { id: 'cook-cold', label: '做一桌凉拌冷盘', targets: ['entity:ingredients'], schema: none },
      { id: 'cook-home', label: '开火做家常菜', targets: ['entity:ingredients'], schema: none },
      { id: 'cook-feast', label: '用蒸馏器熬高汤做大餐', targets: ['entity:ingredients'], schema: none },
      ...itemOperations,
    ],
  },
  // 只给能成的选项：坏灶台在、工具箱在手边才能修；生食材才能凉拌；灶台能点火才能开火，大餐还要蒸馏器。
  policy(known, actorId, place) {
    const item = id => place.items.find(entry => entry.entityId === id)
    const stove = item('entity:stove'),
      food = item('entity:ingredients')
    const raw = food?.kind === RAW,
      cookable = raw || food?.kind === COLD,
      fire = stove?.kind === READY_STOVE
    return {
      operations: ['repair', 'cook-cold', 'cook-home', 'cook-feast', ...itemOperations.map(op => op.id)],
      targets: {
        ...itemTargets(actorId, place),
        repair: stove?.kind === BROKEN_STOVE && item('entity:toolbox') ? [stove.entityId] : [],
        'cook-cold': raw ? [food.entityId] : [],
        'cook-home': cookable && fire ? [food.entityId] : [],
        'cook-feast': cookable && fire && item('entity:distiller') ? [food.entityId] : [],
      },
    }
  },
  initialize(characterIds) {
    return { public: {}, characters: Object.fromEntries(characterIds.map(id => [id, {}])) }
  },
  resolve(truth, actorId, operationId, parameters, world, targetId) {
    if (['take', 'drop', 'give'].includes(operationId)) return resolveItem(actorId, operationId, parameters, world, targetId)
    // In the actor's hands or here on the floor, as the built-in rules required.
    const here = id =>
      world.items.current.find(
        item =>
          item.entityId === id &&
          (item.holderId === actorId || (item.holderId === null && item.locationId === world.locationId)),
      )
    const target = world.items.current.find(item => item.entityId === targetId)
    const done = (kind, description) => ({
      changes: [],
      reveals: [],
      items: [{ entityId: targetId, kind }],
      description,
      audience: 'scene',
    })
    if (operationId === 'repair') {
      if (target?.kind !== BROKEN_STOVE) return { rejectReason: '灶台现在不需要修。' }
      if (!here('entity:toolbox')) return { rejectReason: '手边没有工具箱。' }
      return done(READY_STOVE, '拧紧了点火器的螺丝，灶台能打着火了。')
    }
    if (operationId === 'cook-cold') {
      if (target?.kind !== RAW) return { rejectReason: '食材已经不是生的了。' }
      return done(COLD, '把食材拌成了一桌凉拌冷盘。')
    }
    if (target?.kind !== RAW && target?.kind !== COLD) return { rejectReason: '这些食材已经做成菜了。' }
    if (here('entity:stove')?.kind !== READY_STOVE) return { rejectReason: '灶台还打不着火。' }
    if (operationId === 'cook-home') return done(HOME, '开火做了一桌家常晚饭。')
    if (!here('entity:distiller')) return { rejectReason: '手边没有蒸馏器。' }
    return done(FEAST, '用蒸馏器熬出高汤，做了一桌赔罪大餐。')
  },
}
