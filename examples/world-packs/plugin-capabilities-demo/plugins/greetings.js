const empty = { type: 'object', additionalProperties: false, properties: {} }
globalThis.packPlugin = {
  definition: {
    statuses: [
      { key: 'greetings-count', label: '本人已确认次数', type: 'number', owner: 'character', bar: true },
      { key: 'greetings-enabled', label: '设备可用', type: 'boolean', owner: 'public', alwaysKnown: true },
    ],
    actions: [
      { id: 'confirm', label: '请求设备确认', schema: empty, capability: 'demo-device', method: 'confirm' },
      { id: 'queue', label: '排队请求设备', schema: empty, capability: 'demo-device', method: 'queue' },
      { id: 'toggle', label: '切换设备可用状态', actors: 'player', schema: empty },
    ],
  },
  initialize(ids) {
    return { public: { 'greetings-enabled': true }, characters: Object.fromEntries(ids.map(id => [id, { 'greetings-count': 0 }])) }
  },
  policy(view, actorId) {
    return { operations: [...(view.public['greetings-enabled'] ? ['confirm', 'queue'] : []), ...(actorId === 'character:player' ? ['toggle'] : [])] }
  },
  prepare(_view, _actorId, operation) { return { message: operation === 'queue' ? '排队招呼' : '你好' } },
  resolve(truth, actorId, operation, _args, _world, _target, result) {
    if (operation === 'toggle') return { changes: [{ holderId: null, key: 'greetings-enabled', value: !truth.public['greetings-enabled'] }], reveals: [], description: '设备可用状态已切换。', audience: 'scene' }
    // The host never calls this for a queued outcome; only actual confirmations can increment the counter.
    if (!result?.confirmed || result.actorId !== actorId) return { rejectReason: '设备没有确认这次请求。' }
    return { changes: [{ holderId: actorId, key: 'greetings-count', value: truth.characters[actorId]['greetings-count'] + 1 }],
      reveals: [], description: '设备已确认你的招呼，本人的确认次数增加一次。', audience: 'self' }
  },
}
