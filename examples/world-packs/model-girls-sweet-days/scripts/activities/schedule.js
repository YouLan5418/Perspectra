// 日程白板与时段推进：玩家单人快捷活动。
// 提供一键推进时段；深夜休息由 status:sleep-next-day 按已知时段提供，避免失败后留下已开始的活动。
// 每次推进时段都会触发 autonomy.json，让三位少女在屋里自主走动或做事。
const SLOTS = ['清晨', '午后', '傍晚', '深夜']
const none = { type: 'object', additionalProperties: false, properties: {} }

const closed = game => {
  game.active = false
  game.phase = 'closed'
  game.turn = null
  game.round += 1
}

globalThis.activityScript = {
  definition: {
    title: '同居日程白板',
    npcIds: [],
    operations: [
      { id: 'next-slot', label: '推进到下一时段（大家各自忙一阵）', requiresTurn: true, quick: true, schema: none },
      { id: 'close', label: '合上日程表', requiresTurn: true, quick: false, schema: none },
    ],
  },
  initialize({ playerId }) {
    return {
      active: true,
      phase: 'board',
      turn: playerId,
      round: 1,
      public: {
        statusText: '查看或推进今日时段',
        objective: '可以让时间推进到下一时段（清晨→午后→傍晚→深夜），或者在深夜休息进入新的一天。',
        lastResult: '',
      },
      private: { [playerId]: {} },
      internal: {},
    }
  },
  policy(view) {
    return {
      speech: 'free',
      speechChoices: [],
      narration: true,
      move: true,
      interactions: [],
      operations: view.game.phase === 'board' ? ['next-slot', 'close'] : [],
    }
  },
  resolve(state, actorId, operation, _parameters, _world, truth) {
    const game = JSON.parse(JSON.stringify(state.game))
    if (operation === 'close') {
      closed(game)
      return { game, description: '', audience: 'self' }
    }
    const day = Number(truth?.public?.day ?? 1)
    const currentSlot = String(truth?.public?.slot ?? '清晨')
    const idx = SLOTS.indexOf(currentSlot)

    if (operation === 'next-slot') {
      if (currentSlot === '深夜') {
        closed(game)
        return {
          game,
          description: '现在已经是深夜了，可以选择「结束今天，休息迎接明天」来恢复精力。',
          audience: 'self',
        }
      }
      const nextSlot = SLOTS[Math.min(idx + 1, SLOTS.length - 1)]
      const isBlackout = day === 2 && nextSlot === '傍晚'
      const changes = [
        { holderId: null, key: 'slot', value: nextSlot },
        ...(isBlackout
          ? [{ holderId: null, key: 'power-on', value: false }]
          : []),
      ]
      closed(game)
      const narration = isBlackout
        ? '时间来到了第 ' +
          day +
          ' 天傍晚。窗外忽然雷雨交加，随着啪的一声轻响，整间屋子跳闸停电陷入了昏暗！'
        : '时间流逝，来到了第 ' + day + ' 天的' + nextSlot + '。屋檐下的少女们也各自忙起了手头的事。'
      return {
        game,
        description: '',
        audience: 'self',
        status: { changes, reveals: [] },
        playerExpression: { narration },
      }
    }

    return { rejectReason: '未知日程操作。' }
  },
  schedule() {
    return { kind: 'wait' }
  },
  onOutcome() {
    return { kind: 'wait' }
  },
}
