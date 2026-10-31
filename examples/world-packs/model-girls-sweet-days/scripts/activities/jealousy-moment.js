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
  'character:gpt': '咳，我只是想确认一下，你的计划里是不是漏了什么人？',
  'character:claude': '看得出来你准备得很用心。只是，有人好像也在期待你的解释。',
  'character:deepseek': '我看到了哦！那我的份呢？我可以先排队！',
}
const responseLines = {
  'smooth-water': {
    'character:gpt': ['每个人都有？那我可要把你的承诺记进日程表了。', '不用急着现在兑现，不过你最好别忘记。'],
    'character:claude': [
      '我会期待的，不过不需要为了安抚我们而勉强自己。',
      '比起惊喜是什么，我更想知道你有没有认真想过。',
    ],
    'character:deepseek': ['真的吗？那我也有专属惊喜！', '我可以等，但如果是好吃的，记得不要等太久哦。'],
  },
  'group-hug': {
    'character:gpt': ['突然说这种话，也不提前打个招呼……', '我听到了。大家都重要，那以后也要好好分配时间。'],
    'character:claude': ['你这样坦率，倒是让人没办法继续追问了。', '不过，我会记住你说的话。以后我们慢慢相处吧。'],
    'character:deepseek': ['我也是重要的一份子，对吧？好，我听见啦！', '那以后有什么好玩的，也要记得叫上我和大家！'],
  },
}

globalThis.activityScript = {
  definition: {
    title: '修罗场：微妙的醋意视线',
    opening: '你刚当众送出那份专属心意，房间里的空气忽然安静了一瞬——旁边投来了幽怨又带着点小刺的视线！',
    participants: {
      mode: 'player-select',
      min: 2,
      max: 3,
      candidates: HEROINES,
    },
    operations: [
      { id: 'end-response', label: '结束这段互动，继续生活', requiresTurn: false, schema: none },
      {
        id: 'smooth-water',
        label: '展现端水艺术：「每个人都有专属惊喜，怎么可能忘了你？」',
        requiresTurn: false,
        schema: none,
      },
      {
        id: 'group-hug',
        label: '干脆张开双手，邀请在场的人靠近：「在我心里你们一样重要！」',
        requiresTurn: false,
        schema: none,
      },
    ],
  },
  autoStart(truth, world) {
    const present = world.characterIds.filter(
      id => HEROINES.includes(id) && truth?.characters?.[id]?.['gift-scene'] === world.locationId,
    )
    return {
      when: [['至少两位亲历送礼的少女在场', present.length >= 2]],
      npcIds: present.length >= 2 ? present : ['character:gpt', 'character:deepseek'],
      notice: '「咳咳……屋主，你刚才是不是偏心了一点？」房间里同时在场的少女们视线交汇，空气中飘起了微妙的醋味！',
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
              ? ['smooth-water', 'group-hug']
              : []
          : [],
    }
  },
  resolve(state, actorId, operation) {
    const game = JSON.parse(JSON.stringify(state.game))
    const npcIds = state.participants.slice(1)
    if (actorId !== state.participants[0]) return { rejectReason: '由屋主来救场回应。' }
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
    const reveals = npcIds.flatMap(id =>
      ['mood-note', 'gift-scene'].map(key => ({ observerId: id, holderId: id, key })),
    )

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
      game.public.lastResult = '你张开双手，坦率地说出大家对你都很重要。'
      return {
        game,
        description: '屋主张开双手，坦率地表达在场的人对自己都很重要。',
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
