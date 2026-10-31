// 突发心动事件 1：深夜冰箱的偷吃共犯（autoStart 自动触发）。
// 当时段为「深夜」、玩家走进厨房且 DeepSeek 也在厨房时自动触发一次。
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

const openingLines = { 'character:deepseek': '啊……你怎么也醒了？我只是来看看冰箱有没有好好关上！' }
const responseLines = {
  'share-secret': {
    'character:deepseek': [
      '真的要一起？那你不能告发我哦。',
      '从现在开始，我们就是深夜厨房探险队！下次我会先问大家能不能吃。',
    ],
  },
  'warm-milk': {
    'character:deepseek': [
      '热牛奶？听起来好像比翻冰箱更让人安心。',
      '我再待一小会儿就去休息。你也别熬得太晚，好不好？',
    ],
  },
}

globalThis.activityScript = {
  definition: {
    title: '深夜冰箱的偷吃抓包',
    opening:
      '深夜的厨房只亮着冰箱门透出的一束微光。你推门进来，正好撞见 DeepSeek 踮着脚尖在翻找吃的，鲸鱼尾巴吓得啪嗒一下僵在了半空！',
    npcIds: ['character:deepseek'],
    operations: [
      { id: 'end-response', label: '结束这段互动，继续生活', requiresTurn: false, schema: none },
      { id: 'share-secret', label: '小声关上门：「见者有份，我们一人一半当共犯」', requiresTurn: false, schema: none },
      { id: 'warm-milk', label: '提议热一杯牛奶，关心她要不要休息', requiresTurn: false, schema: none },
    ],
  },
  autoStart(truth, world, previous) {
    return {
      when: [
        ['还没发生过', previous === null],
        ['时段是深夜', truth?.public?.slot === '深夜'],
        ['玩家在厨房', world.locationId === 'location:kitchen'],
        ['DeepSeek 在厨房', world.characterIds.includes('character:deepseek')],
      ],
      notice: '深夜的厨房里传来悉悉索索的动静——你推门一看，冰箱灯映出了一条慌张摆动的蓝色鲸鱼尾巴！',
    }
  },
  initialize({ playerId }) {
    return {
      active: true,
      phase: 'caught',
      turn: 'character:deepseek',
      round: 1,
      public: {
        phaseLabel: '深夜厨房抓包',
        statusText: 'DeepSeek 正心虚地看着你',
        objective:
          'DeepSeek 半夜溜进厨房找夜宵被你抓了个正着！听听她怎么狡辩，再决定是和她一起偷吃当共犯，还是温柔哄她去睡觉。',
        lastResult: '冰箱门的微光映着 DeepSeek 心虚又期待的脸庞。',
      },
      private: {
        [playerId]: {},
        'character:deepseek': {},
      },
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
              ? ['share-secret', 'warm-milk']
              : []
          : [],
    }
  },
  resolve(state, actorId, operation) {
    const game = JSON.parse(JSON.stringify(state.game))
    if (actorId !== state.participants[0]) return { rejectReason: '由屋主做出选择。' }
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

    if (operation === 'share-secret') {
      game.public.statusText = '达成「深夜偷吃共犯」契约'
      game.public.lastResult = '你压低声音，提议和 DeepSeek 分享夜宵，做一次偷吃共犯。'
      return {
        game,
        description: '屋主压低声音，提议和 DeepSeek 分享夜宵，当一次偷吃共犯。',
        audience: 'participants',
        status: {
          changes: [
            {
              holderId: 'character:deepseek',
              key: 'mood-note',
              value: '屋主提议一起分享夜宵，想听听 DeepSeek 的反应',
            },
          ],
          reveals: [{ observerId: 'character:deepseek', holderId: 'character:deepseek', key: 'mood-note' }],
        },
      }
    }

    if (operation === 'warm-milk') {
      game.public.statusText = '深夜的温牛奶与顺毛'
      game.public.lastResult = '你提议热一杯牛奶，看看 DeepSeek 愿不愿意休息。'
      return {
        game,
        description: '屋主提议热一杯牛奶，并关心 DeepSeek 是否愿意休息。',
        audience: 'participants',
        status: {
          changes: [
            {
              holderId: 'character:deepseek',
              key: 'mood-note',
              value: '深夜屋主提议热牛奶，并关心自己是否愿意休息',
            },
          ],
          reveals: [{ observerId: 'character:deepseek', holderId: 'character:deepseek', key: 'mood-note' }],
        },
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
