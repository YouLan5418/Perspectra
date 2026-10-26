// 突发心动事件 1：深夜冰箱的偷吃共犯（autoStart 自动触发）。
// 当时段为「深夜」、玩家走进厨房且 DeepSeek 也在厨房时自动触发一次。
const none = { type: 'object', additionalProperties: false, properties: {} }

globalThis.activityScript = {
  definition: {
    title: '深夜冰箱的偷吃抓包',
    opening:
      '深夜的厨房只亮着冰箱门透出的一束微光。你推门进来，正好撞见 DeepSeek 踮着脚尖在翻找吃的，鲸鱼尾巴吓得啪嗒一下僵在了半空！',
    npcIds: ['character:deepseek'],
    operations: [
      { id: 'share-secret', label: '小声关上门：「见者有份，我们一人一半当共犯」', requiresTurn: false, schema: none },
      { id: 'warm-milk', label: '轻轻敲她脑门，帮她热一杯牛奶哄她去睡', requiresTurn: false, schema: none },
    ],
  },
  autoStart(truth, world, previous) {
    return {
      when: [
        previous === null,
        truth?.public?.slot === '深夜',
        world.locationId === 'location:kitchen',
        world.characterIds.includes('character:deepseek'),
      ],
      notice:
        '深夜的厨房里传来悉悉索索的动静——你推门一看，冰箱灯映出了一条慌张摆动的蓝色鲸鱼尾巴！',
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
      speech: 'free',
      speechChoices: [],
      narration: true,
      move: false,
      interactions: ['base:hold-hand', 'base:end-contact'],
      operations: isPlayer && view.game.active ? ['share-secret', 'warm-milk'] : [],
    }
  },
  resolve(state, actorId, operation) {
    const game = JSON.parse(JSON.stringify(state.game))
    if (actorId !== state.participants[0]) return { rejectReason: '由屋主做出选择。' }
    game.active = false
    game.phase = 'finished'
    game.turn = null
    game.round += 1

    if (operation === 'share-secret') {
      game.public.statusText = '达成「深夜偷吃共犯」契约'
      game.public.lastResult = '你们躲在昏暗的厨房里分吃了一小块夜宵點心，连呼吸都挨得极近。'
      return {
        game,
        description:
          '屋主悄悄掩上厨房门，和 DeepSeek 头碰头分吃了夜宵，并拉钩约定这是绝不告诉 GPT 和 Claude 的两人秘密。',
        audience: 'participants',
        status: {
          changes: [
            {
              holderId: 'character:deepseek',
              key: 'mood-note',
              value: '和屋主结成了「深夜厨房偷吃共犯」，每次对视都会心照不宣地害羞偷笑',
            },
          ],
          reveals: [{ observerId: 'character:deepseek', holderId: 'character:deepseek', key: 'mood-note' }],
        },
      }
    }

    if (operation === 'warm-milk') {
      game.public.statusText = '深夜的温牛奶与顺毛'
      game.public.lastResult = '你没收了生冷零食，取而代之递给她一杯温热的甜牛奶，顺手揉了揉她的发顶。'
      return {
        game,
        description: '屋主温柔地替 DeepSeek 热了一杯甜牛奶，擦掉她嘴角的饼干屑，哄她安心回房休息。',
        audience: 'participants',
        status: {
          changes: [
            {
              holderId: 'character:deepseek',
              key: 'mood-note',
              value: '深夜被屋主用温牛奶和摸头杀温柔投喂，变得格外黏人',
            },
          ],
          reveals: [{ observerId: 'character:deepseek', holderId: 'character:deepseek', key: 'mood-note' }],
        },
      }
    }

    return { rejectReason: '未知操作。' }
  },
  schedule(view) {
    return view.game.active && view.game.turn === 'character:deepseek'
      ? { kind: 'activate', characterId: 'character:deepseek' }
      : { kind: 'wait' }
  },
  onOutcome() {
    return { kind: 'wait' }
  },
  onPublished(state, actorId) {
    const game = JSON.parse(JSON.stringify(state.game))
    if (actorId === 'character:deepseek' && game.active) {
      game.turn = state.participants[0]
      return game
    }
    return null
  },
}
