globalThis.statusScript = {
  definition: {
    statuses: [
      { key: 'gold', label: '金币', type: 'number', owner: 'character', activities: ['battle'], bar: true },
      { key: 'encounter', label: '遗迹进度', type: 'string', owner: 'public', alwaysKnown: true },
    ],
    operations: [{ id: 'enter-ruins', label: '进入遗迹迎战', actors: 'player',
      schema: { type: 'object', additionalProperties: false, properties: {} } }],
  },
  initialize(characterIds) {
    return { public: { encounter: 'camp' }, characters: Object.fromEntries(characterIds.map(id => [id, { gold: 0 }])) }
  },
  policy(view) { return { operations: view.public.encounter === 'camp' ? ['enter-ruins'] : [] } },
  resolve(truth) {
    if (truth.public.encounter !== 'camp') return { rejectReason: '这次遭遇已经开始。' }
    return { changes: [{ holderId: null, key: 'encounter', value: 'ready' }], reveals: [],
      description: '你与澄踏进门厅，守卫与浮游机迎上来。', audience: 'scene' }
  },
}
