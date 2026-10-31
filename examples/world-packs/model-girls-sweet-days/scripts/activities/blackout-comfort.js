// 突发心动事件 3：雨夜停电的黑暗陪伴（autoStart 自动触发）。
// 全屋供电关闭且玩家所在房间有至少一位少女时触发一次；陪伴不代替合闸。
const HEROINES = ['character:gpt', 'character:claude', 'character:deepseek']
const NAMES = {
  'character:gpt': 'GPT',
  'character:claude': 'Claude',
  'character:deepseek': 'DeepSeek',
}
const none = { type: 'object', additionalProperties: false, properties: {} }

// 每位参与者的固定演出发表后，再推进到下一位。
const advanceResponse = (game, participants) => {
  const next = participants.slice(1).find(id => !game.public.responded.includes(id))
  game.turn = next ?? null
  if (!next) {
    game.active = false
    game.phase = 'finished'
    game.public.statusText = '这段互动暂告一段落'
  }
}

const openingLines = {
  'character:gpt': '先别慌，我记得玄关有应急工具。大家都还好吗？',
  'character:claude': '雨声一下子变大了……没关系，我们先待在一起，慢慢想办法。',
  'character:deepseek': '突然好黑……你们都在吧？我能听见你们说话就放心了。',
}
const responseLines = {
  'stay-close': {
    'character:gpt': [
      '我、我没有害怕，只是在确认大家的位置。',
      '谢谢你在这里。等我们准备好了，再一起想办法恢复供电吧。',
    ],
    'character:claude': ['谢谢，你的声音让我安心了一些。', '我们不必急着摸黑行动。等大家准备好，再去玄关看看吧。'],
    'character:deepseek': [
      '我在这里！这次没有偷偷跑去找吃的哦。',
      '你再说句话吧。听到你的声音，雨好像也没那么吓人了。',
    ],
  },
  'candle-gather': {
    'character:gpt': ['有光就好，至少可以看清大家有没有受伤。', '接下来先别着急，我来和你一起想想怎么恢复供电。'],
    'character:claude': ['这点光正好，让人觉得安心。', '雨还在下。我们先陪彼此待一会儿，好吗？'],
    'character:deepseek': ['亮起来了！虽然只有一点点，但感觉好多了。', '等电恢复以后，我们还能在客厅一起玩游戏吗？'],
  },
}

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
      { id: 'end-response', label: '结束这段互动，继续生活', requiresTurn: false, schema: none },
      {
        id: 'stay-close',
        label: '在黑暗中伸出手，轻声安慰身边的人',
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
        ['还没发生过', previous === null],
        ['全屋停电', truth?.public?.['power-on'] === false],
        ['玩家身边至少有一位少女', present.length >= 1],
      ],
      npcIds: present.length ? present : ['character:claude'],
      notice: '轰隆一声闷雷滚过天际，房间里一片漆黑。黑暗中，大家一时停下了交谈。',
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
        objective: '突如其来的雨夜停电让平时矜持的少女也流露出一丝不安。你在第一时间陪在了她们身边！',
        lastResult: '窗外雨声淅沥，黑暗中传来衣料摩擦的细微声响。',
      },
      private: Object.fromEntries([playerId, ...npcIds].map(id => [id, {}])),
      internal: {},
    }
  },
  policy(view, actorId) {
    const isPlayer = actorId === view.participants[0]
    return {
      speech: isPlayer ? 'none' : 'free',
      speechChoices: [],
      narration: false,
      move: false,
      interactions: [],
      operations:
        isPlayer && view.game.active
          ? view.game.phase === 'responses'
            ? ['end-response']
            : view.game.turn === actorId
              ? ['stay-close', 'candle-gather']
              : []
          : [],
    }
  },
  resolve(state, actorId, operation) {
    const game = JSON.parse(JSON.stringify(state.game))
    const npcIds = state.participants.slice(1)
    if (actorId !== state.participants[0]) return { rejectReason: '由屋主做出行动。' }
    if (operation === 'end-response' && game.phase === 'responses') {
      game.active = false
      game.phase = 'finished'
      game.turn = null
      game.round += 1
      return { game, description: '这段互动暂告一段落。', audience: 'participants' }
    }
    if (game.phase === 'responses') return { rejectReason: '先听听大家的回应。' }
    game.phase = 'responses'
    game.public.responded = []
    game.public.choice = operation
    game.public.phaseLabel = '选择后的回应'
    game.public.objective = '剧情将根据你的选择继续演出。'
    advanceResponse(game, state.participants)
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
      game.public.lastResult = '你在黑暗中向身边的人伸出手，轻声说自己在这里。'
      return {
        game,
        description: '在漆黑的雨夜里，屋主向身边的人伸出手，轻声说自己在这里。',
        audience: 'participants',
        status: { changes, reveals },
      }
    }

    if (operation === 'candle-gather') {
      game.public.statusText = '摇曳烛光下的依偎'
      game.public.lastResult = '你点起应急烛光，开口安慰在场的人。'
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
  onOutcome(result, view) {
    return result.status !== 'abstained' &&
      result.failure === undefined &&
      view.game.active &&
      view.game.turn !== view.participants[0]
      ? { kind: 'activate', characterId: view.game.turn }
      : { kind: 'wait' }
  },
  simulate(request) {
    const game = request.context.activity?.game
    const actorId = request.context.character.characterId
    if (!game?.active || game.turn !== actorId) return { decision: 'abstain' }
    const line =
      game.phase === 'responses' ? responseLines[game.public.choice]?.[actorId]?.join('\n') : openingLines[actorId]
    if (!line) return { decision: 'abstain' }
    return { decision: 'publish', scope: 'scene_public', segments: [{ type: 'speech', text: line }] }
  },
  onPublished(state, actorId) {
    const game = JSON.parse(JSON.stringify(state.game))
    if (!game.active || actorId !== game.turn || actorId === state.participants[0]) return null
    if (game.phase === 'responses') {
      game.public.responded.push(actorId)
      advanceResponse(game, state.participants)
    } else {
      game.public.introDone = [...(game.public.introDone ?? []), actorId]
      game.turn = state.participants.slice(1).find(id => !game.public.introDone.includes(id)) ?? state.participants[0]
    }
    return game
  },
}
