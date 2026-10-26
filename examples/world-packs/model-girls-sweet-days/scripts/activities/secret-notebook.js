// 突发心动事件 2：小龙娘的秘密约会笔记（autoStart 自动触发）。
// 玩家拿着 entity:gpt-notebook，且同一房间里只有玩家和 GPT 两人时自动触发；不限房间。
const none = { type: 'object', additionalProperties: false, properties: {} }

globalThis.activityScript = {
  definition: {
    title: '小龙娘的秘密约会笔记',
    opening:
      'GPT 一眼看见你手里正拿着她忘在书房的硬壳笔记本，夹层里那页《屋主喜好与完美约会 108 条》刚好露了出来——她头顶的小龙角瞬间红到了尖端！',
    npcIds: ['character:gpt'],
    operations: [
      {
        id: 'practice-date',
        label: '指着笔记第 1 条：「既然写了计划表，现在就先跟我预演一遍吧」',
        requiresTurn: false,
        schema: none,
      },
      {
        id: 'keep-secret',
        label: '把笔记轻轻合上：「我会替你保密，也会认真考虑这些心愿」',
        requiresTurn: false,
        schema: none,
      },
    ],
  },
  autoStart(_truth, world, previous) {
    const notebook = world.items?.current?.find(item => item.entityId === 'entity:gpt-notebook')
    return {
      when: [
        previous === null,
        // 只有玩家与 GPT 独处时才曝光，有第三人在场时她不会当众追问。
        world.characterIds.length === 2,
        world.characterIds.includes('character:gpt'),
        notebook?.holderId === 'character:player',
      ],
      notice:
        '「等、等等！那本笔记不能看——！」GPT 撞见你手里的硬壳笔记本，连身后的龙尾都慌张地卷了起来！',
    }
  },
  initialize({ playerId }) {
    return {
      active: true,
      phase: 'flustered',
      turn: 'character:gpt',
      round: 1,
      public: {
        phaseLabel: '秘密笔记曝光',
        statusText: 'GPT 羞得耳根通红，正试图解释那是「学术调研」',
        objective:
          '你发现了 GPT 私下偷偷整理的《屋主喜好与完美约会 108 条》。看看慌乱的小龙娘会怎么嘴硬，再决定如何回应她的心意。',
        lastResult: '那页手写笔记上密密麻麻记着你爱喝的茶温、散步的步速和牵手的时机。',
      },
      private: {
        [playerId]: {},
        'character:gpt': {},
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
      operations: isPlayer && view.game.active ? ['practice-date', 'keep-secret'] : [],
    }
  },
  resolve(state, actorId, operation) {
    const game = JSON.parse(JSON.stringify(state.game))
    if (actorId !== state.participants[0]) return { rejectReason: '由屋主做出回应。' }
    game.active = false
    game.phase = 'finished'
    game.turn = null
    game.round += 1

    if (operation === 'practice-date') {
      game.public.statusText = '两个人的约会预演'
      game.public.lastResult = '你顺着她笔记上的第一条主动靠近半步，小龙娘害羞得尾巴轻轻缠住了你的手腕。'
      return {
        game,
        description:
          '屋主笑着按《完美约会 108 条》的第一项，趁着只有两个人，和 GPT 进行了一场近距离的「约会预演」。',
        audience: 'participants',
        status: {
          changes: [
            {
              holderId: 'character:gpt',
              key: 'mood-note',
              value: '屋主发现了秘密笔记并愿意预演约会，羞怯中对接下来的相处多了些期待',
            },
          ],
          reveals: [{ observerId: 'character:gpt', holderId: 'character:gpt', key: 'mood-note' }],
        },
      }
    }

    if (operation === 'keep-secret') {
      game.public.statusText = '珍藏的专属约定'
      game.public.lastResult = '你合上手里的笔记，承诺保密并认真考虑她的心愿。笔记仍由你拿着，可以稍后正式交还。'
      return {
        game,
        description: '屋主合上手里的笔记本，答应替 GPT 保密并认真考虑她的心愿；笔记尚未交还。',
        audience: 'participants',
        status: {
          changes: [
            {
              holderId: 'character:gpt',
              key: 'mood-note',
              value: '屋主答应守护秘密并认真考虑心愿，这份体贴让自己稍微放松了一些',
            },
          ],
          reveals: [{ observerId: 'character:gpt', holderId: 'character:gpt', key: 'mood-note' }],
        },
      }
    }

    return { rejectReason: '未知操作。' }
  },
  schedule(view) {
    return view.game.active && view.game.turn === 'character:gpt'
      ? { kind: 'activate', characterId: 'character:gpt' }
      : { kind: 'wait' }
  },
  onOutcome() {
    return { kind: 'wait' }
  },
  onPublished(state, actorId) {
    const game = JSON.parse(JSON.stringify(state.game))
    if (actorId === 'character:gpt' && game.active) {
      game.turn = state.participants[0]
      return game
    }
    return null
  },
}
