// 客厅日常小活动：复古红白机双人对战（可邀请 1~3 名在场少女一起玩或围观助威）。
const NAMES = {
  'character:gpt': 'GPT',
  'character:claude': 'Claude',
  'character:deepseek': 'DeepSeek',
}
const none = { type: 'object', additionalProperties: false, properties: {} }

globalThis.activityScript = {
  definition: {
    title: '红白机游戏对战',
    opening: '你打开客厅的复古双人游戏机，把另一只手柄递了出去。电视屏幕亮起像素风的音乐！',
    participants: {
      mode: 'player-select',
      min: 1,
      max: 3,
      candidates: ['character:gpt', 'character:claude', 'character:deepseek'],
    },
    operations: [
      { id: 'play-serious', label: '全神贯注认真操作（秀一波技术）', requiresTurn: false, schema: none },
      { id: 'play-throw', label: '不动声色故意放水（让她赢下这一局）', requiresTurn: false, schema: none },
      { id: 'play-tease', label: '趁她盯着屏幕紧张时，轻轻碰她的手背', requiresTurn: false, schema: none },
      { id: 'finish', label: '收起手柄，结束游戏时光', requiresTurn: false, schema: none },
    ],
  },
  initialize({ playerId, npcIds }) {
    return {
      active: true,
      phase: 'playing',
      turn: playerId,
      round: 1,
      public: {
        phaseLabel: '手柄激战中',
        statusText: '第 1 局进行中',
        对手与围观: npcIds.map(id => NAMES[id] ?? id).join('、'),
        objective:
          '正在客厅玩复古双人游戏机！可以选择认真操作、故意放水哄她开心，或者趁她专注时来一点亲密小动作。',
        lastResult: '游戏音乐响起，大家在沙发上挨着坐了下来。',
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
      operations: isPlayer && view.game.active ? ['play-serious', 'play-throw', 'play-tease', 'finish'] : [],
    }
  },
  resolve(state, actorId, operation) {
    const game = JSON.parse(JSON.stringify(state.game))
    const npcIds = state.participants.slice(1)
    if (actorId !== state.participants[0]) return { rejectReason: '由屋主选择本局操作。' }

    if (operation === 'finish') {
      game.active = false
      game.phase = 'finished'
      game.turn = null
      game.round += 1
      game.public.statusText = '游戏结束'
      game.public.lastResult = '大家意犹未尽地放下了手柄，沙发上的距离比刚才更近了。'
      // 收起手柄是日常收尾，不写心动印象；偷碰手背那一刻仍会写。
      return {
        game,
        description: '收起游戏手柄，结束了这一轮热闹的红白机对战。',
        audience: 'participants',
      }
    }

    const activeNpc = npcIds[(game.round - 1) % npcIds.length]
    game.turn = activeNpc
    game.round += 1
    if (operation === 'play-serious') {
      game.public.statusText = '屋主华丽连招获胜'
      game.public.lastResult = '你打出一套行云流水的操作拿下了这一小局！身旁的少女顿时不服气了。'
      return {
        game,
        description: '屋主全神贯注打出一波精彩连招，赢下了这一局！',
        audience: 'participants',
      }
    }
    if (operation === 'play-throw') {
      game.public.statusText = '少女绝地反杀获胜'
      game.public.lastResult = '你在最后关头故意卖了个破绽，让她险胜通关！'
      return {
        game,
        description: '屋主在关键时刻不动声色地放了水，让她拿下了本局胜利！',
        audience: 'participants',
      }
    }
    if (operation === 'play-tease') {
      game.public.statusText = '手柄上的心跳擦碰'
      game.public.lastResult = '趁她死死盯着屏幕狂按按键时，你的手指轻轻覆在了她的手背上。'
      const changes = [
        {
          holderId: activeNpc,
          key: 'mood-note',
          value: '打游戏时被屋主偷偷碰了手背，握着手柄的指尖都在发烫',
        },
      ]
      const reveals = [{ observerId: activeNpc, holderId: activeNpc, key: 'mood-note' }]
      return {
        game,
        description: '趁她紧张操作时，屋主温热的手指轻轻擦过并贴上了她握着手柄的手背。',
        audience: 'participants',
        status: { changes, reveals },
      }
    }
    return { rejectReason: '未知游戏操作。' }
  },
  schedule(view) {
    return view.game.active && view.game.turn !== view.participants[0]
      ? { kind: 'activate', characterId: view.game.turn }
      : { kind: 'wait' }
  },
  onOutcome(_result, view) {
    return view.game.active && view.game.turn !== view.participants[0]
      ? { kind: 'activate', characterId: view.game.turn }
      : { kind: 'wait' }
  },
  onPublished(state, actorId) {
    const game = JSON.parse(JSON.stringify(state.game))
    if (!game.active || actorId === state.participants[0]) return null
    game.turn = state.participants[0]
    return game
  },
}
