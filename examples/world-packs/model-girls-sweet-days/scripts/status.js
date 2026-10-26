// 《屋檐下的心动日程》状态与物品规则：
// 维护日程、全屋供电、个人生活费与精力；送礼现场只告知亲历者，心动印象保留作者的剧情引导。
// 以及街角商店购买、玄关兼职打工、厨房泡茶做饭、卧室吹发护理、雨夜合闸与星空投影操作。
const none = { type: 'object', additionalProperties: false, properties: {} }

const SHOP_CATALOG = {
  'entity:fresh-ingredients': {
    price: 40,
    boughtKind: '特级料理食材包：新鲜大虾、和牛片与时令蔬菜，可在厨房料理锅台做出合家欢大餐',
  },
  'entity:strawberry-cake': {
    price: 50,
    boughtKind: '限定草莓小蛋糕：铺满红颜草莓的单人份精致小蛋糕，散发着诱人的甜香，拿在手里的人可以吃掉它',
  },
  'entity:brass-bookmark': {
    price: 80,
    boughtKind: '古董黄铜书签：雕刻着精密星轨纹样的绝版书签，在灯光下泛着温润的光泽',
  },
  'entity:horn-oil': {
    price: 80,
    boughtKind: '龙角精油与深海护尾膏：散发着淡雅白茶香气的特制护理礼盒，卧室吹发护理时可派上大用场',
  },
  'entity:star-projector': {
    price: 150,
    boughtKind: '家用星空投影仪：按下开关即可将整间屋子化作漫天星海的浪漫装置',
  },
  'entity:family-passes': {
    price: 200,
    boughtKind: '游乐园四人家庭套票：印着「屋檐下全员同行」的豪华周末套票，四个人的笑脸一个都不会少；清晨或午后带着大家到游乐园门口即可检票入园',
  },
}

const SLOTS = ['清晨', '午后', '傍晚', '深夜']
const HEROINES = ['character:gpt', 'character:claude', 'character:deepseek']
const NAMES = {
  'character:player': '屋主',
  'character:gpt': 'GPT',
  'character:claude': 'Claude',
  'character:deepseek': 'DeepSeek',
}

const ITEM_RULES = {
  take: [
    'entity:gpt-notebook',
    'entity:aquarium-ticket',
    'entity:hair-dryer',
    'entity:flashlight',
    'entity:tea-cup',
    'entity:fresh-ingredients',
    'entity:strawberry-cake',
    'entity:brass-bookmark',
    'entity:horn-oil',
    'entity:star-projector',
    'entity:family-passes',
  ],
  drop: [
    'entity:gpt-notebook',
    'entity:aquarium-ticket',
    'entity:hair-dryer',
    'entity:flashlight',
    'entity:tea-cup',
    'entity:fresh-ingredients',
    'entity:strawberry-cake',
    'entity:brass-bookmark',
    'entity:horn-oil',
    'entity:star-projector',
    'entity:family-passes',
  ],
  give: [
    'entity:gpt-notebook',
    'entity:aquarium-ticket',
    'entity:hair-dryer',
    'entity:flashlight',
    'entity:tea-cup',
    'entity:fresh-ingredients',
    'entity:strawberry-cake',
    'entity:brass-bookmark',
    'entity:horn-oil',
    'entity:star-projector',
    'entity:family-passes',
  ],
}

const isOnShelf = item => typeof item?.kind === 'string' && item.kind.startsWith('【商店货架')
const freshIngredients = item => typeof item?.kind === 'string' && item.kind.startsWith('特级料理食材包：')
// 吃完、喝完、检过票的东西还留着，但不能再吃喝、再用一次，送出去也不再算一份心意。
const isSpent = item => typeof item?.kind === 'string' && /^(吃完的|空着的|已检票的|已使用的)/.test(item.kind)
const filledCup = item => typeof item?.kind === 'string' && item.kind.startsWith('刚泡好的特调热饮')

// 外出打工或去游乐园都会度过一个时段；第 2 天进入傍晚时雷雨跳闸，与日程白板一致。
function advanceSlot(truth) {
  const nextSlot = SLOTS[Math.min(SLOTS.indexOf(String(truth.public.slot)) + 1, SLOTS.length - 1)]
  const isBlackout = truth.public.day === 2 && nextSlot === '傍晚'
  return {
    nextSlot,
    isBlackout,
    changes: [
      { holderId: null, key: 'slot', value: nextSlot },
      ...(isBlackout ? [{ holderId: null, key: 'power-on', value: false }] : []),
    ],
  }
}

const itemOperations = [
  { id: 'take', label: '拿起{item}', targets: ITEM_RULES.take, schema: none },
  { id: 'drop', label: '放下{item}', targets: ITEM_RULES.drop, schema: none },
  {
    id: 'give',
    label: '把{item}交给',
    targets: ITEM_RULES.give,
    characterParameters: ['recipientId'],
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['recipientId'],
      properties: { recipientId: { type: 'string', title: '交给谁' } },
    },
  },
]

function itemTargets(actorId, place) {
  const where = (ids, held) =>
    place.items
      .filter(
        item =>
          ids.includes(item.entityId) &&
          !isOnShelf(item) &&
          (held ? item.holderId === actorId : item.holderId === null),
      )
      .map(item => item.entityId)
  const targets = {
    take: where(ITEM_RULES.take, false),
    drop: where(ITEM_RULES.drop, true),
    give: where(ITEM_RULES.give, true),
  }
  return Object.fromEntries(itemOperations.map(op => [op.id, targets[op.id]]))
}

function resolveItem(truth, actorId, operationId, parameters, world, targetId) {
  const item = world.items.current.find(entry => entry.entityId === targetId)
  if (!item) return { rejectReason: '看不到这件东西。' }
  if (isOnShelf(item)) return { rejectReason: '这件商品还在商店货架上，需要先付款购买。' }
  const name = item.name ?? item.kind
  if (operationId === 'take') {
    if (item.holderId !== null) return { rejectReason: '已经有人拿着了。' }
    return {
      changes: [],
      reveals: [],
      items: [{ entityId: targetId, to: { holderId: actorId } }],
      description: '拿起了' + name + '。',
      audience: 'scene',
    }
  }
  if (item.holderId !== actorId) return { rejectReason: '你手里没有这件东西。' }
  if (operationId === 'drop') {
    return {
      changes: [],
      reveals: [],
      items: [{ entityId: targetId, to: { locationId: world.locationId } }],
      description: '把' + name + '放在了这里。',
      audience: 'scene',
    }
  }
  const recipientId = parameters.recipientId
  if (recipientId === actorId) return { rejectReason: '不能交给自己。' }

  const changes = []
  const reveals = []
  if (isSpent(item)) {
    // 空纸碟、空杯和用过的票只是物归原主，不写心动印象。
  } else if (actorId === 'character:player' && HEROINES.includes(recipientId)) {
    const witnesses = world.characterIds.filter(id => HEROINES.includes(id) && id !== recipientId)
    const isSingleGift = [
      'entity:strawberry-cake',
      'entity:brass-bookmark',
      'entity:tea-cup',
      'entity:aquarium-ticket',
    ].includes(targetId)
    changes.push({
      holderId: recipientId,
      key: 'mood-note',
      value: '收到了屋主亲手递来的' + name + '，这份专门的关照让自己有些在意',
    })
    reveals.push({ observerId: recipientId, holderId: recipientId, key: 'mood-note' })
    if (isSingleGift && witnesses.length > 0) {
      for (const id of [recipientId, ...witnesses]) {
        changes.push({ holderId: id, key: 'gift-scene', value: world.locationId })
        reveals.push({ observerId: id, holderId: id, key: 'gift-scene' })
      }
      for (const wId of witnesses) {
        changes.push({
          holderId: wId,
          key: 'mood-note',
          value: '亲眼看见屋主当面把' + name + '只给了 ' + NAMES[recipientId] + '，不免留意起这份偏爱',
        })
        reveals.push({ observerId: wId, holderId: wId, key: 'mood-note' })
      }
    }
  } else if (HEROINES.includes(actorId) && recipientId === 'character:player') {
    changes.push({
      holderId: actorId,
      key: 'mood-note',
      value: '鼓起勇气把' + name + '交给了屋主',
    })
    reveals.push({ observerId: actorId, holderId: actorId, key: 'mood-note' })
  }

  return {
    changes,
    reveals,
    items: [{ entityId: targetId, to: { holderId: recipientId } }],
    description: '把' + name + '交给了 ' + (NAMES[recipientId] ?? recipientId) + '。',
    audience: 'scene',
  }
}

const shopIds = Object.keys(SHOP_CATALOG)

globalThis.statusScript = {
  definition: {
    statuses: [
      { key: 'day', label: '天数', type: 'number', owner: 'public', alwaysKnown: true, bar: true },
      { key: 'slot', label: '今日时段', type: 'string', owner: 'public', alwaysKnown: true, bar: true },
      { key: 'power-on', label: '全屋供电', type: 'boolean', owner: 'public', alwaysKnown: true, bar: true },
      { key: 'gift-scene', label: '亲历送礼的房间', type: 'string', owner: 'character' },
      { key: 'money', label: '生活费', type: 'number', owner: 'character', bar: true },
      { key: 'energy', label: '精力', type: 'number', owner: 'character', bar: true },
      {
        key: 'mood-note',
        label: '心动印象',
        type: 'string',
        owner: 'character',
        playerTruth: true,
        bar: false,
      },
    ],
    operations: [
      {
        id: 'sleep-next-day',
        label: '结束今天，休息迎接明天（恢复满精力）',
        actors: 'player',
        schema: none,
      },
      {
        id: 'work-parttime',
        label: '外出兼职打工（+120元 · 消耗1精力并度过1时段）',
        actors: 'player',
        schema: none,
      },
      {
        id: 'buy-item',
        label: '付款购买{item}',
        actors: 'player',
        targets: shopIds,
        schema: none,
      },
      {
        id: 'brew-single-tea',
        label: '冲泡一杯专属热饮端在手里',
        targets: ['entity:tea-set'],
        schema: none,
      },
      {
        id: 'brew-shared-tea',
        label: '冲泡一整壶下午茶（招待在场所有人）',
        targets: ['entity:tea-set'],
        schema: none,
      },
      {
        id: 'cook-simple',
        label: '做一锅热乎的黄金蛋炒饭',
        targets: ['entity:kitchen-pot'],
        schema: none,
      },
      {
        id: 'cook-feast',
        label: '用特级食材做一桌合家欢大餐（消耗1精力）',
        actors: 'player',
        targets: ['entity:kitchen-pot'],
        schema: none,
      },
      {
        id: 'care-hair',
        label: '用{item}帮她吹头发与日常护理（消耗1精力）',
        actors: 'player',
        targets: ['entity:hair-dryer'],
        characterParameters: ['targetCharacterId'],
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['targetCharacterId'],
          properties: {
            targetCharacterId: { type: 'string', title: '要帮谁护理' },
          },
        },
      },
      {
        id: 'fix-power',
        label: '用工具包合闸恢复全屋供电',
        actors: 'player',
        targets: ['entity:flashlight'],
        schema: none,
      },
      {
        id: 'turn-on-stars',
        label: '开启{item}（化作漫天星海）',
        actors: 'player',
        targets: ['entity:star-projector'],
        schema: none,
      },
      { id: 'eat-cake', label: '吃掉{item}', targets: ['entity:strawberry-cake'], schema: none },
      { id: 'drink-tea', label: '喝完{item}', targets: ['entity:tea-cup'], schema: none },
      {
        id: 'enter-aquarium',
        label: '凭{item}进入水族馆夜场（需与屋主同行 · 度过1时段）',
        targets: ['entity:aquarium-ticket'],
        schema: none,
      },
      {
        id: 'enter-amusement-park',
        label: '用{item}和在场的人玩一趟游乐园（度过1时段）',
        targets: ['entity:family-passes'],
        schema: none,
      },
      ...itemOperations,
    ],
  },

  initialize(characterIds) {
    const initialMoods = {
      'character:player': '合租屋主',
      'character:gpt': '干劲满满地张罗试运行周，偷偷期待约会',
      'character:claude': '在书房安静看书，观察屋主的诚意与边界感',
      'character:deepseek': '惦记着好吃的与游戏机，藏着双人水族馆门票',
    }
    const initialMoney = {
      'character:player': 120,
      'character:gpt': 50,
      'character:claude': 80,
      'character:deepseek': 20,
    }
    return {
      public: {
        day: 1,
        slot: '清晨',
        'power-on': true,
      },
      characters: Object.fromEntries(
        characterIds.map(id => [
          id,
          {
            money: initialMoney[id] ?? 50,
            energy: 3,
            'gift-scene': '',
            'mood-note': initialMoods[id] ?? '平静日常',
          },
        ]),
      ),
    }
  },

  policy(known, actorId, place) {
    const findItem = id => place.items.find(entry => entry.entityId === id)
    const money = typeof known.self.money === 'number' ? known.self.money : 0
    const energy = typeof known.self.energy === 'number' ? known.self.energy : 0
    const slot = known.public.slot
    const powerOn = known.public['power-on'] === true

    const buyable = place.items
      .filter(
        item =>
          shopIds.includes(item.entityId) &&
          isOnShelf(item) &&
          money >= (SHOP_CATALOG[item.entityId]?.price ?? 9999),
      )
      .map(item => item.entityId)

    const tea = findItem('entity:tea-set')
    const cup = findItem('entity:tea-cup')
    const cupAtHand = cup && (cup.holderId === actorId || cup.holderId === null) && !filledCup(cup)
    const pot = findItem('entity:kitchen-pot')
    const ingredients = findItem('entity:fresh-ingredients')
    const dryer = findItem('entity:hair-dryer')
    const flashlight = findItem('entity:flashlight')
    const projector = findItem('entity:star-projector')
    const inHand = id => {
      const item = findItem(id)
      return item && item.holderId === actorId && !isOnShelf(item) && !isSpent(item) ? [id] : []
    }
    const cupInHand = cup && cup.holderId === actorId && filledCup(cup) ? [cup.entityId] : []
    const at = locationId => place.locationId === locationId

    const canWork =
      actorId === 'character:player' &&
      place.locationId === 'location:entrance-shop' &&
      slot !== '深夜' &&
      energy >= 1

    const ops = [
      ...(actorId === 'character:player' && slot === '深夜' ? ['sleep-next-day'] : []),
      ...(canWork ? ['work-parttime'] : []),
      'buy-item',
      'brew-single-tea',
      'brew-shared-tea',
      'cook-simple',
      'cook-feast',
      'care-hair',
      'fix-power',
      'turn-on-stars',
      'eat-cake',
      'drink-tea',
      'enter-aquarium',
      'enter-amusement-park',
      ...itemOperations.map(op => op.id),
    ]

    return {
      operations: ops,
      targets: {
        ...itemTargets(actorId, place),
        'buy-item': buyable,
        'brew-single-tea': tea && cupAtHand ? [tea.entityId] : [],
        'brew-shared-tea': tea ? [tea.entityId] : [],
        'cook-simple': pot ? [pot.entityId] : [],
        'cook-feast': pot && freshIngredients(ingredients) && energy >= 1 ? [pot.entityId] : [],
        'care-hair': dryer && powerOn && energy >= 1 && (slot === '傍晚' || slot === '深夜') ? [dryer.entityId] : [],
        'fix-power': flashlight && !powerOn && place.locationId === 'location:entrance-shop' ? [flashlight.entityId] : [],
        'turn-on-stars':
          projector && !isOnShelf(projector) && powerOn && (slot === '傍晚' || slot === '深夜')
            ? [projector.entityId]
            : [],
        'eat-cake': inHand('entity:strawberry-cake'),
        'drink-tea': cupInHand,
        'enter-aquarium': at('location:aquarium') && slot === '傍晚' ? inHand('entity:aquarium-ticket') : [],
        'enter-amusement-park':
          at('location:amusement-park') && (slot === '清晨' || slot === '午后') ? inHand('entity:family-passes') : [],
      },
    }
  },

  resolve(truth, actorId, operationId, parameters, world, targetId) {
    if (['take', 'drop', 'give'].includes(operationId)) {
      return resolveItem(truth, actorId, operationId, parameters, world, targetId)
    }

    const own = truth.characters[actorId]
    const hereItem = id =>
      world.items.current.find(
        item =>
          item.entityId === id &&
          (item.holderId === actorId || (item.holderId === null && item.locationId === world.locationId)),
      )

    if (operationId === 'sleep-next-day') {
      if (truth.public.slot !== '深夜') return { rejectReason: '只有深夜才能结束今天。' }
      const nextDay = Number(truth.public.day) + 1
      return {
        changes: [
          { holderId: null, key: 'day', value: nextDay },
          { holderId: null, key: 'slot', value: '清晨' },
          { holderId: actorId, key: 'energy', value: 3 },
        ],
        reveals: [],
        description: '一觉醒来，迎来了同居生活的第 ' + nextDay + ' 天清晨，精力恢复为3点。',
        audience: 'self',
      }
    }

    if (operationId === 'work-parttime') {
      if (world.locationId !== 'location:entrance-shop') {
        return { rejectReason: '需要先到「玄关与街角商店」才能出门兼职打工。' }
      }
      if (truth.public.slot === '深夜') {
        return { rejectReason: '已经深夜了，外面的兼职店打烊了，先回卧室休息吧。' }
      }
      if ((own.energy ?? 0) < 1) {
        return { rejectReason: '今天精力已经耗尽了，先休息或留在屋里陪大家吧。' }
      }
      const { nextSlot, isBlackout, changes: slotChanges } = advanceSlot(truth)
      const nextMoney = Number(own.money ?? 0) + 120
      const nextEnergy = Number(own.energy ?? 1) - 1
      const changes = [
        { holderId: actorId, key: 'money', value: nextMoney },
        { holderId: actorId, key: 'energy', value: nextEnergy },
        ...slotChanges,
      ]
      return {
        changes,
        reveals: [],
        description:
          '外出兼职忙活了一个时段，赚到 120 元生活费（当前余额 ' +
          nextMoney +
          ' 元），时间来到了' +
          nextSlot +
          '。' +
          (isBlackout ? '刚回到玄关，窗外一道闷雷闪过，屋里啪的一声跳闸停电了！' : '不知道你不在家的这段时间，屋里的三位少女各自做了些什么？'),
        audience: 'scene',
      }
    }

    if (operationId === 'buy-item') {
      const spec = targetId ? SHOP_CATALOG[targetId] : null
      const item = world.items.current.find(entry => entry.entityId === targetId)
      if (!spec || !item || !isOnShelf(item)) {
        return { rejectReason: '这件商品已经买过了。' }
      }
      if (Number(own.money ?? 0) < spec.price) {
        return { rejectReason: '生活费不足（需要 ' + spec.price + ' 元），可以先在玄关外出兼职打工。' }
      }
      const nextMoney = Number(own.money) - spec.price
      const name = item.name ?? targetId
      return {
        changes: [{ holderId: actorId, key: 'money', value: nextMoney }],
        reveals: [],
        items: [{ entityId: targetId, kind: spec.boughtKind, to: { holderId: actorId } }],
        description:
          '花费 ' +
          spec.price +
          ' 元买下了「' +
          name +
          '」（剩余生活费 ' +
          nextMoney +
          ' 元），现在拿在手里，可以带回屋里使用或送人。',
        audience: 'scene',
      }
    }

    if (operationId === 'brew-single-tea') {
      const tea = hereItem('entity:tea-set')
      if (!tea) return { rejectReason: '手边没有冲泡台茶具。' }
      // 热饮装在独立的单人杯里，茶具留在冲泡台上，其他人之后仍能泡茶。
      const cup = hereItem('entity:tea-cup')
      if (!cup) return { rejectReason: '单人热饮杯已经端出去了，等它回到冲泡台再泡。' }
      if (filledCup(cup)) return { rejectReason: '杯里的热饮还没喝完。' }
      return {
        changes: [],
        reveals: [],
        items: [
          {
            entityId: 'entity:tea-cup',
            kind: '刚泡好的特调热饮（单人杯）：冒着热气的伯爵红茶与棉花糖热可可，香气扑鼻，可以端去任何房间交给心仪的人',
            ...(cup.holderId === actorId ? {} : { to: { holderId: actorId } }),
          },
        ],
        description: '细心地冲泡了一杯冒着热气的特调热饮端在手里。',
        audience: 'scene',
      }
    }

    if (operationId === 'brew-shared-tea') {
      const tea = hereItem('entity:tea-set')
      if (!tea) return { rejectReason: '手边没有冲泡台茶具。' }
      // 日常茶会不写心动印象，免得冲掉送礼、护理或告白留下的那一句；只清掉送礼现场标记。
      const presentHeroines = world.characterIds.filter(id => HEROINES.includes(id))
      const changes = []
      const reveals = []
      for (const id of presentHeroines) {
        changes.push({ holderId: id, key: 'gift-scene', value: '' })
        reveals.push({ observerId: id, holderId: id, key: 'gift-scene' })
      }
      return {
        changes,
        reveals,
        items: [
          {
            entityId: 'entity:tea-set',
            kind: '刚泡好的一整壶醇香红茶与茶点：茶香四溢，足够在场的所有人一人一杯围坐共享',
          },
        ],
        description: '泡好了一整壶醇香红茶与热可可，给在场的每个人都倒上了一杯。',
        audience: 'scene',
      }
    }

    if (operationId === 'cook-simple') {
      const pot = hereItem('entity:kitchen-pot')
      if (!pot) return { rejectReason: '手边没有料理锅台。' }
      // 家常简餐不写心动印象，保留之前重要时刻的那一句。
      return {
        changes: [],
        reveals: [],
        items: [
          {
            entityId: 'entity:kitchen-pot',
            kind: '热气腾腾的黄金蛋炒饭：粒粒分明、鸡蛋蓬松，简单却充满家的烟火气',
          },
        ],
        description: '开火颠勺，做出了一大盘热气腾腾的黄金蛋炒饭。',
        audience: 'scene',
      }
    }

    if (operationId === 'cook-feast') {
      const pot = hereItem('entity:kitchen-pot')
      const ingredients = hereItem('entity:fresh-ingredients')
      if (!pot) return { rejectReason: '需要在厨房的料理锅台旁才能做大餐。' }
      if (!freshIngredients(ingredients)) {
        return { rejectReason: '手边没有买好的「特级料理食材包」，可以先去玄关商店采购。' }
      }
      if (Number(own.energy) < 1) return { rejectReason: '做大餐需要1点精力，今晚先简单吃一点吧。' }
      const presentHeroines = world.characterIds.filter(id => HEROINES.includes(id))
      const changes = [
        { holderId: actorId, key: 'energy', value: Number(own.energy) - 1 },
        ...presentHeroines.map(id => ({
          holderId: id,
          key: 'mood-note',
          value: '屋主为在场的人准备了丰盛的海鲜和牛大餐，感受到这份照顾的心意',
        })),
      ]
      const reveals = presentHeroines.map(id => ({
        observerId: id,
        holderId: id,
        key: 'mood-note',
      }))
      return {
        changes,
        reveals,
        items: [
          {
            entityId: 'entity:kitchen-pot',
            kind: '丰盛的海鲜和牛合家欢大餐：鲜虾、和牛与时蔬咕嘟作响，香气飘满了整间屋子',
          },
          {
            entityId: 'entity:fresh-ingredients',
            kind: '已用完的特级料理食材礼盒：见证了一顿超丰盛的合家欢料理',
          },
        ],
        description: '用特级料理食材包精心烹制了一整桌「海鲜和牛合家欢大餐」，满屋飘香！',
        audience: 'scene',
      }
    }

    if (operationId === 'care-hair') {
      const dryer = hereItem('entity:hair-dryer')
      if (!dryer) return { rejectReason: '手边没有吹风机与护理软毛梳。' }
      if (!truth.public['power-on']) return { rejectReason: '停电时吹风机无法工作，先去玄关恢复供电吧。' }
      if (Number(own.energy) < 1) return { rejectReason: '晚间护理需要1点精力，先休息吧。' }
      if (truth.public.slot !== '傍晚' && truth.public.slot !== '深夜') {
        return { rejectReason: '吹头发和晚间护理更适合在傍晚或深夜进行。' }
      }
      const targetChar = parameters.targetCharacterId
      if (targetChar === actorId || !HEROINES.includes(targetChar)) {
        return { rejectReason: '请选择一位在场的少女帮她护理。' }
      }
      const hasOil = Boolean(hereItem('entity:horn-oil') && !isOnShelf(hereItem('entity:horn-oil')))
      const detailByChar = {
        'character:gpt': hasOil
          ? '用吹风机吹干发丝，再蘸取温热的护角精油细细擦拭她敏感发烫的小龙角与龙尾'
          : '用温风帮 GPT 吹干长发，再用软毛梳轻轻梳理她小龙角旁的碎发',
        'character:claude': hasOil
          ? '伴着淡雅的白茶精油香气，帮摘下眼镜的 Claude 吹干长发并轻柔按揉她放松下来的肩颈'
          : '在安静的灯光下帮 Claude 一缕缕吹干微湿的长发，指尖轻轻拂过她的耳畔',
        'character:deepseek': hasOil
          ? '用吹风机吹干她的蓝发，再涂上深海护尾膏帮她把鲸鱼尾巴顺得油亮水润'
          : '帮 DeepSeek 吹干翘起来的呆毛，顺手帮她拍了拍一晃一晃的鲸鱼尾巴',
      }
      const desc = detailByChar[targetChar] ?? '温柔地帮她吹干了头发'
      return {
        changes: [
          { holderId: actorId, key: 'energy', value: Number(own.energy) - 1 },
          {
            holderId: targetChar,
            key: 'mood-note',
            value: hasOil
              ? '屋主用特制精油礼盒帮自己做晚间护理，亲近的距离让自己有些心动'
              : '屋主温柔地帮自己吹头发，对这份细心多了几分好感',
          },
        ],
        reveals: [{ observerId: targetChar, holderId: targetChar, key: 'mood-note' }],
        description: desc + '。',
        audience: 'scene',
      }
    }

    if (operationId === 'fix-power') {
      const light = hereItem('entity:flashlight')
      if (!light) return { rejectReason: '手边没有应急手电筒与工具包。' }
      if (world.locationId !== 'location:entrance-shop') return { rejectReason: '需要到玄关电箱旁合闸。' }
      if (truth.public['power-on']) {
        return { rejectReason: '现在屋里供电正常，不需要合闸抢修。' }
      }
      return {
        changes: [{ holderId: null, key: 'power-on', value: true }],
        reveals: [],
        description: '打着手电筒用工具包排查了电箱，咔哒一声推上空气开关，屋里重新恢复了温暖明亮的灯光。',
        audience: 'scene',
      }
    }

    if (operationId === 'turn-on-stars') {
      const proj = hereItem('entity:star-projector')
      if (!proj || isOnShelf(proj)) return { rejectReason: '手边没有买好的家用星空投影仪。' }
      if (!truth.public['power-on']) return { rejectReason: '停电时投影仪无法工作。' }
      if (!['傍晚', '深夜'].includes(truth.public.slot)) return { rejectReason: '等到傍晚或深夜再开启星空投影吧。' }
      return {
        changes: [],
        reveals: [],
        // 投影仪放稳在这个房间才投得出星空；拿在手里带走的不算这个房间的星空。
        items: [
          {
            entityId: 'entity:star-projector',
            kind: '正在旋转的家用星空投影仪：璀璨的银河与星轨洒满天花板与四周墙壁，如梦似幻',
            to: { locationId: world.locationId },
          },
        ],
        description: '关掉顶灯，把星空投影仪放稳、按下开关，璀璨的银河与漫天星光瞬间洒满了整间屋子。',
        audience: 'scene',
      }
    }

    if (operationId === 'eat-cake') {
      const cake = world.items.current.find(item => item.entityId === 'entity:strawberry-cake')
      if (!cake || cake.holderId !== actorId || isOnShelf(cake)) return { rejectReason: '手里没有买好的草莓小蛋糕。' }
      if (isSpent(cake)) return { rejectReason: '蛋糕已经吃完了，只剩一个空纸碟。' }
      return {
        changes: [],
        reveals: [],
        items: [
          {
            entityId: 'entity:strawberry-cake',
            kind: '吃完的草莓小蛋糕纸碟：只剩一点奶油印和草莓蒂，蛋糕已经被吃掉了',
          },
        ],
        description: '把限定草莓小蛋糕一口一口吃完了，纸碟上只剩一点奶油。',
        audience: 'scene',
      }
    }

    if (operationId === 'drink-tea') {
      const cup = world.items.current.find(item => item.entityId === 'entity:tea-cup')
      if (!cup || cup.holderId !== actorId || !filledCup(cup)) return { rejectReason: '手里没有泡好的热饮。' }
      return {
        changes: [],
        reveals: [],
        items: [
          { entityId: 'entity:tea-cup', kind: '空着的单人马克杯：热饮已经喝完，拿回冲泡台旁就能再泡一杯' },
        ],
        description: '捧着杯子把热饮慢慢喝完了，杯底还留着一点暖意。',
        audience: 'scene',
      }
    }

    if (operationId === 'enter-aquarium' || operationId === 'enter-amusement-park') {
      const aquarium = operationId === 'enter-aquarium'
      const ticketId = aquarium ? 'entity:aquarium-ticket' : 'entity:family-passes'
      const ticket = world.items.current.find(item => item.entityId === ticketId)
      if (!ticket || ticket.holderId !== actorId || isOnShelf(ticket)) return { rejectReason: '手里没有这张票。' }
      if (isSpent(ticket)) return { rejectReason: '这张票已经用过了。' }
      if (world.locationId !== (aquarium ? 'location:aquarium' : 'location:amusement-park')) {
        return { rejectReason: aquarium ? '要先到城市水族馆门口才能检票。' : '要先到游乐园门口才能检票。' }
      }
      const slot = truth.public.slot
      if (aquarium && slot !== '傍晚') return { rejectReason: '夜场只在傍晚检票入场。' }
      if (!aquarium && slot !== '清晨' && slot !== '午后') return { rejectReason: '游乐园傍晚就停止入园了，改天早点来吧。' }
      // 票是约会邀请：必须有屋主和至少一位少女同行，心动印象才说得通。
      const companions = world.characterIds.filter(id => HEROINES.includes(id))
      if (!world.characterIds.includes('character:player') || companions.length === 0) {
        return { rejectReason: aquarium ? '双人夜场券要屋主和她一起才能用。' : '家庭套票要屋主带着大家一起才能用。' }
      }
      const { nextSlot, isBlackout, changes } = advanceSlot(truth)
      const allThree = companions.length === HEROINES.length
      const memory = aquarium
        ? '和屋主一起逛了水族馆夜场，在幽蓝的水光里并肩看鱼群游过，这一晚让自己有些心动'
        : allThree
          ? '屋檐下的四个人一个不少地玩遍了游乐园，套票上「全员同行」那几个字真的做到了'
          : '和屋主一起在游乐园玩了半天，回想起来还是很开心'
      for (const id of companions) changes.push({ holderId: id, key: 'mood-note', value: memory })
      return {
        changes,
        reveals: companions.map(id => ({ observerId: id, holderId: id, key: 'mood-note' })),
        items: [
          {
            entityId: ticketId,
            kind: aquarium
              ? '已检票的双人水族馆夜场券：票根盖着今晚的入场章，背面的小鲸鱼还在吐泡泡'
              : '已使用的游乐园四人家庭套票：每一联都撕过了，印着「屋檐下全员同行」的票根留作纪念',
          },
        ],
        description:
          (aquarium
            ? '检票走进水族馆夜场，幽蓝的大水槽前鱼群和鳐鱼缓缓游过，一直逛到闭馆，时间来到了'
            : '检票进了游乐园，旋转木马、过山车和摩天轮一路玩下来，时间来到了') +
          nextSlot +
          '。' +
          (isBlackout ? '出门时天边打起了闷雷，家那一片的灯光忽然全灭了——屋里怕是跳闸停电了！' : ''),
        audience: 'scene',
      }
    }

    return { rejectReason: '未知操作。' }
  },
}
