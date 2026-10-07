import type { GamePackage, GameInstance, ModelProfile, ModelConfiguration } from './types.ts'

export const modelProfiles: ModelProfile[] = [
  { id: 'flash', label: 'Gemini Flash', providerId: 'local', model: 'gemini-flash', capability: 'fast', contextTokens: 262144, toolCalling: true },
  { id: 'pro', label: 'Gemini Pro', providerId: 'local', model: 'gemini-pro', capability: 'high', contextTokens: 1048576, toolCalling: true },
  { id: 'gpt', label: 'GPT', providerId: 'local', model: 'gpt', capability: 'high', contextTokens: 262144, toolCalling: true },
]
export const packages: GamePackage[] = [
  { id: 'snow-inn', version: '1.2.0', title: '雪夜旅店', subtitle: '风雪之外，每个人都有未说完的故事。', description: '山路被一场突如其来的暴雪封住。你和几位陌生人留在同一家旅店，壁炉仍燃着，窗外的脚步声却越来越近。接下来的故事，由你们一起写下。', genre: '悬疑 · 群像 · 自由扮演', artwork: 'inn', recommendation: { capability: 'balanced', contextTokens: 131072, toolCalling: true }, validation: { status: 'ready', issues: [], simulated: true } },
  { id: 'quiet-town', version: '0.8.2', title: '回声小镇', subtitle: '最后一班列车之后，小镇又安静下来。', description: '你带着一封没有署名的信重返故乡。那些熟悉的人似乎都在等待一个答案，而废弃车站的广播，每晚都会准时响起。', genre: '探索 · 日常 · 秘密', artwork: 'town', recommendation: { capability: 'high', contextTokens: 262144, toolCalling: true }, validation: { status: 'degraded', issues: ['示例：可选环境音扩展缺失；文字游戏仍可继续。'], simulated: true } },
  { id: 'last-light', version: '0.3.0', title: '最后一座灯塔', subtitle: '海雾深处，有人还在等待光。', description: '在无人航行的海岸，灯塔管理员收到了一张来自明天的明信片。', genre: '奇幻 · 探索', artwork: 'sea', recommendation: { capability: 'balanced', contextTokens: 131072, toolCalling: true }, validation: { status: 'blocked', issues: ['示例：必要世界定义文件缺失。'], simulated: true } },
]
export function defaultConfiguration(): ModelConfiguration {
  return { defaultModelId: 'flash', overridesEnabled: false, groups: {}, characters: {} }
}
export function createMockInstance(packageId = 'snow-inn', version = '1.2.0', name = '第一次游玩'): GameInstance {
  const seed = crypto.randomUUID()
  const node = (suffix: string, turn: number, title: string, summary: string, parentNodeId: string | null) =>
    ({ id: seed + suffix, parentNodeId, turn, title, summary, createdAt: '2026-10-06T08:00:00+08:00' })
  const opening = node('-opening', 0, '抵达旅店', '你推开木门，壁炉的暖意迎面而来。', null)
  const crossroads = node('-crossroads', 80, '一封迟到的信', '她递来信封，等待你的回答。', opening.id)
  const truth = node('-truth', 173, '告诉她真相', '你们决定去地下设施寻找答案。', crossroads.id)
  const current = node('-current', 284, '壁炉旁的约定', '夜色渐深，旅店里的人围坐在炉火旁。', truth.id)
  const leave = node('-leave', 96, '离开小镇', '你收起信件，走向清晨的站台。', crossroads.id)
  const mainId = seed + '-main'
  return {
    id: seed, packageId, packageVersion: version, name, currentStorylineId: mainId,
    model: defaultConfiguration(), lastPlayedAt: '2026-10-06T08:00:00+08:00', localSettings: { textSize: 'standard' },
    nodes: [opening, crossroads, truth, current, leave],
    storylines: [
      { id: mainId, name: '主故事线', parentStorylineId: null, parentNodeId: null, currentNodeId: current.id, source: { kind: 'original', label: '我的故事', storylineId: null, nodeId: null, turn: 0 } },
      { id: seed + '-truth-line', name: '告诉她真相', parentStorylineId: mainId, parentNodeId: crossroads.id, currentNodeId: truth.id, source: { kind: 'local', label: '主故事线', storylineId: mainId, nodeId: crossroads.id, turn: 80 } },
      { id: seed + '-leave-line', name: '隐瞒真相', parentStorylineId: mainId, parentNodeId: crossroads.id, currentNodeId: leave.id, source: { kind: 'local', label: '主故事线', storylineId: mainId, nodeId: crossroads.id, turn: 80 } },
    ],
  }
}
export function createFreshInstance(packageId: string, version: string, name: string): GameInstance {
  const instance = createMockInstance(packageId, version, name)
  const opening = instance.nodes[0]!
  const main = instance.storylines[0]!
  return { ...instance, lastPlayedAt: null, nodes: [opening], storylines: [{ ...main, currentNodeId: opening.id }] }
}
