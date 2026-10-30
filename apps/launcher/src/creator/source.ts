import type { CreatorInspectionQuery, CreatorInspectionSnapshot } from '../../../../desktop/host/creator-inspection.ts'
import type { CreatorHistoryQuery, CreatorHistorySnapshot } from '../../../../desktop/host/creator-history.ts'
import type { CreatorRecordsQuery, CreatorRecordsSnapshot } from '../../../../desktop/host/creator-records.ts'
import type { StageConfig, StageMarks } from '../../../../desktop/host/pack-frontend.ts'
import type { InspectorSnapshot } from '@harness-world/provider-chat'
import { MOCK_RECORDS, mockDebug, mockHistory } from './mock.ts'

/** 创作者页面需要的只读元信息，由 playtest 服务器 `/api/creator-meta` 提供。 */
export interface CreatorMeta {
  title: string
  storyline: string
  characters: { id: string; name: string }[]
  /** 包声明的地点名；旧宿主不提供时为空。 */
  locations?: { id: string; name: string }[]
}

/** 包里的默认舞台设置与可标记的立绘；只有用默认舞台的包能保存标记。 */
export interface CreatorStage {
  editable: boolean
  stage: StageConfig | null
  portraits?: string[]
}

/** 创作者读取入口。预览模式用固定样例，结构与真实接口一致。 */
export interface CreatorSource {
  readonly preview: boolean
  meta(): Promise<CreatorMeta>
  requests(enabled?: boolean): Promise<InspectorSnapshot>
  debug(query?: CreatorInspectionQuery): Promise<CreatorInspectionSnapshot>
  history(query?: CreatorHistoryQuery): Promise<CreatorHistorySnapshot>
  records(query?: CreatorRecordsQuery): Promise<CreatorRecordsSnapshot>
  setCapture(enabled: boolean): Promise<void>
  stage(): Promise<CreatorStage>
  saveStage(characterId: string, marks: StageMarks): Promise<CreatorStage>
}

const wait = () => new Promise(resolve => setTimeout(resolve, 120))

const previewSource: CreatorSource = {
  preview: true,
  async meta() {
    await wait()
    return { title: '预览世界', storyline: '主故事线', characters: [] }
  },
  async requests(enabled) {
    await wait()
    return { enabled: enabled ?? false, requests: [] }
  },
  async debug(query = {}) {
    await wait()
    return mockDebug(query.characterId)
  },
  async history(query = {}) {
    await wait()
    const snapshot = mockHistory()
    const search = query.search?.toLocaleLowerCase()
    const items = snapshot.items.filter(item => {
      if (query.eventSeq !== undefined && item.event.seq !== query.eventSeq) return false
      if (item.event.seq <= (query.afterSeq ?? 0)) return false
      if (
        query.characterId !== undefined &&
        item.actorId !== query.characterId &&
        String((item.event.data as { value?: { observerId?: string } }).value?.observerId ?? '') !== query.characterId
      )
        return false
      if (query.entityId !== undefined && !JSON.stringify(item).includes(query.entityId)) return false
      if (query.eventType !== undefined && item.event.eventType !== query.eventType) return false
      if (query.status !== undefined) {
        const accepted = (item.event.data as { accepted?: boolean }).accepted === true
        if (item.event.eventType !== 'action.resolved' || (accepted ? 'accepted' : 'rejected') !== query.status)
          return false
      }
      if (search !== undefined && !JSON.stringify(item).toLocaleLowerCase().includes(search)) return false
      return true
    })
    const limit = query.limit ?? 50
    const page = items.slice(0, limit)
    return {
      ...snapshot,
      items: page,
      hasMore: items.length > limit,
      nextAfterSeq: items.length > limit ? page.at(-1)!.event.seq : snapshot.headSeq,
    }
  },
  async records(query = {}) {
    await wait()
    const search = query.search?.toLocaleLowerCase()
    const filtered = MOCK_RECORDS.filter(
      record =>
        (query.characterId === undefined || record.characterId === query.characterId) &&
        (query.kind === undefined || record.kind === query.kind) &&
        (query.decisionId === undefined || record.decisionId === query.decisionId) &&
        (query.status === undefined || record.summary.status === query.status) &&
        (search === undefined || JSON.stringify(record).toLocaleLowerCase().includes(search)),
    )
    const offset = query.offset ?? 0,
      limit = query.limit ?? 50
    const page = filtered.slice(offset, offset + limit).map(({ data: _data, ...summary }) => summary)
    return {
      scope: mockHistory().scope!,
      captureEnabled: true,
      storageError: null,
      branches: ['main', 'candidate-0'],
      items: page,
      total: filtered.length,
      nextOffset: offset + page.length,
      hasMore: offset + page.length < filtered.length,
      record: MOCK_RECORDS.find(record => record.id === query.recordId) ?? null,
      limitations: ['预览数据；未连接真实实例。'],
    }
  },
  async setCapture() {
    await wait()
  },
  async stage() {
    await wait()
    return { editable: false, stage: null, portraits: [] }
  },
  async saveStage() {
    throw new Error('浏览器预览不能保存标记。')
  },
}

/** 同源读取运行中游戏的创作者接口；token 与玩家页面相同，没有 token 时使用预览样例。 */
export function creatorSource(token: string, fetcher: typeof fetch = (...args) => fetch(...args)): CreatorSource {
  if (!token) return previewSource
  const read = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const response = await fetcher(path, init ?? { headers: { 'x-playtest-token': token } })
    if (!response.ok) throw new Error(`创作者数据读取失败（${response.status}）`)
    return (await response.json()) as T
  }
  const get = <T>(path: string, query: object = {}) => {
    const search = new URLSearchParams()
    for (const [key, value] of Object.entries(query)) if (value !== undefined) search.set(key, String(value))
    const text = search.toString()
    return read<T>(text ? path + '?' + text : path)
  }
  const requests = (enabled?: boolean) =>
    enabled === undefined
      ? read<InspectorSnapshot>('/api/request-inspector')
      : read<InspectorSnapshot>('/api/request-inspector', {
          method: 'POST',
          headers: { 'x-playtest-token': token, 'content-type': 'application/json' },
          body: JSON.stringify({ enabled }),
        })
  return {
    preview: false,
    meta: () => get('/api/creator-meta'),
    requests,
    debug: query => get('/api/creator-debug', query),
    history: query => get('/api/creator-history', query),
    records: query => get('/api/creator-records', query),
    async setCapture(enabled) {
      await requests(enabled)
    },
    stage: () => get('/api/creator-stage'),
    async saveStage(characterId, marks) {
      const response = await fetcher('/api/creator-stage', {
        method: 'POST',
        headers: { 'x-playtest-token': token, 'content-type': 'application/json' },
        body: JSON.stringify({ characterId, ...marks }),
      })
      const value = (await response.json()) as CreatorStage & { error?: string }
      // The host says what in the marks the stage file cannot take.
      if (!response.ok) throw new Error(value.error ?? `标记保存失败（${response.status}）`)
      return value
    },
  }
}
