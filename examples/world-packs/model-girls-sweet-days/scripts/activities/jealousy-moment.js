// 突发修罗场事件 4：微妙的醋意视线（autoStart 自动触发）。
// status.js 只给亲历这次送礼的少女记录 gift-scene，不把房间气氛广播给场外角色。
// 并在回合结束时自动拉起本修罗场事件，考验玩家的端水与救场操作！
const HEROINES = ['character:gpt', 'character:claude', 'character:deepseek']
const NAMES = {
  'character:gpt': 'GPT',
  'character:claude': 'Claude',
  'character:deepseek': 'DeepSeek',
}
const none = { type: 'object', additionalProperties: false, properties: {} }

globalThis.activityScript = {
  definition: {
    title: '修罗场：微妙的醋意视线',
    opening:
      '你刚当众送出那份专属心意，房间里的空气忽然安静了一瞬——旁边投来了幽怨又带着点小刺的视线！',
    participants: {
      mode: 'player-select',
      min: 2,
      max: 3,
      candidates: HEROINES,
    },
    operations: [
      {
        id: 'smooth-water',
        label: '展现端水艺术：「每个人都有专属惊喜，怎么可能忘了你？」',
        requiresTurn: false,
        schema: none,
      },
      {
        id: 'group-hug',
        label: '干脆张开双手把在场的人都拉近：「在我心里你们一样重要！」',
        requiresTurn: false,
        schema: none,
      },
    ],
  },
  autoStart(truth, world) {
    const present = world.characterIds.filter(id => HEROINES.includes(id) && truth?.characters?.[id]?.['gift-scene'] === world.locationId)
    return {
      when: [
        present.length >= 2,
      ],
      npcIds: present.length >= 2 ? present : ['character:gpt', 'character:deepseek'],
      notice:
        '「咳咳……屋主，你刚才是不是偏心了一点？」房间里同时在场的少女们视线交汇，空气中飘起了微妙的醋味！',
    }
  },
  initialize({ playerId, npcIds }) {
    return {
      active: true,
      phase: 'jealousy',
      turn: npcIds[0],
      round: 1,
      public: {
        phaseLabel: '醋意修罗场',
        statusText: '少女们正在盯着你看你如何解释',
        在场角色: npcIds.map(id => NAMES[id] ?? id).join('、'),
        objective:
          '当面偏心送礼引发了小小的吃醋修罗场！你可以用语言和下面的救场行动安抚大家，把吃醋变成全员心动的契机。',
        lastResult: '收到礼物的人有些暗喜又有些不好意思，旁观的人则抱起手臂等着你的说法。',
      },
      private: Object.fromEntries([playerId, ...npcIds].map(id => [id, {}])),
      internal: {},
    }
  },
  policy(view, actorId) {
    const isPlayer = actorId === view.participants[0]
    return {
      speech: 'free',
      speechChoices: [],
      narration: true,
      move: false,
      interactions: ['base:hold-hand', 'base:end-contact'],
      operations: isPlayer && view.game.active ? ['smooth-water', 'group-hug'] : [],
    }
  },
  resolve(state, actorId, operation) {
    const game = JSON.parse(JSON.stringify(state.game))
    const npcIds = state.participants.slice(1)
    if (actorId !== state.participants[0]) return { rejectReason: '由屋主来救场回应。' }
    game.active = false
    game.phase = 'finished'
    game.turn = null
    game.round += 1

    const changes = [
      ...npcIds.map(id => ({ holderId: id, key: 'gift-scene', value: '' })),
      ...npcIds.map(id => ({
        holderId: id,
        key: 'mood-note',
        value:
          operation === 'group-hug'
            ? '屋主坦率地表达对大家的在意，心里的小别扭缓和了一些，仍留意之后会怎样相处'
            : '听见屋主承诺每个人都有专属惊喜，心情稍有缓和，也想看看屋主会怎样兑现',
      })),
    ]
    const reveals = npcIds.flatMap(id => ['mood-note', 'gift-scene'].map(key => ({ observerId: id, holderId: id, key })))

    if (operation === 'smooth-water') {
      game.public.statusText = '许下专属补偿'
      game.public.lastResult = '你向每个人许下专属补偿；承诺要如何兑现，还要看后续的相处。'
      return {
        game,
        description: '屋主从容不迫地安抚了在场的每一位少女，认真承诺每个人都有属于自己的特别心意。',
        audience: 'participants',
        status: { changes, reveals },
      }
    }

    if (operation === 'group-hug') {
      game.public.statusText = '屋檐下的欢喜同盟'
      game.public.lastResult = '你大方地牵起她们的手，让少女们红着脸在笑闹中达成了微妙的默契。'
      return {
        game,
        description: '屋主不再掩饰对大家的喜爱，大方拉近了在场所有少女的距离，让醋意变成了欢喜冤家的打闹。',
        audience: 'participants',
        status: { changes, reveals },
      }
    }

    return { rejectReason: '未知操作。' }
  },
  schedule(view) {
    return view.game.active && view.game.turn !== view.participants[0]
      ? { kind: 'activate', characterId: view.game.turn }
      : { kind: 'wait' }
  },
  onOutcome() {
    return { kind: 'wait' }
  },
  onPublished(state, actorId) {
    const game = JSON.parse(JSON.stringify(state.game))
    if (actorId !== state.participants[0] && game.active) {
      game.turn = state.participants[0]
      return game
    }
    return null
  },
}
