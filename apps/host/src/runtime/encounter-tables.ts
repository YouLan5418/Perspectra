import { isJsonObject, type WorldJsonObject } from '@perspectra/sdk/contracts'
import type { ActivityHooks } from '@perspectra/sdk'
import { acceptsVariableValue, type EditorVariable, type Scalar } from '@perspectra/world-pack/editor-fields'

export interface TableCatalog {
  locations: { id: string; name: string }[]
  variables: (Pick<EditorVariable, 'key' | 'label' | 'type' | 'options'> & { writable: boolean })[]
  events: { id: string; label: string; paced: boolean }[]
}
export interface TableCondition {
  key: string
  op: 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte'
  value: Scalar
}
export interface TableRow {
  key: string
  kind: 'encounter' | 'quest'
  title: string
  text?: string
  location?: string
  conditions?: TableCondition[]
  weight?: number
  event?: string
  completeEvent?: string
  rewardKey?: string
  reward?: number
  duration?: number
  limit?: number
}
export interface EncounterTable {
  key: string
  title: string
  clockKey?: string
  rows: TableRow[]
}
const comparisons = { eq: '=', ne: '≠', lt: '<', lte: '≤', gt: '>', gte: '≥' }
const identifier = /^[a-z][a-z0-9-]{0,32}$/u
function object(value: unknown, fields: string[], path: string): Record<string, unknown> {
  if (!isJsonObject(value)) throw new TypeError(path + ' 需要对象')
  for (const key of Object.keys(value)) if (!fields.includes(key)) throw new TypeError(path + ' 未知字段 ' + key)
  return value
}
function named(raw: Record<string, unknown>, seen: Set<string>, path: string) {
  if (typeof raw.key !== 'string' || !identifier.test(raw.key) || seen.has(raw.key))
    throw new TypeError(path + ' 标识无效或重复')
  if (typeof raw.title !== 'string' || !raw.title.trim() || raw.title.length > 80)
    throw new TypeError(path + ' 需要 1–80 字的名称')
  seen.add(raw.key)
}
function positive(value: unknown) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}
export function parseTables(raw: unknown, catalog: TableCatalog): EncounterTable[] {
  if (!Array.isArray(raw)) throw new TypeError('tables 需要数组')
  const keys = new Set<string>()
  return raw.map((entry, index) => {
    const table = object(entry, ['key', 'title', 'clockKey', 'rows'], '表 ' + (index + 1))
    named(table, keys, '表 ' + (index + 1))
    const varOf = (key: unknown, type: string) => catalog.variables.find(v => v.key === key && v.type === type)
    if (table.clockKey !== undefined && !varOf(table.clockKey, 'number'))
      throw new TypeError(table.title + ' › 期限需要公开的数值变量')
    if (!Array.isArray(table.rows) || !table.rows.length) throw new TypeError(table.title + ' 至少需要一行')
    const rows = new Set<string>()
    let total = 0
    for (const [i, entry] of table.rows.entries()) {
      const path = table.title + ' › 第 ' + (i + 1) + ' 行'
      const row = object(
        entry,
        [
          'key',
          'title',
          'kind',
          'text',
          'location',
          'conditions',
          'weight',
          'event',
          'completeEvent',
          'rewardKey',
          'reward',
          'duration',
          'limit',
        ],
        path,
      )
      named(row, rows, path)
      if (row.kind !== 'encounter' && row.kind !== 'quest') throw new TypeError(path + ' 请选择遭遇或委托')
      if (row.text !== undefined && (typeof row.text !== 'string' || row.text.length > 512))
        throw new TypeError(path + ' 描述最多 512 字')
      if (row.location !== undefined && !catalog.locations.some(l => l.id === row.location))
        throw new TypeError(path + ' 地点不存在')
      if (row.conditions !== undefined) {
        if (!Array.isArray(row.conditions)) throw new TypeError(path + ' 条件需要数组')
        for (const [index, raw] of row.conditions.entries()) {
          const where = path + ' › 条件 ' + (index + 1)
          const c = object(raw, ['key', 'op', 'value'], where)
          const variable = catalog.variables.find(v => v.key === c.key)
          if (!variable || !acceptsVariableValue(variable, c.value))
            throw new TypeError(where + ' 请核对公开变量、类型和枚举取值：' + c.key)
          if (
            typeof c.op !== 'string' ||
            !Object.hasOwn(comparisons, c.op) ||
            (variable.type !== 'number' && c.op !== 'eq' && c.op !== 'ne')
          )
            throw new TypeError(where + ' 比较方式与变量类型不匹配')
        }
      }
      for (const key of ['weight', 'limit', 'reward', 'duration'])
        if (row[key] !== undefined && !positive(row[key])) throw new TypeError(path + ' › ' + key + ' 需要正整数')
      total += Number(row.weight ?? 1)
      if (total > 1000) throw new TypeError(path + ' 总权重超过官方骰子的 1000 面上限')
      if (
        (row.duration !== undefined && (!table.clockKey || row.kind !== 'quest')) ||
        (row.completeEvent !== undefined && row.kind !== 'quest')
      )
        throw new TypeError(path + ' 期限需要委托和计时变量，完成事件仅适用于委托')
      for (const field of ['event', 'completeEvent'])
        if (row[field] !== undefined && !catalog.events.some(e => e.id === row[field]))
          throw new TypeError(path + ' 世界事件不存在或尚未加入节拍器：' + row[field])
      if (row.rewardKey !== undefined || row.reward !== undefined)
        if (!varOf(row.rewardKey, 'number')?.writable || !positive(row.reward))
          throw new TypeError(path + ' 请选择可写公共数值变量并填写奖励数量')
    }
    return entry as EncounterTable
  })
}

export interface TableScene {
  location: string | null
  values: WorldJsonObject
  counts: WorldJsonObject
  events: readonly string[]
}
function witnessed(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}
function meetsCondition(actual: unknown, { op, value }: TableCondition) {
  if (typeof actual !== typeof value) return false
  if (op === 'eq') return actual === value
  if (op === 'ne') return actual !== value
  if (typeof actual !== 'number' || typeof value !== 'number') return false
  switch (op) {
    case 'lt':
      return actual < value
    case 'lte':
      return actual <= value
    case 'gt':
      return actual > value
    case 'gte':
      return actual >= value
  }
}
export function tableCandidates(table: EncounterTable, catalog: TableCatalog, scene: TableScene) {
  const rows = table.rows.map(row => {
    const reasons: string[] = [],
      matches: string[] = []
    if (row.location)
      (scene.location === row.location ? matches : reasons).push(
        '需要地点：' + catalog.locations.find(l => l.id === row.location)?.name,
      )
    for (const c of row.conditions ?? []) {
      const variable = catalog.variables.find(v => v.key === c.key)!
      const actual = scene.values[c.key]
      const display = (v: unknown) => (v === true ? '是' : v === false ? '否' : v === undefined ? '未指定' : String(v))
      ;(meetsCondition(actual, c) ? matches : reasons).push(
        variable.label + ' ' + comparisons[c.op] + ' ' + display(c.value) + '（当前：' + display(actual) + '）',
      )
    }
    if (row.event) {
      if (scene.events.includes(row.event)) matches.push('已见证：' + row.event)
      else reasons.push('尚未见证事件：' + row.event)
    }
    if (row.duration && !Number.isSafeInteger(scene.values[table.clockKey!])) reasons.push('缺少期限使用的计时值')
    const used = Object.hasOwn(scene.counts, row.key) ? Number(scene.counts[row.key]) : 0
    if (row.limit && used >= row.limit) reasons.push('出现次数已用完')
    else if (row.limit) matches.push('剩余 ' + (row.limit - used) + ' 次')
    return { key: row.key, title: row.title, weight: row.weight ?? 1, reasons, matches, used }
  })
  return { rows, total: rows.reduce((n, r) => n + (r.reasons.length ? 0 : r.weight), 0) }
}
const obj = (v: unknown): WorldJsonObject => (isJsonObject(v) ? (v as WorldJsonObject) : {})
export const tableOperations = {
  draw: '抽取候选',
  accept: '接受委托',
  claim: '交付委托',
  discard: '放弃本次委托',
  leave: '离开',
}
export const tablePhases = ['choice', 'ended'] as const
export function tableActivity(table: EncounterTable, catalog: TableCatalog): ActivityHooks {
  function available(scene: TableScene, ledger: WorldJsonObject) {
    const row = table.rows.find(r => r.key === ledger.pending)
    if (!row) return tableCandidates(table, catalog, scene).total ? ['draw', 'leave'] : ['leave']
    if (ledger.accepted !== true)
      return [
        ...(!row.duration || Number.isSafeInteger(scene.values[table.clockKey!]) ? ['accept'] : []),
        'discard',
        'leave',
      ]
    const clock = table.clockKey ? scene.values[table.clockKey] : undefined
    const timely =
      ledger.until === null || (typeof clock === 'number' && typeof ledger.until === 'number' && clock <= ledger.until)
    return [
      ...(timely && (!row.completeEvent || scene.events.includes(row.completeEvent)) ? ['claim'] : []),
      'discard',
      'leave',
    ]
  }
  return {
    phases: tablePhases,
    definition: {
      title: table.title,
      npcIds: [],
      readsScene: true,
      readsStatus: true,
      operations: Object.entries(tableOperations).map(([id, label]) => ({
        id,
        label,
        requiresTurn: true,
        schema: { type: 'object', properties: {}, additionalProperties: false },
      })),
    },
    initialize(input) {
      const prior = obj(obj(obj(input.previous).game).private)
      return {
        active: true,
        turn: input.playerId!,
        phase: 'choice',
        round: 1,
        public: { statusText: typeof prior.note === 'string' ? prior.note : table.title },
        private: { [String(input.playerId)]: prior },
        internal: {},
      }
    },
    policy(view) {
      const ledger = obj(obj(view.game).private)
      return {
        speech: 'free',
        speechChoices: [],
        narration: true,
        move: true,
        interactions: [],
        operations: available(
          {
            location: String(obj(view.scene).locationId ?? ''),
            values: obj(view.knownPublic),
            counts: obj(ledger.counts),
            events: witnessed(view.witnessedEvents),
          },
          ledger,
        ),
      }
    },
    resolve(state, actor, op, _params, world, truth, roll) {
      const ledger = { ...obj(state.game.private[actor]) },
        counts = { ...obj(ledger.counts) }
      const scene = {
        location: String(world.locationId ?? ''),
        values: truth?.public ?? {},
        counts,
        events: witnessed(world.witnessedEvents),
      }
      if (!available(scene, ledger).includes(op)) return { rejectReason: '候选、期限或交付条件已改变。' }
      let row = table.rows.find(r => r.key === ledger.pending),
        note = '',
        reward = false
      if (op === 'draw') {
        const pool = tableCandidates(table, catalog, scene)
        if (pool.total > 1 && !roll) throw new TypeError('抽取需要骰子服务')
        let face = pool.total === 1 ? 1 : roll!('d' + pool.total).total
        const picked = pool.rows.find(r => !r.reasons.length && (face -= r.weight) <= 0)!
        row = table.rows.find(r => r.key === picked.key)!
        counts[row.key] = picked.used + 1
        ledger.counts = counts
        note = row.title + (row.text ? '。' + row.text : '')
        if (row.kind === 'quest') {
          ledger.pending = row.key
          ledger.accepted = false
          note += '（待接受）'
        } else reward = true
      } else if (op === 'accept') {
        ledger.accepted = true
        ledger.until = row!.duration ? Number(scene.values[table.clockKey!]) + row!.duration : null
        if (ledger.until !== null && !Number.isSafeInteger(ledger.until))
          return { rejectReason: '计时变量超过有效数字范围' }
        note =
          '已接受：' +
          row!.title +
          (ledger.until === null
            ? ''
            : '。交付期限：' + catalog.variables.find(v => v.key === table.clockKey)!.label + ' ≤ ' + ledger.until)
      } else if (op === 'claim' || op === 'discard') {
        reward = op === 'claim'
        note = (reward ? '已交付：' : '已放弃：') + row!.title
        delete ledger.pending
        delete ledger.accepted
        delete ledger.until
      } else note = '已离开' + table.title
      const changes = []
      if (reward && row?.rewardKey) {
        const old = scene.values[row.rewardKey],
          next = typeof old === 'number' ? old + row.reward! : NaN
        if (!Number.isFinite(next)) return { rejectReason: '奖励变量没有有效数值' }
        changes.push({ holderId: null, key: row.rewardKey, value: next })
        note += '。' + catalog.variables.find(v => v.key === row.rewardKey)!.label + ' +' + row.reward
      }
      if (op !== 'leave') ledger.note = note
      const active = op !== 'leave'
      return {
        game: {
          ...state.game,
          active,
          turn: active ? actor : null,
          phase: active ? 'choice' : 'ended',
          round: state.game.round + 1,
          public: { statusText: note },
          private: { [actor]: ledger },
        },
        description: note,
        audience: 'self',
        ...(changes.length ? { status: { changes, reveals: [] } } : {}),
      }
    },
    schedule: () => ({ kind: 'wait' }),
    onOutcome: () => ({ kind: 'wait' }),
  }
}
