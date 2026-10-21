import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { worldAddressKey, type WorldAddress, type WorldJsonObject } from '../../packages/contracts/src/index.ts'
import type { InspectedRequest } from '../../packages/provider-chat/src/request-inspector.ts'

export interface CreatorScope { address: WorldAddress; worldVersion: string; branchId: string; runId: string }
export interface CreatorRecord {
  id: string
  kind: 'request' | 'decision' | 'action' | 'turn' | 'recall'
  capturedAt: string
  scope: CreatorScope
  characterId: string
  decisionId: string | null
  summary: { label: string; status?: string; model?: string; durationMs?: number }
  data: InspectedRequest | WorldJsonObject
}
export interface CreatorRecordsQuery {
  recordId?: string
  branchId?: string
  characterId?: string
  kind?: CreatorRecord['kind']
  decisionId?: string
  worldVersion?: string
  status?: string
  search?: string
  offset?: number
  limit?: number
}
export interface CreatorRecordsSnapshot {
  scope: CreatorScope
  captureEnabled: boolean
  storageError: string | null
  branches: string[]
  items: Omit<CreatorRecord, 'data'>[]
  total: number
  nextOffset: number
  hasMore: boolean
  record: CreatorRecord | null
  limitations: string[]
}
export function creatorRecordsQuery(value: Record<string, unknown>): CreatorRecordsQuery {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['recordId','branchId','characterId','kind','decisionId','worldVersion','status','search','offset','limit'].includes(key))) throw new TypeError('未知记录查询字段')
  const result: CreatorRecordsQuery = {}
  for (const key of ['recordId','branchId','characterId','decisionId','worldVersion','status','search'] as const) {
    if (value[key] === undefined) continue
    if (typeof value[key] !== 'string' || !value[key].length || value[key].length > 200) throw new TypeError('记录查询字符串无效')
    result[key] = value[key]
  }
  if (result.recordId !== undefined && !/^[a-f0-9-]{36}$/.test(result.recordId)) throw new TypeError('记录标识无效')
  if (value.kind !== undefined) {
    if (!['request','decision','action','turn','recall'].includes(String(value.kind))) throw new TypeError('记录类型无效')
    result.kind = value.kind as CreatorRecord['kind']
  }
  for (const key of ['offset','limit'] as const) {
    if (value[key] === undefined) continue
    const number = typeof value[key] === 'string' && /^\d+$/.test(value[key]) ? Number(value[key]) : value[key]
    if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < (key === 'limit' ? 1 : 0) || key === 'limit' && number > 100) throw new TypeError('记录分页无效')
    result[key] = number
  }
  return result
}

/** Private diagnostic files, outside world authority, snapshots and share exports. */
export class CreatorRecords {
  readonly #directory: string
  readonly #settings: string
  #error: string | null = null
  readonly #root: string
  constructor(root: string, readonly scope: CreatorScope) {
    this.#root = join(root,'creator-debug')
    this.#directory = join(root, 'creator-debug', 'records')
    this.#settings = join(root, 'creator-debug', 'capture.json')
  }
  get error(): string | null { return this.#error }
  captureEnabled(): boolean {
    if (!existsSync(this.#settings)) return false
    const data = this.#read(this.#settings) as { enabled?: unknown }
    if (!data || typeof data.enabled !== 'boolean') throw new Error('创作者采集设置损坏')
    return data.enabled
  }
  configure(enabled: boolean): void {
    mkdirSync(this.#directory, {recursive:true})
    this.#write(this.#settings, {enabled})
  }
  #write(path: string, value: unknown): void {
    const temporary = path + '.tmp'
    writeFileSync(temporary, JSON.stringify(value), {encoding:'utf8', mode:0o600})
    renameSync(temporary, path)
  }
  #read(path: string): unknown {
    try {return JSON.parse(readFileSync(path,'utf8'))} catch {throw new Error('创作者记录损坏或不可读')}
  }
  #ids(path: string): string[] {
    if (!existsSync(path)) return []
    const ids = this.#read(path)
    if (!Array.isArray(ids) || ids.some(id=>typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id))) throw new Error('创作者历史引用损坏')
    return ids
  }
  #branchPath(branchId: string): string {return join(this.#root,'branch-'+encodeURIComponent(branchId)+'.json')}
  snapshotBase(baseId: string): void {
    const ids = new Set(this.#ids(this.#branchPath(this.scope.branchId)))
    if (existsSync(this.#directory)) for (const name of readdirSync(this.#directory).filter(name=>/^[a-f0-9-]{36}\.json$/.test(name))) {
      const record = this.#read(join(this.#directory,name)) as CreatorRecord
      if (record.scope?.branchId === this.scope.branchId) ids.add(record.id)
    }
    if (!ids.size) return
    this.#write(join(this.#root,'base-'+baseId+'.json'),[...ids])
  }
  inheritBase(baseId: string, branchId: string): void {
    const ids = this.#ids(join(this.#root,'base-'+baseId+'.json'))
    if (ids.length) this.#write(this.#branchPath(branchId),ids)
  }
  save(request: InspectedRequest): void {
    this.#save({id:request.recordId,kind:'request',capturedAt:request.startedAt,scope:this.scope,
      characterId:request.characterId,decisionId:request.decisionId ?? null,
      summary:{label:'模型调用',status:request.status,model:request.model,...(request.durationMs === undefined ? {} : {durationMs:request.durationMs})},data:request})
  }
  trace(kind: Exclude<CreatorRecord['kind'],'request'>, characterId: string, decisionId: string | null, data: WorldJsonObject): void {
    this.#save({id:randomUUID(),kind,capturedAt:new Date().toISOString(),scope:this.scope,characterId,decisionId,
      summary:{label:kind,...(typeof data.status === 'string' ? {status:data.status} : {}),
        ...(typeof data.durationMs === 'number' ? {durationMs:data.durationMs} : {})},data})
  }
  #save(record: CreatorRecord): void {
    try {
      mkdirSync(this.#directory, {recursive:true})
      this.#write(join(this.#directory,record.id+'.json'),record)
    } catch {
      // Debug output may fail without invalidating already committed gameplay; expose the gap to creators.
      this.#error = '私有调试记录写入失败；部分调用或轨迹未保存。'
    }
  }
  query(input: CreatorRecordsQuery, enabled: boolean): CreatorRecordsSnapshot {
    const query = creatorRecordsQuery(input as Record<string,unknown>), limit = query.limit ?? 50, offset = query.offset ?? 0
    const items: Omit<CreatorRecord,'data'>[] = [], branches = new Set<string>()
    let selected: CreatorRecord | null = null
    const branchId = query.branchId ?? this.scope.branchId
    const inherited = new Set(this.#ids(this.#branchPath(branchId)))
    const names = existsSync(this.#directory) ? readdirSync(this.#directory).filter(name => /^[a-f0-9-]{36}\.json$/.test(name)) : []
    for (const name of names) {
      const record = this.#read(join(this.#directory,name)) as CreatorRecord
      if (!record || record.id+'.json' !== name || !record.scope || !record.summary || !['request','decision','action','turn','recall'].includes(record.kind)
        || typeof record.characterId !== 'string' || typeof record.capturedAt !== 'string' || !record.data) throw new Error('创作者记录损坏')
      if (worldAddressKey(record.scope.address) !== worldAddressKey(this.scope.address)) continue
      branches.add(record.scope.branchId)
      if (record.scope.branchId !== branchId && !inherited.has(record.id)
        || query.characterId !== undefined && query.characterId !== record.characterId
        || query.kind !== undefined && query.kind !== record.kind
        || query.decisionId !== undefined && query.decisionId !== record.decisionId
        || query.worldVersion !== undefined && query.worldVersion !== record.scope.worldVersion
        || query.status !== undefined && query.status !== record.summary.status
        || query.search !== undefined && !JSON.stringify(record).toLocaleLowerCase().includes(query.search.toLocaleLowerCase())) continue
      if (record.id === query.recordId) selected = record
      const {data: _data,...summary} = record
      items.push(summary)
    }
    items.sort((a,b) => a.capturedAt.localeCompare(b.capturedAt) || a.id.localeCompare(b.id))
    const page = items.slice(offset,offset+limit)
    return {scope:structuredClone(this.scope),captureEnabled:enabled,storageError:this.#error,branches:[...branches].sort(),items:page,total:items.length,
      nextOffset:offset+page.length,hasMore:offset+page.length<items.length,record:selected,
      limitations:['只包含启用采集之后的记录；停止采集不删除已保存记录。',
        'pending 表示未捕获完成；进程中断后不推测成功或失败。',
        '当前候选包含生成起点之前的本地历史引用，原始 scope 保留来源；故事节点分享不包含私有调试记录。',
        '列表按采集时间排列，进行中的记录可能更新；历史检索为本地文件扫描。']}
  }
}
