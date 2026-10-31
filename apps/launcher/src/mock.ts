import type { GamePackage, GameInstance, ModelProfile, ModelConfiguration } from './types.ts'
import type { LensSnapshot } from '../../../desktop/lens/session.ts'
import type { LensView } from '../../../desktop/lens/view.ts'

export const modelProfiles: ModelProfile[] = [
  {
    id: 'flash',
    label: 'Gemini Flash',
    providerId: 'local',
    model: 'gemini-flash',
    capability: 'fast',
    contextTokens: 262144,
    toolCalling: true,
  },
  {
    id: 'pro',
    label: 'Gemini Pro',
    providerId: 'local',
    model: 'gemini-pro',
    capability: 'high',
    contextTokens: 1048576,
    toolCalling: true,
  },
  {
    id: 'gpt',
    label: 'GPT',
    providerId: 'local',
    model: 'gpt',
    capability: 'high',
    contextTokens: 262144,
    toolCalling: true,
  },
]
export const packages: GamePackage[] = [
  {
    id: 'snow-inn',
    version: '1.2.0',
    title: '雪夜旅店',
    subtitle: '风雪之外，每个人都有未说完的故事。',
    description:
      '山路被一场突如其来的暴雪封住。你和几位陌生人留在同一家旅店，壁炉仍燃着，窗外的脚步声却越来越近。接下来的故事，由你们一起写下。',
    genre: '悬疑 · 群像 · 自由扮演',
    artwork: 'inn',
    cover: '/mock-covers/snow-inn.svg',
    recommendation: { capability: 'balanced', contextTokens: 131072, toolCalling: true },
    validation: { status: 'ready', issues: [], simulated: true },
  },
  {
    id: 'quiet-town',
    version: '0.8.2',
    title: '回声小镇',
    subtitle: '最后一班列车之后，小镇又安静下来。',
    description:
      '你带着一封没有署名的信重返故乡。那些熟悉的人似乎都在等待一个答案，而废弃车站的广播，每晚都会准时响起。',
    genre: '探索 · 日常 · 秘密',
    artwork: 'town',
    recommendation: { capability: 'high', contextTokens: 262144, toolCalling: true },
    validation: { status: 'degraded', issues: ['示例：可选环境音扩展缺失；文字游戏仍可继续。'], simulated: true },
  },
  {
    id: 'last-light',
    version: '0.3.0',
    title: '最后一座灯塔',
    subtitle: '海雾深处，有人还在等待光。',
    description: '在无人航行的海岸，灯塔管理员收到了一张来自明天的明信片。',
    genre: '奇幻 · 探索',
    artwork: 'sea',
    recommendation: { capability: 'balanced', contextTokens: 131072, toolCalling: true },
    validation: { status: 'blocked', issues: ['示例：必要世界定义文件缺失。'], simulated: true },
  },
]
export function defaultConfiguration(): ModelConfiguration {
  return { defaultModelId: 'flash', overridesEnabled: false, groups: {}, characters: {} }
}
export function createMockInstance(packageId = 'snow-inn', version = '1.2.0', name = '第一次游玩'): GameInstance {
  const seed = crypto.randomUUID()
  const node = (suffix: string, turn: number, title: string, summary: string, parentNodeId: string | null) => ({
    id: seed + suffix,
    parentNodeId,
    turn,
    title,
    summary,
    createdAt: '2026-10-06T08:00:00+08:00',
  })
  const opening = node('-opening', 0, '抵达旅店', '你推开木门，壁炉的暖意迎面而来。', null)
  const crossroads = node('-crossroads', 80, '一封迟到的信', '她递来信封，等待你的回答。', opening.id)
  const truth = node('-truth', 173, '告诉她真相', '你们决定去地下设施寻找答案。', crossroads.id)
  const current = node('-current', 284, '壁炉旁的约定', '夜色渐深，旅店里的人围坐在炉火旁。', truth.id)
  const leave = node('-leave', 96, '离开小镇', '你收起信件，走向清晨的站台。', crossroads.id)
  const mainId = seed + '-main'
  return {
    id: seed,
    packageId,
    packageVersion: version,
    name,
    currentStorylineId: mainId,
    model: defaultConfiguration(),
    lastPlayedAt: '2026-10-06T08:00:00+08:00',
    localSettings: { textSize: 'standard' },
    nodes: [opening, crossroads, truth, current, leave],
    storylines: [
      {
        id: mainId,
        name: '主故事线',
        parentStorylineId: null,
        parentNodeId: null,
        currentNodeId: current.id,
        source: { kind: 'original', label: '我的故事', storylineId: null, nodeId: null, turn: 0 },
      },
      {
        id: seed + '-truth-line',
        name: '告诉她真相',
        parentStorylineId: mainId,
        parentNodeId: crossroads.id,
        currentNodeId: truth.id,
        source: { kind: 'local', label: '主故事线', storylineId: mainId, nodeId: crossroads.id, turn: 80 },
      },
      {
        id: seed + '-leave-line',
        name: '隐瞒真相',
        parentStorylineId: mainId,
        parentNodeId: crossroads.id,
        currentNodeId: leave.id,
        source: { kind: 'local', label: '主故事线', storylineId: mainId, nodeId: crossroads.id, turn: 80 },
      },
    ],
  }
}
export function createFreshInstance(packageId: string, version: string, name: string): GameInstance {
  const instance = createMockInstance(packageId, version, name)
  const opening = instance.nodes[0]!
  const main = instance.storylines[0]!
  return { ...instance, lastPlayedAt: null, nodes: [opening], storylines: [{ ...main, currentNodeId: opening.id }] }
}

/** Callable characters shown by the model and preset dialogs in browser mock mode. */
export const mockCharacters = [
  { id: 'character:innkeeper', name: '旅店老板' },
  { id: 'character:traveler', name: '旅人' },
]

/** 浏览器预览用的小型透视快照：结构与桌面端 lens-open 的返回一致，内容取自甜蜜日程包的一小部分。 */
export function mockLensSnapshot(): LensSnapshot {
  const characters = (index: number) =>
    ({ kind: 'json', file: 'characters.json', pointer: `/characters/${index}` }) as const
  const fridge = { kind: 'script', file: 'scripts/activities/midnight-fridge.js', hook: 'autoStart' } as const
  const field = (key: string, label: string, value: LensView['items'][number]['fields'][number]['value']) => ({
    key,
    label,
    value,
  })
  const condition = (title: string, met: boolean) => ({
    id: 'event:midnight-fridge/when/' + title,
    section: 'events' as const,
    title,
    parentId: 'event:midnight-fridge',
    fields: [field('met', '开场是否成立', met)],
    source: { ...fridge, label: title },
  })
  const view: LensView = {
    packId: 'pack:model-girls-sweet-days',
    packVersion: '0.1.0',
    title: '模型少女的甜蜜日程（样例）',
    items: [
      {
        id: 'character:deepseek',
        section: 'characters',
        title: 'DeepSeek',
        fields: [
          field('name', '名字', 'DeepSeek'),
          field('persona', '人设摘要', '蓝色鲸鱼尾巴的少女，嘴硬心软，夜里常偷偷找吃的。'),
          field('scene', '初始场景', '客厅'),
          field('everyPlayerTurns', '唤醒频率（每几个玩家回合）', 1),
          field('opportunities', '机会次数', 1),
          field('triggers', '叫醒事件', ['活动「日程」的「推进到下一个时段」', '交互「去打工」']),
          field('interactions', '可用交互', ['做一锅热乎的黄金蛋炒饭', '回房间睡觉']),
          field('places', '可去地点', ['客厅', '厨房']),
          field('events', '相关事件', ['深夜冰箱的偷吃共犯']),
        ],
        source: characters(1),
        links: ['event:midnight-fridge'],
      },
      {
        id: 'character:gpt',
        section: 'characters',
        title: 'GPT',
        fields: [
          field('name', '名字', 'GPT'),
          field('persona', '人设摘要', '认真可靠的姐姐，随身带着一本硬壳笔记本。'),
          field('scene', '初始场景', '客厅'),
          field('everyPlayerTurns', '唤醒频率（每几个玩家回合）', 2),
          field('opportunities', '机会次数', 1),
          field('interactions', '可用交互', ['冲泡一杯专属热饮端在手里']),
          field('places', '可去地点', ['客厅', '厨房']),
        ],
        source: characters(2),
      },
      {
        id: 'character:player',
        section: 'characters',
        title: '你',
        fields: [field('name', '名字', '你'), field('scene', '初始场景', '客厅')],
        source: characters(0),
      },
      {
        id: 'knowledge:character:gpt/notebook',
        section: 'knowledge',
        title: '初始观察：我有一本硬壳笔记本',
        parentId: 'character:gpt',
        fields: [
          field('content', '内容', '我有一本硬壳笔记本，里面记着大家的喜好。'),
          field('kind', '类型', '初始观察'),
          field('audience', '受众', '仅 GPT'),
        ],
        source: { kind: 'json', file: 'cognition.json', pointer: '/characters/1/observations/0' },
      },
      {
        id: 'place:location:living-room',
        section: 'places',
        title: '客厅',
        fields: [
          field('name', '地点名', '客厅'),
          field('present', '开场时在场者', ['你', 'DeepSeek', 'GPT']),
          field('scenes', '场景', ['scene:living-room']),
        ],
        source: { kind: 'json', file: 'locations.json', pointer: '/locations/0' },
      },
      {
        id: 'place:location:kitchen',
        section: 'places',
        title: '厨房',
        fields: [
          field('name', '地点名', '厨房'),
          field('present', '开场时在场者', []),
          field('scenes', '场景', ['scene:kitchen']),
        ],
        source: { kind: 'json', file: 'locations.json', pointer: '/locations/1' },
      },
      {
        id: 'status:slot',
        section: 'statuses',
        title: '今日时段',
        fields: [
          field('key', '键', 'slot'),
          field('label', '名称', '今日时段'),
          field('type', '类型', 'string'),
          field('owner', '归属', 'public'),
          field('alwaysKnown', '人人都知道', true),
          field('opening', '开场值', '深夜'),
        ],
        source: { kind: 'script', file: 'scripts/status.js', hook: 'definition', label: 'slot' },
      },
      {
        id: 'status:day',
        section: 'statuses',
        title: '天数',
        fields: [
          field('key', '键', 'day'),
          field('label', '名称', '天数'),
          field('type', '类型', 'number'),
          field('owner', '归属', 'public'),
          field('opening', '开场值', 1),
        ],
        source: { kind: 'script', file: 'scripts/status.js', hook: 'definition', label: 'day' },
      },
      {
        id: 'item:entity:pudding',
        section: 'items',
        title: '布丁',
        fields: [
          field('name', '名称', '布丁'),
          field('kind', '种类', '食物'),
          field('holder', '开场持有者或位置', '厨房'),
        ],
        source: { kind: 'json', file: 'entities.json', pointer: '/entities/5' },
      },
      {
        id: 'event:prologue',
        section: 'events',
        title: '序章',
        fields: [field('title', '标题', '序章'), field('autoStart', '自动触发', true)],
        source: { kind: 'script', file: 'scripts/activities/prologue.js', hook: 'definition' },
      },
      {
        id: 'event:midnight-fridge',
        section: 'events',
        title: '深夜冰箱的偷吃共犯',
        fields: [
          field('title', '标题', '深夜冰箱的偷吃共犯'),
          field('opening', '开场文案', '深夜的厨房里传来悉悉索索的动静……'),
          field('participants', '参与者', ['DeepSeek']),
          field('operations', '玩家操作', ['结束这段互动，继续生活', '小声关上门：「见者有份，我们一人一半当共犯」']),
          field('autoStart', '自动触发', true),
        ],
        source: { kind: 'script', file: 'scripts/activities/midnight-fridge.js', hook: 'definition' },
        links: ['character:deepseek'],
      },
      condition('还没发生过', true),
      condition('时段是深夜', true),
      condition('玩家在厨房', false),
      condition('DeepSeek 在厨房', false),
      {
        id: 'rule:status:cook-simple',
        section: 'rules',
        title: '做一锅热乎的黄金蛋炒饭',
        fields: [
          field('applies', '适用对象', ['自身']),
          field('actors', 'actors', '任何人'),
          field('onRoundEnd', '回合钩子', true),
        ],
        source: { kind: 'script', file: 'scripts/status.js', hook: 'definition', label: 'cook-simple' },
      },
      {
        id: 'preset:model',
        section: 'presets',
        title: '模型预设',
        fields: [
          field('temperature', 'temperature', 0.9),
          field('nodes', '提示节点', ['世界观', '角色卡', '旧版文风（停用）']),
        ],
        source: { kind: 'json', file: 'model-preset.json', pointer: '' },
      },
    ],
  }
  const conditions = [
    {
      activityKey: 'midnight-fridge',
      title: '深夜冰箱的偷吃共犯',
      checks: [
        { label: '还没发生过', met: false },
        { label: '时段是深夜', met: true },
        { label: '玩家在厨房', met: true },
        { label: null, met: true },
      ],
      started: false,
    },
  ]
  const state = {
    busy: false,
    paused: false,
    phaseLabel: '等待玩家',
    notice: '',
    error: false,
    transcript: [],
    canWait: true,
    world: { title: view.title, playerName: '你', npcNames: ['DeepSeek', 'GPT'] },
    availableActions: [
      { actionType: 'move', actionVersion: 1, destinations: [{ locationId: 'location:living-room', name: '客厅' }] },
      {
        actionType: 'interact',
        actionVersion: 1,
        interactions: [
          {
            targetRef: { kind: 'character', id: 'character:deepseek' },
            bindingId: 'binding:pat',
            definitionRef: { id: 'base:pat', version: 1 },
            arguments: {},
          },
        ],
      },
    ],
    actionLabels: { 'binding:pat': '摸摸 DeepSeek 的头' },
    activities: [
      {
        title: '深夜冰箱的偷吃共犯',
        activityKey: 'midnight-fridge',
        available: true,
        id: 'activity-1',
        revision: 2,
        game: { active: true },
        options: [{ label: '结束这段互动，继续生活', definitionRef: { id: 'activity:end-response', version: 1 } }],
      },
    ],
    debug: {},
  } as unknown as LensSnapshot['simulation']['state']
  const input = (text: string, seq: number) => ({ kind: 'input' as const, actorId: 'character:player', text, seq })
  return {
    view,
    baseline: { kind: 'seen' },
    changes: [
      {
        kind: 'changed',
        id: 'character:deepseek',
        fields: [{ key: 'everyPlayerTurns', label: '唤醒频率（每几个玩家回合）', before: 2, after: 1 }],
      },
      { kind: 'added', id: 'event:midnight-fridge/when/DeepSeek 在厨房' },
      { kind: 'removed', id: 'event:midnight-fridge/when/冰箱里有布丁', title: '冰箱里有布丁', section: 'events' },
    ],
    requests: [
      {
        id: 'request-1',
        itemId: 'event:midnight-fridge/when/时段是深夜',
        itemTitle: '时段是深夜',
        source: { ...fridge, label: '时段是深夜' },
        note: '改成傍晚也能触发',
        valueAtCreation: [field('met', '开场是否成立', true)],
        createdAt: '2026-10-31T08:00:00.000Z',
        state: 'open',
      },
      {
        id: 'request-2',
        itemId: 'character:deepseek',
        itemTitle: 'DeepSeek',
        source: characters(1),
        note: '主动一点，每回合都给她机会',
        valueAtCreation: [],
        createdAt: '2026-10-30T08:00:00.000Z',
        state: 'changed',
      },
    ],
    checkpoints: [{ name: '改冰箱之前', savedAt: '2026-10-30T08:00:00.000Z' }],
    scenarios: ['midnight-kitchen.json'],
    simulation: {
      start: {
        status: { public: { slot: '深夜' } },
        scenes: { 'character:deepseek': 'scene:kitchen' },
        skipAutoStart: ['prologue'],
      },
      trace: [
        {
          index: 0,
          step: { kind: 'action', action: { actionType: 'move', parameters: { locationId: 'location:kitchen' } } },
          lines: [
            input('输入：/act move {"locationId":"location:kitchen"}', 4),
            { kind: 'resolved', actorId: 'character:player', text: '你 的 move 行动已裁定', seq: 5 },
            { kind: 'moved', actorId: 'character:player', text: '你 从 客厅 来到 厨房', seq: 6 },
            {
              kind: 'activity',
              actorId: 'character:player',
              activityKey: 'midnight-fridge',
              text: '活动 深夜冰箱的偷吃共犯（midnight-fridge）：开始',
              seq: 7,
            },
            { kind: 'round-hook', text: '回合结束：无变化', seq: 8 },
          ],
          autoStart: [
            { ...conditions[0]!, checks: conditions[0]!.checks.map(check => ({ ...check, met: true })), started: true },
          ],
          activated: ['character:deepseek'],
        },
        {
          index: 1,
          step: {
            kind: 'activity',
            request: {
              activityKey: 'midnight-fridge',
              activityId: 'activity-1',
              revision: 1,
              operation: 'share-secret',
              parameters: {},
            },
          },
          lines: [
            input('输入：活动 midnight-fridge 的 share-secret', 8),
            {
              kind: 'activity',
              actorId: 'character:player',
              activityKey: 'midnight-fridge',
              text: '活动 深夜冰箱的偷吃共犯（midnight-fridge）：你提议当共犯',
              seq: 9,
            },
            { kind: 'status', text: '状态 DeepSeek 的 energy：3 → 4', seq: 10 },
          ],
          autoStart: [],
          activated: [],
        },
      ],
      state,
      conditions,
    },
  }
}
