// RPG 状态模块的运行时规则。生成器把本文件的原始字节与一行 install(<配置>) 拼成包模块脚本，
// 所以这里只能用不依赖 import/export 的普通脚本写法，并且只读取 install 收到的配置。
function install(config) {
  const USED = '（已用完）'
  const stats = config.stats
  const maxKey = key => 'rpg-' + key + '-max'
  const statKey = key => 'rpg-' + key
  const statLabel = key => stats.find(stat => stat.key === key).label
  const noInput = { type: 'object', additionalProperties: false, properties: {} }
  const consumables = Object.keys(config.consumables)
  const equipment = Object.keys(config.equipment)

  const statuses = stats.flatMap(stat => {
    const where = stat.locations ? { locations: stat.locations } : {}
    return [
      { key: statKey(stat.key), label: stat.label, type: 'number', owner: 'character', bar: true, ...where },
      { key: maxKey(stat.key), label: stat.label + '上限', type: 'number', owner: 'character', ...where },
    ]
  })
  statuses.push({
    key: 'rpg-equipment',
    label: '装备',
    type: 'object',
    owner: 'character',
    schema: { type: 'object', maxProperties: 8, additionalProperties: { type: 'string', maxLength: 100 } },
  })

  const actions = []
  if (config.rest) actions.push({ id: 'rest', label: config.rest.label, schema: noInput })
  if (consumables.length) actions.push({ id: 'use', label: '使用{item}', targets: consumables, schema: noInput })
  if (equipment.length) {
    actions.push({ id: 'equip', label: '装备{item}', targets: equipment, schema: noInput })
    actions.push({ id: 'unequip', label: '卸下{item}', targets: equipment, schema: noInput })
  }

  const worn = own => (own && own['rpg-equipment']) || {}
  const slotOf = (own, entityId) => Object.keys(worn(own)).find(slot => worn(own)[slot] === entityId)
  const spent = item => typeof item.kind === 'string' && item.kind.endsWith(USED)
  const canRest = locationId => !!config.rest && config.rest.locations.includes(locationId)
  const slotsOf = actorId => (config.characters[actorId] ? config.characters[actorId].slots : [])

  function initialize(ids) {
    const own = id => {
      const base = config.characters[id] ? config.characters[id].stats : {}
      const row = { 'rpg-equipment': {} }
      for (const stat of stats) {
        row[statKey(stat.key)] = base[stat.key] || 0
        row[maxKey(stat.key)] = base[stat.key] || 0
      }
      return row
    }
    return { public: {}, characters: Object.fromEntries(ids.map(id => [id, own(id)])) }
  }

  // 只给现在可能成功的选项；执行时 resolve 会按真值再查一遍。
  function policy(known, actorId, place) {
    const mine = place.items.filter(item => item.holderId === actorId)
    const self = known.self
    const targets = {}
    const operations = []
    if (canRest(place.locationId)) operations.push('rest')
    const usable = mine.filter(item => consumables.includes(item.entityId) && !spent(item)).map(item => item.entityId)
    if (usable.length) {
      operations.push('use')
      targets.use = usable
    }
    const equippable = mine
      .filter(item => equipment.includes(item.entityId) && slotsOf(actorId).includes(config.equipment[item.entityId].slot))
      .map(item => item.entityId)
    const free = equippable.filter(id => !slotOf(self, id))
    if (free.length) {
      operations.push('equip')
      targets.equip = free
    }
    const wornGear = equippable.filter(id => slotOf(self, id))
    if (wornGear.length) {
      operations.push('unequip')
      targets.unequip = wornGear
    }
    return { operations, targets }
  }

  function resolve(truth, actorId, operation, args, world, targetId) {
    const own = truth.characters[actorId]
    const reject = rejectReason => ({ rejectReason })
    if (operation === 'rest') {
      if (!canRest(world.locationId)) return reject('这里不能休息。')
      const changes = stats
        .filter(stat => own[statKey(stat.key)] < own[maxKey(stat.key)])
        .map(stat => ({ holderId: actorId, key: statKey(stat.key), value: own[maxKey(stat.key)] }))
      return { changes, reveals: [], description: '睡了一觉，精神恢复了。', audience: 'scene' }
    }
    const item = world.items.current.find(entry => entry.entityId === targetId)
    if (operation === 'use') {
      if (!config.consumables[targetId]) return reject('这件东西不能这样用。')
      if (!item || item.holderId !== actorId) return reject('你手里没有这件东西。')
      if (spent(item)) return reject('已经用完了。')
      const name = item.name || item.kind
      const restore = config.consumables[targetId].restore
      const changes = Object.keys(restore).map(key => ({
        holderId: actorId,
        key: statKey(key),
        value: Math.min(own[maxKey(key)], own[statKey(key)] + restore[key]),
      }))
      const effect = Object.keys(restore).map(key => statLabel(key) + '恢复了').join('，')
      return {
        changes,
        reveals: [],
        items: [{ entityId: targetId, kind: name + USED }],
        description: '使用了' + name + (effect ? '，' + effect : '') + '。',
        audience: 'scene',
      }
    }
    if (operation === 'equip') {
      const gear = config.equipment[targetId]
      if (!gear) return reject('这件东西不能装备。')
      if (!item || item.holderId !== actorId) return reject('你手里没有这件东西。')
      if (!slotsOf(actorId).includes(gear.slot)) return reject('你没有可以装备它的位置。')
      if (slotOf(own, targetId)) return reject('已经装备着了。')
      if (worn(own)[gear.slot]) return reject('这个位置已经装备了别的东西，需要先卸下。')
      return {
        changes: [{ holderId: actorId, key: 'rpg-equipment', value: { ...worn(own), [gear.slot]: targetId } }],
        reveals: [],
        description: '装备了' + (item.name || item.kind) + '。',
        audience: 'scene',
      }
    }
    if (operation === 'unequip') {
      const slot = slotOf(own, targetId)
      if (!slot) return reject('并没有装备着它。')
      const next = { ...worn(own) }
      delete next[slot]
      return {
        changes: [{ holderId: actorId, key: 'rpg-equipment', value: next }],
        reveals: [],
        description: '卸下了' + (item ? item.name || item.kind : '装备') + '。',
        audience: 'scene',
      }
    }
    return reject('没有这个操作。')
  }

  globalThis.packPlugin = { definition: { statuses, actions }, initialize, policy, resolve }
}
