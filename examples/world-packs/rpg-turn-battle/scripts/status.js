// Trusted author rules. Combat numbers have one source: status.updated.
const PLAYER = 'character:player'
const ALLY = 'character:companion'
const ENEMY = 'character:friend'
const empty = { type: 'object', additionalProperties: false, properties: {} }
globalThis.statusScript = {
  definition: {
    statuses: [
      ...['hp', 'mp'].map(key => ({ key, label: key === 'hp' ? '生命' : '魔力', type: 'number',
        schema: { type: 'number', multipleOf: 1, minimum: 0, maximum: 100 }, owner: 'character', activities: ['battle'], bar: true })),
      { key: 'gold', label: '金币', type: 'number', owner: 'character', activities: ['battle'], bar: true },
      { key: 'potions', label: '队伍药水', type: 'number', owner: 'public', alwaysKnown: true, activities: ['battle'], bar: true },
      { key: 'encounter', label: '遗迹进度', type: 'string', owner: 'public', alwaysKnown: true },
      { key: 'ally-model', label: '同伴由模型决策', type: 'boolean', owner: 'public', alwaysKnown: true },
    ],
    operations: [
      { id: 'enter-ruins', label: '进入遗迹迎战', actors: 'player', schema: empty },
      { id: 'ally-model', label: '让同伴使用真实模型决策', actors: 'player', schema: empty },
    ],
  },
  initialize(characterIds) {
    const stats = { [PLAYER]: { hp: 32, mp: 6, gold: 0 }, [ALLY]: { hp: 24, mp: 9, gold: 0 },
      [ENEMY]: { hp: 70, mp: 0, gold: 0 } }
    return { public: { potions: 2, encounter: 'camp', 'ally-model': false }, characters: stats,
      reveals: characterIds.flatMap(observerId => characterIds.flatMap(holderId =>
        ['hp', 'mp'].map(key => ({ observerId, holderId, key })))) }
  },
  policy(view) {
    return { operations: view.public.encounter === 'camp'
      ? ['enter-ruins', ...(view.public['ally-model'] ? [] : ['ally-model'])] : [] }
  },
  resolve(truth, actorId, operation) {
    if (actorId !== PLAYER || truth.public.encounter !== 'camp') return { rejectReason: '现在不能使用营地操作。' }
    const enter = operation === 'enter-ruins'
    if (!enter && operation !== 'ally-model') return { rejectReason: '没有这个营地操作。' }
    return { changes: [{ holderId: null, key: enter ? 'encounter' : 'ally-model', value: enter ? 'ready' : true }],
      reveals: [], description: enter ? '你与澄踏进遗迹门厅，守卫进入战斗。' : '接下来的战斗由同伴自己通过模型选择行动。', audience: 'scene' }
  },
}
