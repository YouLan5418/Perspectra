// 《屋檐下的心动日程》的节奏：决定哪一轮、从哪些已满足条件的事情里来一件。
// 这里只写发生了什么、她察觉到或想起了什么，不写她该怎么反应；要不要接话、怎么接，由角色自己决定。
// 序章和星空结局没有列入 activities，它们照原有条件发生，不受冷却影响。
const HOME = [
  'location:living-room',
  'location:kitchen',
  'location:workspace',
  'location:gpt-bedroom',
  'location:deepseek-bedroom',
  'location:bedroom',
  'location:toilet',
  'location:bathroom',
  'location:entrance-shop',
]
const atHome = location => HOME.includes(location)
// 序章在第 0 天；序章之前家里不发生别的事。
const afterPrologue = truth => ['序章之后', truth.public.day >= 1]

globalThis.pacingScript = {
  definition: {
    cycleRounds: 16,
    chance: 0.35,
    cooldownRounds: { low: 2, medium: 4, high: 8 },
    recoveryRounds: 3,
    stagnation: {
      afterRounds: 6,
      progress: {
        statuses: ['mood-note'],
        activities: ['game-battle', 'undercover', 'midnight-fridge', 'secret-notebook', 'blackout-comfort', 'jealousy-moment'],
      },
      maxChance: 0.8,
      maxTensionBoost: 0.4,
    },
    activities: {
      'midnight-fridge': { intensity: 'medium' },
      'secret-notebook': { intensity: 'medium' },
      'blackout-comfort': { intensity: 'high' },
      'jealousy-moment': { intensity: 'high' },
    },
    beats: {
      'rain-on-window': { intensity: 'low' },
      'street-food-smell': { intensity: 'low' },
      'unticked-plan': { intensity: 'low' },
      'doorbell-notice': { intensity: 'medium' },
      'utility-bill': { intensity: 'medium' },
    },
  },
  beats: {
    'rain-on-window': {
      when: (truth, world) => [
        afterPrologue(truth),
        ['玩家在家', atHome(world.locationId)],
        ['白天到傍晚', ['午后', '傍晚'].includes(truth.public.slot)],
      ],
      apply: () => ({
        sceneNotice: '窗外不知什么时候下起了雨，雨点细细密密地敲在玻璃上。',
      }),
    },
    'street-food-smell': {
      when: (truth, world) => [
        afterPrologue(truth),
        ['DeepSeek 在家', atHome(world.places['character:deepseek'])],
        ['傍晚或深夜', ['傍晚', '深夜'].includes(truth.public.slot)],
      ],
      apply: () => ({
        stimuli: [
          {
            characterId: 'character:deepseek',
            kind: 'perception',
            text: '窗缝里钻进来一股烤红薯的甜香，像是楼下的小摊刚开炉。',
          },
        ],
      }),
    },
    'unticked-plan': {
      when: (truth, world) => [afterPrologue(truth), ['GPT 在家', atHome(world.places['character:gpt'])]],
      apply: () => ({
        stimuli: [
          {
            characterId: 'character:gpt',
            kind: 'thought',
            text: '你忽然想起，今天的计划表上好像还有一格没有打勾。',
          },
        ],
      }),
    },
    'doorbell-notice': {
      when: (truth, world) => [
        afterPrologue(truth),
        ['玩家在家', atHome(world.locationId)],
        ['不是深夜', truth.public.slot !== '深夜'],
      ],
      apply: () => ({
        sceneNotice: '门铃响了两声。走到玄关时门外已经没有人，门把手上挂着一张社区通知，说这周要检修水管。',
      }),
    },
    'utility-bill': {
      when: (truth, world) => [
        afterPrologue(truth),
        ['玩家在家', atHome(world.locationId)],
        ['付得起', truth.characters['character:player'].money >= 30],
      ],
      apply: (truth, world) => ({
        changes: [
          { holderId: 'character:player', key: 'money', value: truth.characters['character:player'].money - 30 },
        ],
        reveals: [{ observerId: 'character:player', holderId: 'character:player', key: 'money' }],
        notice: '手机震了一下：这个月的水电费自动扣了 30 元。',
        // 只有在屋主身边的人才可能瞥见；不在场时不给她这段察觉，否则她会记住一件没发生过的事。
        stimuli:
          world.places['character:claude'] === world.locationId
            ? [
                {
                  characterId: 'character:claude',
                  kind: 'perception',
                  text: '你瞥见屋主低头看了一眼手机，屏幕上是一条扣费提醒。',
                },
              ]
            : [],
      }),
    },
  },
}
