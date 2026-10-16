import type { StoredWorldEvent } from '../../../../packages/contracts/src/index.ts'
import type { CreatorHistoryItem } from '../../../../tests/experiments/creator-history.ts'
import type { CreatorRecord } from '../../../../tests/experiments/creator-records.ts'

/** 轨迹条目类型。颜色与文字标签同时表示，不依赖单一色相。 */
export type TraceKind =
  | 'context' | 'recall' | 'model' | 'decision' | 'action' | 'turn'
  | 'speak' | 'observation' | 'event' | 'entity' | 'movement' | 'activity' | 'world'

export type StatusTone = 'ok' | 'warn' | 'danger' | 'muted' | 'accent'

/** 右侧详情面板的形态。 */
export type SelectionKind = 'record' | 'event' | 'entity' | 'character' | 'world' | 'variable' | 'activity'

export interface TraceNode {
  /** 稳定键：事件用 seq，记录用 recordId。 */
  key: string
  kind: TraceKind
  statusKey: string
  statusLabel: string
  tone: StatusTone
  characterId: string | null
  summary: string
  detail: string
  durationMs?: number | undefined
  /** 同一决策处理组；对话视图按组把处理链折叠到对应回应上方。 */
  groupId: string
  /** 合并排序用的事件序号；记录按其锚定事件序号落位。 */
  sortSeq: number
  sortRank: number
  seq?: number | undefined
  tick?: number | undefined
  recordId?: string | undefined
  actionId?: string | undefined
  decisionId?: string | null | undefined
  /** 私有处理过程（模型调用、决策、召回、轮次）默认折叠。 */
  processing: boolean
  event?: StoredWorldEvent | undefined
  history?: CreatorHistoryItem | undefined
  /** 列表摘要；正文按 recordId 单独读取。 */
  record?: Omit<CreatorRecord, 'data'> | undefined
}

export interface NameTables {
  characters: Record<string, string>
  entities: Record<string, string>
  locations: Record<string, string>
}

/** 选中的对象；正文与原始数据分开保存，原始 JSON 始终是最后一级。 */
export interface Selection {
  kind: SelectionKind
  id: string
  label: string
  node?: TraceNode | undefined
}

/** 控制台里的页面；与左侧导航一一对应。 */
export type ConsoleView = 'conversation' | 'trace' | 'world' | 'characters' | 'entities' | 'variables' | 'activities'
