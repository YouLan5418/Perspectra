import type { WorldJsonObject } from '@perspectra/sdk/contracts'
import { worldEventSourceFormat } from '@perspectra/sdk'
import { encounterTableSourceFormat, tableOperations } from './runtime/encounter-tables.ts'

/** A discoverable authoring use of a provider. The host composition supplies provider identity and schema. */
export interface AuthoringFeature {
  readonly key: string
  readonly version: number
  readonly title: string
  readonly summary: string
  readonly exampleFile?: string
  readonly configuration?: WorldJsonObject
  readonly requirements: readonly { when: string; plugin?: string; asset?: string; requirement: string }[]
  readonly exampleConfig: WorldJsonObject
  readonly verify: readonly { args: readonly string[]; checks: string }[]
}

export const scheduledNotice: AuthoringFeature = {
  key: 'scheduled-notice',
  version: 1,
  title: '定时世界事件与见证告示',
  summary: '在合格结算时按回合或游戏日历触发预设事件，一次写入公共布尔状态并向见证者投递观察。',
  configuration: {
    ...worldEventSourceFormat(),
    requiredRule: ['id', 'type', 'location', 'observation', 'set'],
    timing: {
      oneOf: ['round', 'when.crossesPackTime'],
      round: '正整数；首个达到阈值的合格结算。',
      calendar: { dayKey: 'day', slotKey: 'slot', slots: ['早', '晚'], at: { day: 2, slot: '晚' } },
    },
    audience: ['scene', 'global', { holds: '<entityId>' }, { anyOf: ['scene', { holds: '<entityId>' }] }],
    limits: [
      '规则 id 唯一，type 带正整数版本，如 town.bell@1。observation 须含可见文本，受众默认为 scene。',
      'sceneNotices 仅用于同场受众的日历规则，地点组非空，且与主地点及其他组无重叠。可带 text、fromOperation。',
      'wakeCharacters 如填写须列互异 NPC，只给实际见证的活跃 NPC 决策机会，角色可沉默。告示预先写入配置。',
    ],
  },
  requirements: [
    {
      when: 'always',
      plugin: 'pack-scripts',
      asset: 'scripts/status.js',
      requirement:
        '在基础状态脚本声明并初始化 set.key 对应的包级公共布尔值，排除活动专用和模块状态；location 引用包内地点。',
    },
    {
      when: 'when.crossesPackTime',
      requirement:
        'dayKey、slotKey 为不同的包级公共数值／字符串状态。初始化只建立基准；有效日历事务须跨过 at，不能与 round 或 paced 并用。',
    },
    {
      when: 'trigger=paced',
      plugin: 'official-pacing',
      asset: 'scripts/pacing.js',
      requirement:
        '节奏器须启用且在 events 登记同一规则 ID；到达 round 只是获得候选资格，活动中还需 duringActivity: true。',
    },
  ],
  exampleConfig: {
    rules: [
      {
        id: 'bell',
        type: 'town.bell@1',
        round: 2,
        location: 'location:start',
        observation: '门廊响起晚钟。',
        set: { key: 'bell-rang', value: true },
      },
    ],
  },
  verify: [
    { args: ['editor', 'event-candidates', '<pack>'], checks: '查看作者工程可选地点、状态写入、日历变量与操作。' },
    { args: ['validate', '<export>'], checks: '检查锁定配置、版本和规则结构。' },
    {
      args: ['simulate', '<export>', '<scenario.json>'],
      checks: '在新档实际装配，走过触发条件并断言状态和授权观察；可用异地对照核对未获授权的角色。',
    },
  ],
}

export const encounterTables: AuthoringFeature = {
  key: 'encounter-tables',
  version: 1,
  title: '遭遇与委托表',
  summary: '玩家在 table-<表键> 活动中抽取候选，遭遇当场结算，委托可接受、交付或放弃。',
  exampleFile: 'gameplay-tables.json',
  configuration: {
    ...encounterTableSourceFormat(),
    rootProperty: 'tables',
    requiredTable: ['key', 'title', 'rows'],
    requiredRow: ['key', 'title', 'kind'],
    kinds: ['encounter', 'quest'],
    operations: tableOperations,
    limits: [
      '表与行的 key 各自在其范围内唯一，标题须含可见文本，rows 至少一行。',
      'weight、limit、duration、reward 为正整数；缺省权重 1。每张表同时保留一个待接受或已接受的委托。',
      'conditions 的 key 和 value 需匹配公开变量及其类型，非数值只支持 eq/ne。duration 要求 quest 和 clockKey，completeEvent 只适用于 quest。',
    ],
  },
  requirements: [
    {
      when: 'always',
      requirement:
        '在 official-dice 的选项中显式指定 config 并锁定该文件；仅选插件或仅放文件不会生成表。活动键 table-<表键> 须可用。',
    },
    { when: 'eligible weight total > 1', requirement: '实际抽取时需要 Host 提供骰子服务；只有一个权重点时直接选中。' },
    {
      when: 'conditions / clockKey / rewardKey',
      plugin: 'pack-scripts',
      asset: 'scripts/status.js',
      requirement:
        '引用 alwaysKnown 的公共标量，排除活动或地点受限状态。期限读取整数计时值，奖励需可写数值变量和正整数 reward。',
    },
    {
      when: 'event / completeEvent',
      plugin: 'official-world-events',
      requirement: '引用已声明的规则 ID；运行时玩家须实际见证。节拍规则还须在已启用的 official-pacing 登记。',
    },
  ],
  exampleConfig: {
    tables: [
      { key: 'errands', title: '门廊差事', rows: [{ key: 'letter', kind: 'quest', title: '递一封信', limit: 1 }] },
    ],
  },
  verify: [
    { args: ['editor', 'tables', '<pack>'], checks: '读取草稿、地点、变量和可引用的世界事件。' },
    { args: ['validate', '<export>'], checks: '校验实际锁定表、权重与包内引用。' },
    {
      args: ['simulate', '<export>', '<scenario.json>'],
      checks: '实际开始 table-errands，依次执行 draw、accept、claim 并核对裁定。',
    },
  ],
}

export const contacts: AuthoringFeature = {
  key: 'contacts',
  version: 1,
  title: '角色通信联系人',
  summary: '按发信角色配置有方向的联系人，用包内通信媒介给另一位角色发消息。',
  requirements: [
    {
      when: 'always',
      requirement: '发件人与收件人须为包内不同角色，每份收件人列表无重复；实际候选还取决于角色是否活跃及宿主通信实现。',
    },
  ],
  exampleConfig: { medium: '短信', contacts: { 'character:player': ['character:companion'] } },
  verify: [
    { args: ['editor', 'communication', '<pack>'], checks: '读取实际配置、schema、是否选用插件及包内角色。' },
    { args: ['validate', '<export>'], checks: '使用插件的配置 schema 和包角色校验联系人。' },
  ],
}
