// Storage extension installed explicitly in disposable worlds based on schema 21.
import type { DatabaseSync } from 'node:sqlite'
import { hashWorldJson, type WorldHash, type WorldJsonObject } from '@perspectra/sdk/contracts'
import { readPragmaInteger, WORLD_APPLICATION_ID } from './sqlite.ts'

const REGISTRATION_ONLY_VERSION = 21001
export const POSTING_ONLY_VERSION = 21002
export const NOTICE_SCHEMA_VERSION = 21003
const noticeVersions = [REGISTRATION_ONLY_VERSION, POSTING_ONLY_VERSION, NOTICE_SCHEMA_VERSION]
export type NoticeProposal = WorldJsonObject & {
  readonly commission?: 'signup'
  readonly text: string
  readonly calendarRule: string
  readonly day: number
  readonly slot: string
}
export interface NoticeReceipt extends WorldJsonObject {
  registrationId: string
  requestId: string
  metadataSeq: number
  afterWorldSeq: number
  afterEventHash: string
  baseline: { day: number; slot: string }
  calendar: { dayKey: string; slotKey: string; slots: readonly string[] }
  location: string
  proposal: NoticeProposal
}
export interface NoticeCursor extends WorldJsonObject {
  addressKey: string
  eventHash: string
  metadataSeq: number
  catalogHash: WorldHash
}

function hasNoticeTable(db: DatabaseSync) {
  return !!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='experimental_pending_notices'").get()
}
export function supportsNoticeSchema(db: DatabaseSync, version: number): boolean {
  return noticeVersions.includes(version) && hasNoticeTable(db)
}

export function noticeStorageEnabled(db: DatabaseSync): boolean {
  const version = readPragmaInteger(db, 'user_version')
  if (noticeVersions.includes(version)) {
    if (readPragmaInteger(db, 'application_id') === WORLD_APPLICATION_ID && supportsNoticeSchema(db, version))
      return true
    throw new Error('告示实验存档缺少格式标识或登记表。')
  }
  if (hasNoticeTable(db) && db.prepare('SELECT 1 FROM experimental_pending_notices LIMIT 1').get())
    throw new Error('未标记版本的告示实验存档需要单独处理。')
  return false
}

// A logical fork stores its own suffix of game events. Resolve its frozen inherited prefix too.
function eventHashAt(db: DatabaseSync, key: string, seq: number): string {
  if (seq === 0) return 'genesis'
  const row = db
    .prepare(
      `WITH RECURSIVE lineage(address_key,parent_address_key,fork_seq) AS (
    SELECT address_key,parent_address_key,fork_seq FROM branches WHERE address_key=?
    UNION
    SELECT b.address_key,b.parent_address_key,b.fork_seq FROM branches b JOIN lineage l
      ON b.address_key=l.parent_address_key WHERE ? <= l.fork_seq)
    SELECT event_hash FROM events JOIN lineage USING(address_key) WHERE seq=?`,
    )
    .get(key, seq, seq)
  if (!row) throw new Error('告示定位的世界事件不存在。')
  return String(row.event_hash)
}

export function noticeReceipts(db: DatabaseSync, key: string, headSeq: number): NoticeReceipt[] {
  const rows = db
    .prepare(
      'SELECT metadata_seq, world_seq, request_id, receipt_json FROM experimental_pending_notices WHERE address_key=? ORDER BY metadata_seq',
    )
    .all(key)
  const version = readPragmaInteger(db, 'user_version')
  let previousAnchor = 0,
    previousHash = 'genesis'
  return rows.map((row, index) => {
    const receipt = JSON.parse(String(row.receipt_json)) as NoticeReceipt
    if (
      receipt.proposal &&
      Object.hasOwn(receipt.proposal, 'commission') &&
      (version !== NOTICE_SCHEMA_VERSION || receipt.proposal.commission !== 'signup')
    )
      throw new Error('告示委托与存档格式不一致。')
    const anchor = Number(row.world_seq)
    if (
      typeof receipt.registrationId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(receipt.registrationId) ||
      row.metadata_seq !== index + 1 ||
      receipt.metadataSeq !== row.metadata_seq ||
      receipt.requestId !== row.request_id ||
      receipt.afterWorldSeq !== anchor ||
      anchor < previousAnchor ||
      anchor > headSeq
    )
      throw new Error('告示登记序号或世界前缀不一致。')
    if (anchor !== previousAnchor) previousHash = eventHashAt(db, key, anchor)
    if (receipt.afterEventHash !== previousHash) throw new Error('告示登记与世界事件摘要不一致。')
    previousAnchor = anchor
    return receipt
  })
}

/** Read a reachable game/metadata cut. At a shared game head there can be several valid cuts. */
export function noticeCursorAt(db: DatabaseSync, key: string, worldSeq: number, metadataSeq?: number): NoticeCursor {
  const head = db.prepare('SELECT head_seq,event_hash FROM heads WHERE address_key=?').get(key)
  if (!head || !Number.isSafeInteger(worldSeq) || worldSeq < 0 || worldSeq > Number(head.head_seq))
    throw new Error('告示游标的世界序号越界。')
  const receipts = noticeReceipts(db, key, Number(head.head_seq))
  const count = metadataSeq ?? receipts.length
  if (
    !Number.isSafeInteger(count) ||
    count < 0 ||
    count > receipts.length ||
    (count > 0 && Number(receipts[count - 1]!.afterWorldSeq) > worldSeq) ||
    (count < receipts.length && Number(receipts[count]!.afterWorldSeq) < worldSeq)
  )
    throw new Error('告示游标的两个前缀不能同时成立。')
  const eventHash = eventHashAt(db, key, worldSeq)
  if (worldSeq === head.head_seq && eventHash !== head.event_hash) throw new Error('告示游标与世界头摘要不一致。')
  return {
    addressKey: key,
    eventHash,
    metadataSeq: count,
    catalogHash: hashWorldJson('notice-catalog', receipts.slice(0, count)),
  }
}
export function assertNoticeCursor(expected: NoticeCursor, actual: NoticeCursor): void {
  if (
    !expected ||
    Object.keys(expected).length !== 4 ||
    expected.addressKey !== actual.addressKey ||
    expected.eventHash !== actual.eventHash ||
    expected.metadataSeq !== actual.metadataSeq ||
    expected.catalogHash !== actual.catalogHash
  )
    throw new Error('告示游标与有效分支前缀不一致。')
}

/** Historical callers must disambiguate same-head registrations; a drained latest-head fork takes all of them. */
export function resolveForkNoticeCursor(
  db: DatabaseSync,
  key: string,
  worldSeq: number,
  requested?: NoticeCursor | 'latest',
): NoticeCursor | undefined {
  if (!noticeStorageEnabled(db)) {
    if (requested && requested !== 'latest') throw new Error('此存档没有告示游标。')
    return undefined
  }
  if (requested === 'latest') return noticeCursorAt(db, key, worldSeq)
  if (requested) {
    const actual = noticeCursorAt(db, key, worldSeq, requested.metadataSeq)
    assertNoticeCursor(requested, actual)
    return actual
  }
  const counts = db
    .prepare(
      'SELECT COUNT(*) AS through, COUNT(*) FILTER (WHERE world_seq=?) AS at_cut FROM experimental_pending_notices WHERE address_key=? AND world_seq<=?',
    )
    .get(worldSeq, key, worldSeq)!
  if (counts.at_cut) throw new Error('同一游戏头有多种告示前缀，分叉需要明确的告示游标。')
  return noticeCursorAt(db, key, worldSeq, Number(counts.through))
}

/** A fork must not expose a personal observation without the posting or reading that authorized it. */
export function assertNoticeForkBoundary(db: DatabaseSync, transactionId: string, forkSeq: number) {
  const split = db
    .prepare(
      `SELECT 1 FROM round_commits c JOIN round_authority a USING(transaction_id)
    WHERE c.transaction_id=? AND c.head_seq>? AND json_extract(a.authority_json,'$.source')='host.world-events/v1'
      AND (json_type(a.authority_json,'$.noticePostings')='array' OR json_type(a.authority_json,'$.noticeRead')='object')`,
    )
    .get(transactionId, forkSeq)
  if (split) throw new Error('不可在告示张贴或阅读事务中间分叉。')
}
