// 突发心动事件 3：雨夜停电的黑暗陪伴（autoStart 自动触发）。
// 全屋供电关闭且玩家所在房间有至少一位少女时触发一次；陪伴不代替合闸。
const HEROINES = ['character:gpt', 'character:claude', 'character:deepseek']
const NAMES = {
  'character:gpt': 'GPT',
  'character:claude': 'Claude',
  'character:deepseek': 'DeepSeek',
}
const none = { type: 'object', additionalProperties: false, properties: {} }

globalThis.activityScript = {
  definition: {
    title: '雨夜停电的黑暗陪伴',
    opening: '窗外暴雨倾盆，突如其来的停电让房间陷入一片幽暗，耳边能清晰听见彼此骤然贴近的呼吸声。',
    participants: {
      mode: 'player-select',
      min: 1,
      max: 3,
      candidates: HEROINES,
    },
    operations: [
      {
        id: 'stay-close',
        label: '在黑暗中伸出手，稳稳握住身边人的手给她安全感',
        requiresTurn: false,
        schema: none,
      },
      {
        id: 'candle-gather',
        label: '点起应急烛光，温柔安抚房间里的大家',
        requiresTurn: false,
        schema: none,
      },
    ],
  },
  autoStart(truth, world, previous) {
    const present = world.characterIds.filter(id => HEROINES.includes(id))
    return {
      when: [
        previous === null,
        truth?.public?.['power-on'] === false,
        present.length >= 1,
      ],
      npcIds: present.length ? present : ['character:claude'],
      notice:
        '轰隆一声闷雷滚过天际，房间里一片漆黑。黑暗中似乎有人轻轻抓住了你的衣袖……',
    }
  },
  initialize({ playerId, npcIds }) {
    return {
      active: true,
      phase: 'darkness',
      turn: npcIds[0],
      round: 1,
      public: {
        phaseLabel: '雨夜停电中',
        statusText: '黑暗拉近了彼此的距离',
        在场陪伴: npcIds.map(id => NAMES[id] ?? id).join('、'),
        objective:
          '突如其来的雨夜停电让平时矜持的少女也流露出一丝不安。你在第一时间陪在了她们身边！',
        lastResult: '窗外雨声淅沥，黑暗中传来衣料摩擦的细微声响。',
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
      operations: isPlayer && view.game.active ? ['stay-close', 'candle-gather'] : [],
    }
  },
  resolve(state, actorId, operation) {
    const game = JSON.parse(JSON.stringify(state.game))
    const npcIds = state.participants.slice(1)
    if (actorId !== state.participants[0]) return { rejectReason: '由屋主做出行动。' }
    game.active = false
    game.phase = 'finished'
    game.turn = null
    game.round += 1

    const changes = npcIds.map(id => ({
      holderId: id,
      key: 'mood-note',
      value:
        operation === 'stay-close'
          ? '雨夜停电时屋主主动陪伴并伸出手，紧张中感到一些安心'
          : '雨夜停电时屋主点起微光陪大家说话，这份照顾令人留意',
    }))
    const reveals = npcIds.map(id => ({ observerId: id, holderId: id, key: 'mood-note' }))

    if (operation === 'stay-close') {
      game.public.statusText = '黑暗中紧扣的十指'
      game.public.lastResult = '你在黑暗中准确地握住了她的手，掌心的温度让她的颤抖渐渐平息下来。'
      return {
        game,
        description: '在漆黑的雨夜里，屋主主动伸手揽住并紧握住身边少女微凉的手指，轻声给她安全感。',
        audience: 'participants',
        status: { changes, reveals },
      }
    }

    if (operation === 'candle-gather') {
      game.public.statusText = '摇曳烛光下的依偎'
      game.public.lastResult = '微弱而温暖的光亮映照出少女泛红的脸颊，大家挨着你坐在一起。'
      return {
        game,
        description: '屋主点亮微光并温柔地安抚在场的每一个人，雨夜的房间变得格外温馨。',
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
