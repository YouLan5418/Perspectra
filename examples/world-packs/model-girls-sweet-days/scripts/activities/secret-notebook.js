// 突发心动事件 2：小龙娘的秘密约会笔记（autoStart 自动触发）。
// 玩家拿着 entity:gpt-notebook，且同一房间里只有玩家和 GPT 两人时自动触发；不限房间。
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

const openingLines = { 'character:gpt': '等、等一下！那只是我整理的生活调查资料……你已经看到哪一页了？' }
const responseLines = {
  'practice-date': {
    'character:gpt': [
      '现在就预演？我还没有把流程检查完……',
      '不过，如果只是先商量去哪里的话，我可以陪你一起想。别笑，我真的有认真准备！',
    ],
  },
  'keep-secret': {
    'character:gpt': [
      '你真的会保密吗？……谢谢。',
      '那些计划还没有定下来。等你愿意的时候，我们可以一起商量，再决定要不要做。',
    ],
  },
}

globalThis.activityScript = {
  definition: {
    title: '小龙娘的秘密约会笔记',
    opening:
      'GPT 一眼看见你手里正拿着原本放在自己卧室里的硬壳笔记本，夹层里那页《屋主喜好与完美约会 108 条》刚好露了出来——她头顶的小龙角瞬间红到了尖端！',
    npcIds: ['character:gpt'],
    operations: [
      { id: 'end-response', label: '结束这段互动，继续生活', requiresTurn: false, schema: none },
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
        ['还没发生过', previous === null],
        // 只有玩家与 GPT 独处时才曝光，有第三人在场时她不会当众追问。
        ['房间里只有两人', world.characterIds.length === 2],
        ['GPT 在场', world.characterIds.includes('character:gpt')],
        ['玩家拿着秘密笔记', notebook?.holderId === 'character:player'],
      ],
      notice: '「等、等等！那本笔记不能看——！」GPT 撞见你手里的硬壳笔记本，连身后的龙尾都慌张地卷了起来！',
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
              ? ['practice-date', 'keep-secret']
              : []
          : [],
    }
  },
  resolve(state, actorId, operation) {
    const game = JSON.parse(JSON.stringify(state.game))
    if (actorId !== state.participants[0]) return { rejectReason: '由屋主做出回应。' }
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

    if (operation === 'practice-date') {
      game.public.statusText = '两个人的约会预演'
      game.public.lastResult = '你指着笔记上的第一条，提议和 GPT 一起预演约会。'
      return {
        game,
        description: '屋主指着《完美约会 108 条》的第一项，提议和 GPT 一起预演约会。',
        audience: 'participants',
        status: {
          changes: [
            {
              holderId: 'character:gpt',
              key: 'mood-note',
              value: '屋主发现了秘密笔记并提议预演约会，想听听 GPT 的想法',
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
