// Internal persistence experiment. Only disposable test saves install its table.
import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { committedStatusTruth } from '@perspectra/core'
import { openWorldDatabase, rollbackAndThrow, WorldStore, worldJsonText } from '@perspectra/core/store'
import type { EventBook } from '@perspectra/sdk'
import {
  hashWorldJson,
  worldAddressKey,
  type WorldAddress,
  type WorldHash,
  type WorldJsonObject,
} from '@perspectra/sdk/contracts'

export interface NoticeProposal extends WorldJsonObject {
  readonly text: string
  readonly calendarRule: string
  readonly day: number
  readonly slot: string
}
interface NoticeTarget {
  candidate: WorldHash
  worldVersion: string
  headSeq: number
  eventHash: string
  catalogHash: WorldHash
}
export interface NoticeRegistration {
  expected: NoticeTarget
  requestId: string
  proposal: NoticeProposal
}
interface Receipt extends WorldJsonObject {
  requestId: string
  metadataSeq: number
  afterWorldSeq: number
  afterEventHash: string
  baseline: { day: number; slot: string }
  calendar: { dayKey: string; slotKey: string; slots: readonly string[] }
  location: string
  proposal: NoticeProposal
}
interface Scope {
  directory: string
  address: WorldAddress
  worldVersion: string
  rules: EventBook | undefined
}
function hasExperiment(db: DatabaseSync): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='experimental_pending_notices'").get()
}

function catalog(db: DatabaseSync, scope: Scope) {
  const key = worldAddressKey(scope.address)
  const head = db.prepare('SELECT head_seq, event_hash FROM heads WHERE address_key=?').get(key)
  if (!head) throw new Error('告示目标分支不存在')
  const rows = hasExperiment(db)
    ? db
        .prepare('SELECT receipt_json FROM experimental_pending_notices WHERE address_key=? ORDER BY metadata_seq')
        .all(key)
    : []
  const notices: Receipt[] = rows.map(row => JSON.parse(String(row.receipt_json)) as Receipt)
  const target: NoticeTarget = {
    candidate: hashWorldJson('notice-candidate', [realpathSync(scope.directory), key]),
    worldVersion: scope.worldVersion,
    headSeq: Number(head.head_seq),
    eventHash: String(head.event_hash),
    catalogHash: hashWorldJson('notice-catalog', notices),
  }
  return { target, notices }
}

export function readNoticeCatalog(scope: Scope) {
  const db = openWorldDatabase(join(scope.directory, 'world.sqlite'))
  try {
    db.exec('BEGIN')
    const result = catalog(db, scope)
    db.exec('COMMIT')
    return result
  } finally {
    db.close()
  }
}

export function registerNotice(scope: Scope, request: NoticeRegistration): Receipt {
  const { requestId, proposal, expected } = request
  if (typeof requestId !== 'string' || !/^[a-zA-Z0-9:_-]{1,128}$/.test(requestId))
    throw new TypeError('无效告示请求 ID')
  if (
    !proposal ||
    Object.keys(proposal).some(key => !['text', 'calendarRule', 'day', 'slot'].includes(key)) ||
    typeof proposal.text !== 'string' ||
    !proposal.text.trim() ||
    proposal.text.length > 2000 ||
    !Number.isSafeInteger(proposal.day) ||
    proposal.day < 0 ||
    typeof proposal.slot !== 'string' ||
    typeof proposal.calendarRule !== 'string'
  )
    throw new TypeError('无效告示定义')
  const path = join(scope.directory, 'world.sqlite'),
    store = new WorldStore(path)
  try {
    // Read the immutable game prefix before taking the SQLite writer lock.
    const base = store.head(scope.address)
    const rule = scope.rules?.rules.find(rule => rule.id === proposal.calendarRule)
    const clock = rule?.crossesPackTime
    const truth = committedStatusTruth(store.readEventsRange(scope.address, 0, base.headSeq, ['status.updated'])).public
    const db = openWorldDatabase(path)
    try {
      db.exec('BEGIN IMMEDIATE')
      try {
        if (!hasExperiment(db)) throw new Error('此存档没有启用告示持久化实验')
        const { target, notices } = catalog(db, scope)
        if (target.candidate !== expected.candidate) throw new Error('告示目标候选已改变')
        const prior = notices.find(row => row.requestId === requestId)
        if (prior) {
          if (worldJsonText(prior.proposal) !== worldJsonText(proposal)) throw new Error('同一告示请求 ID 不能改变内容')
          db.exec('COMMIT')
          return prior
        }
        store.assertAdmissionOpen(scope.address, requestId)
        if (
          expected.worldVersion !== target.worldVersion ||
          expected.headSeq !== target.headSeq ||
          base.eventHash !== target.eventHash ||
          expected.eventHash !== target.eventHash ||
          expected.catalogHash !== target.catalogHash
        )
          throw new Error('告示预检前缀已过期')
        if (!rule || !clock) throw new Error('告示需要包内有效的日历规则')
        const day = truth[clock.dayKey],
          slot = truth[clock.slotKey]
        if (
          typeof day !== 'number' ||
          !Number.isSafeInteger(day) ||
          day < 0 ||
          typeof slot !== 'string' ||
          !clock.slots.includes(slot) ||
          !clock.slots.includes(proposal.slot)
        )
          throw new Error('告示日历无效')
        if (
          proposal.day < day ||
          (proposal.day === day && clock.slots.indexOf(proposal.slot) <= clock.slots.indexOf(slot))
        )
          throw new Error('告示必须安排在未来')
        const receipt: Receipt = {
          requestId,
          metadataSeq: (notices.at(-1)?.metadataSeq ?? 0) + 1,
          afterWorldSeq: target.headSeq,
          afterEventHash: target.eventHash,
          baseline: { day, slot },
          calendar: { dayKey: clock.dayKey, slotKey: clock.slotKey, slots: clock.slots },
          location: rule.location,
          proposal,
        }
        db.prepare(
          'INSERT INTO experimental_pending_notices(address_key, metadata_seq, world_seq, request_id, receipt_json) VALUES (?,?,?,?,?)',
        ).run(worldAddressKey(scope.address), receipt.metadataSeq, target.headSeq, requestId, worldJsonText(receipt))
        db.exec('COMMIT')
        return receipt
      } catch (error) {
        rollbackAndThrow(db, error)
      }
    } finally {
      db.close()
    }
  } finally {
    store.close()
  }
}
