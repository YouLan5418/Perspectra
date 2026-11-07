// RPG 状态模块的运行时规则。生成器把本文件的原始字节与一行 install(<配置>) 拼成包模块脚本，
// 所以这里只能用不依赖 import/export 的普通脚本写法，并且只读取 install 收到的配置。
// oxlint-disable-next-line no-unused-vars -- called by the appended install(<config>) line
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
  const party = config.party
  const PARTY = 'rpg-party'
  if (party) {
    statuses.push({
      key: PARTY,
      label: '队伍',
      type: 'array',
      owner: 'public',
      schema: { type: 'array', maxItems: 16, items: { type: 'string', maxLength: 100 } },
    })
  }

  const actions = []
  if (config.rest) actions.push({ id: 'rest', label: config.rest.label, schema: noInput })
  if (consumables.length) actions.push({ id: 'use', label: '使用{item}', targets: consumables, schema: noInput })
  if (equipment.length) {
    actions.push({ id: 'equip', label: '装备{item}', targets: equipment, schema: noInput })
    actions.push({ id: 'unequip', label: '卸下{item}', targets: equipment, schema: noInput })
  }
  // Joining is always the joiner's own act: no parameter names anyone else, and the leader cannot join.
  if (party) {
    actions.push({ id: 'join', label: '加入队伍', schema: noInput })
    actions.push({ id: 'leave', label: '离开队伍', schema: noInput })
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
    return { public: party ? { [PARTY]: [] } : {}, characters: Object.fromEntries(ids.map(id => [id, own(id)])) }
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
      .filter(
        item => equipment.includes(item.entityId) && slotsOf(actorId).includes(config.equipment[item.entityId].slot),
      )
      .map(item => item.entityId)
    const free = equippable.filter(id => !slotOf(self, id))
    if (free.length) {
      operations.push('equip')
      targets.equip = free
    }
    // Whatever occupies a slot can be taken off, held or not; the host still needs the item within reach.
    const wornGear = equipment.filter(id => slotOf(self, id))
    if (wornGear.length) {
      operations.push('unequip')
      targets.unequip = wornGear
    }
    if (party && actorId !== party.leader) {
      const listed = (known.public[PARTY] || []).includes(actorId)
      operations.push(listed ? 'leave' : 'join')
    }
    return { operations, targets }
  }

  // In the party means listed and standing with the leader. The module drops anyone listed but elsewhere whenever
  // the leader or that member performs an RPG operation, so the list catches up with where people are.
  function staleMembers(truth, actorId, world) {
    if (!party) return []
    const listed = truth.public[PARTY] || []
    if (actorId === party.leader) return listed.filter(id => !world.characterIds.includes(id))
    return listed.includes(actorId) && !world.characterIds.includes(party.leader) ? [actorId] : []
  }
  function partyChange(list, world, actorId) {
    return {
      changes: [{ holderId: null, key: PARTY, value: list }],
      // Those present see the new list; anyone elsewhere keeps what they last saw.
      reveals: [...new Set([actorId].concat(world.characterIds))].map(observerId => ({
        observerId,
        holderId: null,
        key: PARTY,
      })),
    }
  }

  function resolve(truth, actorId, operation, args, world, targetId) {
    const stale = staleMembers(truth, actorId, world)
    const remaining = (truth.public[PARTY] || []).filter(id => !stale.includes(id))
    const result = operate(truth, actorId, operation, world, targetId, remaining)
    if (result.rejectReason || !stale.length || result.changes.some(change => change.key === PARTY)) return result
    const cleanup = partyChange(remaining, world, actorId)
    return {
      ...result,
      changes: result.changes.concat(cleanup.changes),
      reveals: result.reveals.concat(cleanup.reveals),
    }
  }

  function operate(truth, actorId, operation, world, targetId, members) {
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
      const effect = Object.keys(restore)
        .map(key => statLabel(key) + '恢复了')
        .join('，')
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
    if (party && operation === 'join') {
      if (actorId === party.leader) return reject('你就是队长。')
      if (!world.characterIds.includes(party.leader)) return reject('队长不在这里。')
      if (members.includes(actorId)) return reject('已经在队伍里了。')
      return { ...partyChange(members.concat(actorId), world, actorId), description: '加入了队伍。', audience: 'scene' }
    }
    if (party && operation === 'leave') {
      if (!(truth.public[PARTY] || []).includes(actorId)) return reject('你不在队伍里。')
      const rest = members.filter(id => id !== actorId)
      return { ...partyChange(rest, world, actorId), description: '离开了队伍。', audience: 'scene' }
    }
    return reject('没有这个操作。')
  }

  globalThis.packPlugin = { definition: { statuses, actions }, initialize, policy, resolve }
}
