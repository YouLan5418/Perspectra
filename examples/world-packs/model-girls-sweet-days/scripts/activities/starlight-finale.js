// 终极心意确认与后宫坦白局：星海下的屋檐约定。
// 投影仪在当前房间实际运行时触发。全员告白要求三人参与及玩家持有套票，单推要求仅邀请一人。
// 作者的心动印象引导回应方向；说过话或跳过回应不等于接受恋爱关系。
const HEROINES = ['character:gpt', 'character:claude', 'character:deepseek']
const NAMES = {
  'character:gpt': 'GPT',
  'character:claude': 'Claude',
  'character:deepseek': 'DeepSeek',
}
const none = { type: 'object', additionalProperties: false, properties: {} }
const hasPasses = (world, playerId) => world.items.current.some(item => item.entityId === 'entity:family-passes' && item.holderId === playerId && !item.kind.startsWith('【商店货架'))
// 只认放在当前房间、正在运行的投影仪；有人拿在手里时不算星空房间。
const starsHere = world =>
  world.items.current.some(
    item =>
      item.entityId === 'entity:star-projector' &&
      item.holderId == null &&
      item.locationId === world.locationId &&
      item.kind.startsWith('正在旋转的家用星空投影仪'),
  )

const advanceTurn = (game, participants) => {
  const remaining = participants.slice(1).filter(id => !game.public.done.includes(id))
  game.turn = remaining[0] ?? participants[0]
  game.public.轮到回应 = remaining[0] ? NAMES[remaining[0]] : '屋主收尾定格此刻'
}

globalThis.activityScript = {
  definition: {
    title: '星海下的屋檐约定',
    opening:
      '漫天星光在屋顶流转，试运行周迎来了最关键的心意确认时刻。少女们的目光都聚焦在你身上，等待你的答案。',
    participants: {
      mode: 'player-select',
      min: 1,
      max: 3,
      candidates: HEROINES,
    },
    operations: [
      {
        id: 'declare-harem',
        label: '拿出全员心意：「我谁都不想放手，以后这个家我们四个永远在一起！」（真·后宫路线）',
        requiresTurn: false,
        schema: none,
      },
      {
        id: 'declare-solo',
        label: '牵起眼前之人的手，许下只属于你们两人的专属恋人约定（纯爱单推路线）',
        requiresTurn: false,
        schema: none,
      },
      {
        id: 'next-girl',
        label: '让她稍后再说，先听下一位（不视为同意）',
        requiresTurn: false,
        schema: none,
      },
      {
        id: 'finish-promise',
        label: '结束星空下的心意交谈，继续一起生活',
        requiresTurn: false,
        schema: none,
      },
      { id: 'leave', label: '先收起告白，改天再聊', requiresTurn: false, schema: none },
    ],
  },
  autoStart(truth, world, previous) {
    const present = world.characterIds.filter(id => HEROINES.includes(id))
    return {
      when: [
        previous === null,
        truth?.public?.['power-on'] === true,
        ['傍晚', '深夜'].includes(truth?.public?.slot),
        starsHere(world),
        present.length === 1 || present.length === 3,
      ],
      npcIds: present.length ? present : ['character:gpt'],
      notice:
        '璀璨的星空投影洒满房间，少女们停下交谈，眼神闪亮又紧张地望向你——是时候揭晓周末的最终约定了！',
    }
  },
  initialize({ playerId, npcIds, world }) {
    const hasFamilyPasses = hasPasses(world, playerId)
    const hasAquarium = Boolean(
      world.items?.current?.find(item => item.entityId === 'entity:aquarium-ticket'),
    )
    return {
      active: true,
      phase: 'choice',
      turn: playerId,
      round: 1,
      public: {
        phaseLabel: '心意抉择',
        statusText: '等待屋主宣布最终心意',
        在场少女: npcIds.map(id => NAMES[id] ?? id).join('、'),
        持有信物: hasFamilyPasses
          ? '游乐园四人家庭套票（玩家持有）'
          : hasAquarium
            ? '双人水族馆夜场券'
            : '未持有告白信物',
        全员信物: hasFamilyPasses,
        轮到回应: '屋主先表态',
        objective:
          '全员告白需要邀请三人并持有家庭套票；专属告白只邀请一人。在傍晚或深夜点亮星空，把心意说清楚，也听听她们想怎样继续相处。',
        lastResult: '星光柔和地映照着每个人的侧脸。',
        done: [],
        skipped: [],
      },
      private: Object.fromEntries([playerId, ...npcIds].map(id => [id, {}])),
      internal: {},
    }
  },
  policy(view, actorId) {
    const isPlayer = actorId === view.participants[0]
    const phase = view.game.phase
    let ops = []
    if (isPlayer && view.game.active) {
      if (phase === 'choice') {
        ops = view.participants.length === 2 ? ['declare-solo'] : view.participants.length === 4 && view.game.public.全员信物 ? ['declare-harem'] : []
      } else if (phase === 'responses') {
        ops = view.game.turn === actorId ? ['finish-promise'] : ['next-girl']
      }
    }
    return {
      speech: 'free',
      speechChoices: [],
      narration: true,
      move: false,
      interactions: ['base:hold-hand', 'base:end-contact'],
      operations: isPlayer && view.game.active ? [...ops, 'leave'] : [],
    }
  },
  resolve(state, actorId, operation, _parameters, world, truth) {
    const game = JSON.parse(JSON.stringify(state.game))
    const playerId = state.participants[0]
    const npcIds = state.participants.slice(1)
    if (actorId !== playerId) return { rejectReason: '该操作由屋主执行。' }

    const hasFamilyPasses = hasPasses(world, playerId)
    if (operation === 'leave') {
      game.active = false
      game.phase = 'finished'
      game.turn = null
      game.public.statusText = '暂缓告白'
      game.public.lastResult = '先把这份心意放在心里，改天再聊。'
      game.round += 1
      return { game, description: game.public.lastResult, audience: 'participants' }
    }
    if (['declare-harem', 'declare-solo'].includes(operation)) {
      if (game.phase !== 'choice') return { rejectReason: '心意已经表达过了，先听听她们的回应。' }
      if (!truth?.public?.['power-on'] || !['傍晚', '深夜'].includes(truth.public.slot) || !starsHere(world)) return { rejectReason: '需要在傍晚或深夜，在供电正常、投影仪运行的房间里告白。' }
    }

    if (operation === 'declare-harem') {
      if (npcIds.length !== 3 || !hasFamilyPasses) return { rejectReason: '全员告白需要三位少女都参与，并由屋主持有四人家庭套票。' }
      game.phase = 'responses'
      game.round += 1
      game.public.phaseLabel = '真·后宫坦白局'
      game.public.statusText = '屋主发起了全员同居告白！'
      game.public.lastResult = '你亮出了打工攒钱买下的「游乐园四人家庭套票」，向她们坦诚：无论是 GPT 的计划、Claude 的红茶还是 DeepSeek 的笑脸，你一个都不想放手！'
      advanceTurn(game, state.participants)
      const changes = npcIds.map(id => ({
        holderId: id,
        key: 'mood-note',
        value: '屋主拿出四人套票坦诚想和大家在一起，感受到屋主不愿冷落任何人的心意，对共同生活多了些期待，也有想确认的顾虑',
      }))
      const reveals = npcIds.map(id => ({ observerId: id, holderId: id, key: 'mood-note' }))
      return {
        game,
        description: game.public.lastResult,
        audience: 'participants',
        status: { changes, reveals },
      }
    }

    if (operation === 'declare-solo') {
      if (npcIds.length !== 1) return { rejectReason: '专属告白请只邀请一位少女；不会自动替你选择名单中的第一人。' }
      game.phase = 'responses'
      game.round += 1
      const targetName = NAMES[npcIds[0]] ?? npcIds[0]
      game.public.phaseLabel = '专属纯爱告白'
      game.public.statusText = '屋主向 ' + targetName + ' 许下了专属约定'
      game.public.lastResult = '在漫天星光下，你郑重地向 ' + targetName + ' 传达了独一无二的心意。'
      advanceTurn(game, state.participants)
      const changes = [
        {
          holderId: npcIds[0],
          key: 'mood-note',
          value: '在漫天星海下听到屋主专属的告白，心里有所触动，想结合自己的经历认真回应',
        },
      ]
      const reveals = [{ observerId: npcIds[0], holderId: npcIds[0], key: 'mood-note' }]
      return {
        game,
        description: game.public.lastResult,
        audience: 'participants',
        status: { changes, reveals },
      }
    }

    if (operation === 'next-girl' && game.phase === 'responses' && game.turn !== playerId) {
      game.public.lastResult = '暂时留给 ' + (NAMES[game.turn] ?? game.turn) + ' 更多考虑的时间；这不代表她接受了告白。'
      game.public.skipped.push(game.turn)
      game.public.done.push(game.turn)
      advanceTurn(game, state.participants)
      game.round += 1
      return { game, description: game.public.lastResult, audience: 'participants' }
    }

    if (operation === 'finish-promise') {
      if (game.phase !== 'responses' || game.turn !== playerId || npcIds.some(id => !game.public.done.includes(id))) return { rejectReason: '还有人尚未回应；可以等她开口，或明确留到稍后再聊。' }
      game.active = false
      game.phase = 'finished'
      game.turn = null
      game.round += 1
      game.public.statusText = '星空下的心意交谈结束'
      game.public.轮到回应 = ''
      game.public.lastResult =
        '星光下的话题暂告一段落；彼此的回应与尚待回答的问题会留在之后的相处里。可以保存节点，或继续自由过日子。'
      return {
        game,
        description: '星空下的话题暂告一段落，彼此已经说出的回应与尚待回答的问题会留在之后的相处里。',
        audience: 'participants',
      }
    }

    return { rejectReason: '当前不能执行此操作。' }
  },
  schedule(view) {
    return view.game.active && view.game.phase === 'responses' && view.game.turn !== view.participants[0]
      ? { kind: 'activate', characterId: view.game.turn }
      : { kind: 'wait' }
  },
  onOutcome(result, view) {
    return result.status !== 'abstained' &&
      result.failure === undefined &&
      view.game.active &&
      view.game.phase === 'responses' &&
      view.game.turn !== view.participants[0]
      ? { kind: 'activate', characterId: view.game.turn }
      : { kind: 'wait' }
  },
  onPublished(state, actorId) {
    const game = JSON.parse(JSON.stringify(state.game))
    if (game.phase !== 'responses' || actorId !== game.turn || actorId === state.participants[0]) {
      return null
    }
    game.public.done.push(actorId)
    advanceTurn(game, state.participants)
    return game
  },
}
