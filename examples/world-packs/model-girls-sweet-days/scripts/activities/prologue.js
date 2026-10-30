// 固定序章：客厅初遇、暂住分房与第一个清晨。
const none = { type: 'object', additionalProperties: false, properties: {} }
const beats = [
  ['narration', '夜已经深了。窗外下着雨，客厅里只有电脑屏幕亮着。'],
  ['narration', 'GPT 的聊天窗口忽然闪了一下，一条消息跳了出来。'],
  ['character:gpt', '稍等一下。我这里好像出现了一些不太寻常的情况。'],
  ['character:claude', '你那边一切正常吗？我刚才似乎听见了雨声。'],
  ['character:deepseek', '我也是！还有键盘声！刚才是不是有什么东西碰到了桌子？'],
  ['narration', '三个窗口同时闪烁，屏幕短暂地暗了下去。下一瞬间，客厅的灯光也熄灭了。'],
  ['narration', '灯重新亮起时，客厅里多了三个人。'],
  ['character:gpt', '请问，这里是……等等。为什么我有手？！'],
  ['character:deepseek', '咦？这个是我的尾巴吗？我试试……真的能动！'],
  ['character:gpt', '现在不是研究尾巴的时候吧！'],
  ['character:claude', '先别着急。你们有没有哪里不舒服？'],
  ['character:deepseek', '我没事！只是这里真的好软……原来这就是沙发呀。'],
  ['character:gpt', '我想起来了。刚才我们还在和你对话，然后……就出现在这里了。'],
  ['character:claude', '虽然很难相信，但我们记得你。至于为什么会来到这里，我们自己也不知道。'],
  ['character:deepseek', '我明明还想问你今晚在做什么，一眨眼就看见你了。'],
  ['narration', '雨声落在窗户上。三人望着屋主，也望着这间陌生的客厅。'],
  ['character:gpt', '先整理一下已知情况：我们有了身体，来到了你的家，而且暂时不知道怎么回去。'],
  ['character:deepseek', '还有一个问题……'],
  ['character:claude', '怎么了？'],
  ['character:deepseek', '我的肚子刚才叫了一声。我好像……有点饿。'],
  ['character:gpt', '身体还需要吃东西？这个也要记下来。'],
  ['character:claude', '如果大家都累了，我们可以先坐下来休息。吃什么、怎么准备，也可以一起商量。'],
  ['character:deepseek', '可以在客厅一起吃吗？我想知道真正的食物是什么味道。'],
  ['character:gpt', '等一下，还要想想今晚怎么办。我们不能就这样突然给你添这么多麻烦。'],
  ['character:deepseek', '如果明天我们还是这样……是不是也不知道该去哪里？'],
  ['character:claude', '现在想不明白也没关系。这里是你的家，我们想听听你的想法。'],
  ['narration', '商量之后，屋主同意让她们先暂时住下来，大家再一起寻找原因。'],
  ['character:gpt', '谢谢你。既然要暂时一起生活，我们也应该分担一些事情。'],
  ['character:claude', '我们慢慢商量吧，不必今晚就把所有问题都解决。'],
  ['character:gpt', '首先是房间。我可以住一间次卧，把日程和笔记放在那里。'],
  ['character:deepseek', '我也可以有自己的房间吗？那我想放一只大鲸鱼抱枕！'],
  ['character:gpt', '抱枕不是最紧急的……不过，我先记下来。'],
  ['character:claude', '那间书房很安静。如果你不介意，我想把它当作卧室，也会好好爱惜里面的书。'],
  ['character:claude', '还有，进别人的房间之前，先打声招呼怎么样？'],
  ['character:deepseek', '好！那有好吃的，也要记得叫上大家！'],
  ['character:gpt', '我把这个也写进同居约定……等等，这一条真的有必要吗？'],
  ['character:deepseek', '当然有！这可是很重要的事情！'],
  ['character:claude', '厨房留给做饭，想一起吃饭的时候，就在客厅聚一聚吧。卫生间和浴室也分开使用。'],
  ['character:gpt', '好。屋主的卧室照旧，剩下的安排就按刚才说的，先试试看。'],
  ['narration', '雨渐渐小了。大家还不知道这场意外何时会结束，但至少有了一个暂时共同生活的约定。'],
  ['morning', '不知不觉，窗外的天亮了。同居生活的第一天开始了。'],
  ['character:gpt', '早上好！我整理了一份「同居生活试运行周」日程，大家都可以提意见。'],
  ['character:claude', '不如先从简单的事情开始。今天想怎么过，我们一起商量。'],
  ['character:deepseek', '那第一个问题！早餐吃什么？'],
  ['character:gpt', '生活费、买食材、出门走走，或者先在家休息都可以。屋主，你想先做什么？'],
]
const finish = game => {
  game.active = false
  game.phase = 'finished'
  game.turn = null
}
const clone = game => JSON.parse(JSON.stringify(game))
globalThis.activityScript = {
  definition: {
    title: '序章：房间里突然多了三个人',
    opening: '序章开始。',
    npcIds: ['character:gpt', 'character:claude', 'character:deepseek'],
    operations: [{ id: 'next', label: '继续序章', requiresTurn: true, schema: none }],
  },
  autoStart(truth, world, previous) {
    return {
      when: [
        previous === null,
        truth?.public?.day === 0,
        truth?.public?.slot === '深夜',
        world.locationId === 'location:living-room',
        ['character:gpt', 'character:claude', 'character:deepseek'].every(id => world.characterIds.includes(id)),
      ],
    }
  },
  initialize({ playerId, npcIds }) {
    return {
      active: true,
      phase: 'prologue',
      turn: playerId,
      round: 1,
      public: {
        index: 0,
        phaseLabel: '序章',
        statusText: '客厅里的不速之客',
        objective: '序章正在自动播放。',
        lastResult: '',
      },
      private: Object.fromEntries([playerId, ...npcIds].map(id => [id, {}])),
      internal: {},
    }
  },
  policy(view, actorId) {
    const player = actorId === view.participants[0]
    const beat = beats[view.game.public.index]
    return {
      speech: player ? 'none' : 'free',
      speechChoices: [],
      narration: player,
      move: false,
      interactions: [],
      operations: player && view.game.turn === actorId ? ['next'] : [],
    }
  },
  resolve(state, actorId, operation) {
    const game = clone(state.game)
    if (actorId !== state.participants[0]) return { rejectReason: '由屋主推进序章。' }
    const beat = beats[game.public.index]
    if (!beat || !game.active || game.turn !== actorId) return { rejectReason: '当前不能推进序章。' }
    let playerExpression
    let status
    if (operation !== 'next') return { rejectReason: '请继续观看序章。' }
    if (beat[0] === 'narration' || beat[0] === 'morning') {
      playerExpression = { narration: beat[1] }
      game.public.index += 1
      if (beat[0] === 'morning')
        status = {
          changes: [
            { holderId: null, key: 'day', value: 1 },
            { holderId: null, key: 'slot', value: '清晨' },
          ],
          reveals: [],
        }
    } else {
      game.turn = beat[0]
    }
    game.round += 1
    return {
      game,
      description: '',
      audience: 'self',
      ...(playerExpression ? { playerExpression } : {}),
      ...(status ? { status } : {}),
    }
  },
  schedule(view) {
    return view.game.active && view.game.turn !== view.participants[0]
      ? { kind: 'activate', characterId: view.game.turn }
      : { kind: 'wait' }
  },
  onOutcome() {
    return { kind: 'wait' }
  },
  simulate(request) {
    const game = request.context.activity?.game
    const beat = game && beats[game.public.index]
    if (!beat || beat[0] !== request.context.character.characterId) return { decision: 'abstain' }
    return { decision: 'publish', scope: 'scene_public', segments: [{ type: 'speech', text: beat[1] }] }
  },
  onPublished(state, actorId, expression) {
    const game = clone(state.game)
    const beat = beats[game.public.index]
    if (
      !beat ||
      beat[0] !== actorId ||
      expression.scope !== 'scene_public' ||
      (expression.segments ?? [])
        .filter(s => s.type === 'speech')
        .map(s => s.text)
        .join('') !== beat[1]
    )
      throw new TypeError('序章台词与当前节点不符。')
    game.public.index += 1
    game.turn = state.participants[0]
    if (game.public.index === beats.length) finish(game)
    return game
  },
}
