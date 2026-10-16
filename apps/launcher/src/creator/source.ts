import { isTauri } from '@tauri-apps/api/core'
import type { CreatorDebugQuery, CreatorDebugSnapshot } from '../../../../tests/experiments/creator-debug.ts'
import type { CreatorHistoryQuery, CreatorHistorySnapshot } from '../../../../tests/experiments/creator-history.ts'
import type { CreatorRecordsQuery, CreatorRecordsSnapshot } from '../../../../tests/experiments/creator-records.ts'
import { inspectCreator, inspectCreatorHistory, inspectCreatorRecords, inspectRequests } from '../services/desktop.ts'
import { MOCK_RECORDS, mockDebug, mockHistory } from './mock.ts'

/** 创作者读取入口。预览模式用固定样例，结构与真实接口一致。 */
export interface CreatorSource {
  readonly preview: boolean
  debug(query?: CreatorDebugQuery): Promise<CreatorDebugSnapshot>
  history(query?: CreatorHistoryQuery): Promise<CreatorHistorySnapshot>
  records(query?: CreatorRecordsQuery): Promise<CreatorRecordsSnapshot>
  setCapture(enabled: boolean): Promise<void>
}

const wait = () => new Promise(resolve => setTimeout(resolve, 120))

const previewSource: CreatorSource = {
  preview: true,
  async debug(query = {}) { await wait(); return mockDebug(query.characterId) },
  async history(query = {}) {
    await wait()
    const snapshot = mockHistory()
    const search = query.search?.toLocaleLowerCase()
    const items = snapshot.items.filter(item => {
      if (query.eventSeq !== undefined && item.event.seq !== query.eventSeq) return false
      if (item.event.seq <= (query.afterSeq ?? 0)) return false
      if (query.characterId !== undefined && item.actorId !== query.characterId
        && String((item.event.data as { value?: { observerId?: string } }).value?.observerId ?? '') !== query.characterId) return false
      if (query.entityId !== undefined && !JSON.stringify(item).includes(query.entityId)) return false
      if (query.eventType !== undefined && item.event.eventType !== query.eventType) return false
      if (query.status !== undefined) {
        const accepted = (item.event.data as { accepted?: boolean }).accepted === true
        if (item.event.eventType !== 'action.resolved' || (accepted ? 'accepted' : 'rejected') !== query.status) return false
      }
      if (search !== undefined && !JSON.stringify(item).toLocaleLowerCase().includes(search)) return false
      return true
    })
    const limit = query.limit ?? 50
    const page = items.slice(0, limit)
    return { ...snapshot, items: page, hasMore: items.length > limit, nextAfterSeq: items.length > limit ? page.at(-1)!.event.seq : snapshot.headSeq }
  },
  async records(query = {}) {
    await wait()
    const search = query.search?.toLocaleLowerCase()
    const filtered = MOCK_RECORDS.filter(record =>
      (query.characterId === undefined || record.characterId === query.characterId)
      && (query.kind === undefined || record.kind === query.kind)
      && (query.decisionId === undefined || record.decisionId === query.decisionId)
      && (query.status === undefined || record.summary.status === query.status)
      && (search === undefined || JSON.stringify(record).toLocaleLowerCase().includes(search)))
    const offset = query.offset ?? 0, limit = query.limit ?? 50
    const page = filtered.slice(offset, offset + limit).map(({ data: _data, ...summary }) => summary)
    return { scope: mockHistory().scope!, captureEnabled: true, storageError: null, branches: ['main', 'candidate-0'], items: page, total: filtered.length,
      nextOffset: offset + page.length, hasMore: offset + page.length < filtered.length,
      record: MOCK_RECORDS.find(record => record.id === query.recordId) ?? null,
      limitations: ['预览数据；未连接真实实例。'] }
  },
  async setCapture() { await wait() },
}

export function creatorSource(instanceId: string): CreatorSource {
  if (!isTauri()) return previewSource
  return {
    preview: false,
    debug: query => inspectCreator(instanceId, query),
    history: query => inspectCreatorHistory(instanceId, query),
    records: query => inspectCreatorRecords(instanceId, query),
    async setCapture(enabled) { await inspectRequests(instanceId, enabled) },
  }
}
