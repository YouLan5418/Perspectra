// @ts-check
/** @type {import('@harness-world/plugin-sdk').ContentGameplay} */
module.exports = {
  id: 'example-investigation', version: '1', dataVersion: 2, requiredServices: ['status'],
  configSchema: {
    type: 'object', properties: { energy: { type: 'integer', title: '初始精力', description: '每次搜查消耗 1 点精力。', minimum: 1, maximum: 20 } },
    required: ['energy'], additionalProperties: false,
  },
  states: [
    { key: 'search-enabled', label: '允许搜查', type: 'boolean', schema: { type: 'boolean' }, owner: 'character', alwaysKnown: true, playerTruth: true, bar: false },
    { key: 'energy', label: '精力', type: 'number', schema: { type: 'number', minimum: 0, multipleOf: 1 }, owner: 'character', alwaysKnown: true, playerTruth: true, bar: true },
    { key: 'clues', label: '线索', type: 'array', schema: { type: 'array', items: { type: 'string' } }, owner: 'character', alwaysKnown: false, playerTruth: false, bar: false },
  ],
  initializeState: ({ characterIds, config }) => ({
    public: {}, characters: Object.fromEntries(characterIds.map(id => [id, { energy: config.energy, clues: [], 'search-enabled': true }])),
  }),
  operations: [{
    id: 'investigation:search',
    argumentSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    resultSchema: {
      type: 'object', properties: { clue: { anyOf: [{ type: 'string' }, { type: 'null', nullable: true }] } },
      required: ['clue'], additionalProperties: false,
    },
    offer: ({ locationId }) => locationId ? [{ id: 'search:' + locationId, label: '搜查房间', targetId: locationId, parameters: {} }] : [],
    resolve: ({ actorId, state }) => {
      if (!state['search-enabled']) return { status: 'rejected', rejection: { code: 'SEARCH_PAUSED', message: '已暂停搜查，请在玩法设置中恢复。' } };
      if (Number(state.energy) <= 0)
        return { status: 'rejected', rejection: { code: 'INSUFFICIENT_ENERGY', message: '精力不足。' } };
      return {
        status: 'accepted', outcome: { clue: 'clue:letter' },
        effects: [{ kind: 'status', changes: [
          { holderId: actorId, key: 'energy', value: Number(state.energy) - 1 },
          { holderId: actorId, key: 'clues', value: ['clue:letter'] },
        ], reveals: [], description: '在房间里翻找。' }],
      };
    },
    npc: {
      whenToUse: '搜查所在房间，每次消耗 1 点精力；重复搜查仍消耗精力，线索不重复加入，精力为零时拒绝。',
      projectResult: input => input.recipientId === input.actorId ? input.outcome : { clue: null },
      formatResult: input => input.recipientId !== input.actorId ? '在房间里翻找。' : '发现线索：' + String(input.outcome.clue),
    },
    ui: { label: '搜查房间', group: '调查', targetKind: 'investigation-site' },
  }, {
    id: 'investigation:set-enabled',
    argumentSchema: { type: 'object', properties: { enabled: { type: 'boolean', title: '允许搜查' } }, required: ['enabled'], additionalProperties: false },
    resultSchema: { type: 'null', nullable: true },
    offer: ({ actorId }) => [{ id: 'enabled:' + actorId, label: '调整搜查方式', targetId: actorId, parameters: {} }],
    resolve: ({ actorId, parameters }) => ({
      status: 'accepted', outcome: null,
      effects: [{ kind: 'status', changes: [{ holderId: actorId, key: 'search-enabled', value: parameters.enabled }], reveals: [], description: parameters.enabled ? '恢复搜查。' : '暂停搜查。' }],
    }),
    npc: { whenToUse: '需要开始或暂停自己的搜查时使用。', formatResult: () => '已调整搜查方式。' },
    ui: { label: '调整搜查方式', group: '调查' },
  }],
  playerView: ({ state }) => ({
    panels: [
      { kind: 'property-table', id: 'resources', title: '调查状态', properties: [{ key: 'energy', label: '精力', value: state.energy ?? 0 }] },
      { kind: 'entry-list', id: 'clues', title: '我的线索', entries: (Array.isArray(state.clues) ? state.clues : []).map(id => ({ id: String(id), title: '一封信', content: '在房间里找到的信件。' })) },
    ],
    controls: [{
      kind: 'boolean', id: 'search-enabled', label: '允许搜查', value: state['search-enabled'] === true,
      description: '暂停后，搜查操作会被规则拒绝；不会消耗精力。',
      operation: { id: 'investigation:set-enabled', argument: 'enabled' },
    }],
  }),
};
