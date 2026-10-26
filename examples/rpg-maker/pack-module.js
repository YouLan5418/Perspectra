// Copy into a world pack as plugins/rpg-maker.js and register it in assetFiles.
const empty = { type: 'object', additionalProperties: false, properties: {} }
globalThis.packPlugin = {
  definition: {
    statuses: [{ key: 'rm-view', label: '本人最近确认的游戏视图', type: 'object', schema: { type: 'object' }, owner: 'character' }],
    actions: [
      { id: 'observe', label: '查看外部游戏', schema: empty, capability: 'rpg-maker', method: 'observe' },
      { id: 'event', label: '请求公共事件', schema: { type: 'object', additionalProperties: false, properties: { eventId: { type: 'integer', minimum: 1 } }, required: ['eventId'] }, capability: 'rpg-maker', method: 'queue-common-event' },
    ],
  },
  initialize(ids) { return { public: {}, characters: Object.fromEntries(ids.map(id => [id, { 'rm-view': {} }])) } },
  policy() { return { operations: ['observe', 'event'] } },
  prepare(_view, _actor, operation, args) { return operation === 'event' ? { eventId: args.eventId } : {} },
  resolve(_truth, actorId, operation, _args, _world, _target, result) {
    if (operation !== 'observe' || result?.engine !== 'RPG Maker MZ') return { rejectReason: '没有收到可确认的游戏视图。' }
    return { changes: [{ holderId: actorId, key: 'rm-view', value: result }], reveals: [], description: '已确认本人当前可见的外部游戏视图。', audience: 'self' }
  },
}
