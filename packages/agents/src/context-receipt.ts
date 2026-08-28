import { DatabaseSync } from 'node:sqlite'
import {
  brandId,
  canonicalizeWorldJson,
  deterministicId,
  failWorld,
  hashContextReceipt,
  hashWorldJson,
  worldAddressKey,
  type CharacterId,
  type ContextExclusion,
  type ContextParticipantKind,
  type ContextReceipt,
  type ContextReceiptInput,
  type ContextSourceRef,
  type ContextVersionLocks,
  type ContextComponentHashes,
  type ContextProfileId,
  type InteractionRoundId,
  type WorldAddress,
  type WorldHash,
} from '@harness-world/contracts'

const RECEIPT_SCHEMA = `
CREATE TABLE IF NOT EXISTS context_receipts (
  receipt_id TEXT PRIMARY KEY,
  namespace_key TEXT NOT NULL,
  round_id TEXT NOT NULL,
  participant_id TEXT NOT NULL,
  receipt_json TEXT NOT NULL,
  receipt_hash TEXT NOT NULL,
  UNIQUE(namespace_key, round_id, participant_id)
);
CREATE INDEX IF NOT EXISTS context_receipts_round
  ON context_receipts(namespace_key, round_id, participant_id);
`

export interface CreateContextReceiptRequest {
  readonly address: WorldAddress
  readonly roundId: InteractionRoundId
  readonly participantKind: ContextParticipantKind
  readonly participantId: string
  readonly subjectCharacterId: CharacterId | null
  readonly controllerId: string
  readonly controllerEpoch: number
  readonly baseHeadSeq: number
  readonly asOfWorldSeq: number
  readonly tick: number
  readonly manifestHash: WorldHash
  readonly contextProfileId: ContextProfileId
  readonly contextProfileHash: WorldHash
  readonly versionLocks: ContextVersionLocks
  readonly componentHashes: ContextComponentHashes
  readonly includedSourceRefs: readonly ContextSourceRef[]
  readonly exclusions: readonly ContextExclusion[]
  readonly contextHash: WorldHash
  readonly providerRequestHash: WorldHash
}

export type ContextExplainAudience = 'admin' | 'author' | 'player'

export interface PrivilegedContextExplainReport {
  readonly schemaVersion: 'context-explain/v1'
  readonly audience: 'admin' | 'author'
  readonly receiptId: string
  readonly verified: true
  readonly address: WorldAddress
  readonly roundId: InteractionRoundId
  readonly participantId: string
  readonly subjectCharacterId: CharacterId | null
  readonly asOfWorldSeq: number
  readonly componentHashes: ContextComponentHashes
  readonly includedSourceRefs: readonly ContextSourceRef[]
  readonly exclusions: readonly ContextExclusion[]
  readonly contextHash: WorldHash
  readonly providerRequestHash: WorldHash
}

export interface PlayerContextExplainReport {
  readonly schemaVersion: 'context-explain-player/v1'
  readonly audience: 'player'
  readonly receiptId: string
  readonly verified: true
  readonly roundId: InteractionRoundId
  readonly asOfWorldSeq: number
  readonly contextHash: WorldHash
  readonly providerRequestHash: WorldHash
}

export type ContextExplainReport = PrivilegedContextExplainReport | PlayerContextExplainReport

function compareText(left: string, right: string): number {
  return Number(left > right) - Number(left < right)
}

function sourceHash(source: ContextSourceRef): WorldHash {
  return hashWorldJson('context-source-ref/v1', source)
}

function normalizedSources(sources: readonly ContextSourceRef[]): ContextSourceRef[] {
  const keyed = new Map<WorldHash, ContextSourceRef>()
  for (const source of sources) keyed.set(sourceHash(source), source)
  return [...keyed.values()].sort((left, right) => left.sourceSeq - right.sourceSeq
    || compareText(left.sourceKind, right.sourceKind) || compareText(left.sourceId, right.sourceId))
}

function normalizedExclusions(exclusions: readonly ContextExclusion[]): ContextExclusion[] {
  return [...exclusions].sort((left, right) => compareText(left.reason, right.reason)
    || compareText(left.sourceRefHash ?? '', right.sourceRefHash ?? ''))
}

function jsonText(receipt: ContextReceipt): string {
  return Buffer.from(canonicalizeWorldJson(receipt)).toString('utf8')
}

function validateWatermarks(request: CreateContextReceiptRequest): void {
  for (const [name, value] of [
    ['controllerEpoch', request.controllerEpoch], ['baseHeadSeq', request.baseHeadSeq],
    ['asOfWorldSeq', request.asOfWorldSeq], ['tick', request.tick],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative safe integer`)
  }
  if (request.baseHeadSeq > request.asOfWorldSeq) throw new RangeError('baseHeadSeq cannot be later than asOfWorldSeq')
  if (request.participantKind === 'character' && request.subjectCharacterId === null) {
    throw new TypeError('Character receipt requires subjectCharacterId')
  }
  if (request.participantKind === 'director' && request.subjectCharacterId !== null) {
    throw new TypeError('Director receipt cannot have subjectCharacterId')
  }
  for (const source of request.includedSourceRefs) {
    if (source.sourceSeq > request.asOfWorldSeq) throw new RangeError('Context receipt cannot include a future source')
  }
}

/** Construct the deterministic receipt identity after semantic and exact-request hashes are known. */
export function createContextReceipt(request: CreateContextReceiptRequest): ContextReceipt {
  validateWatermarks(request)
  const includedSourceRefs = normalizedSources(request.includedSourceRefs)
  const exclusions = normalizedExclusions(request.exclusions)
  const identity = {
    address: request.address, roundId: request.roundId, participantKind: request.participantKind,
    participantId: request.participantId, controllerId: request.controllerId,
    controllerEpoch: request.controllerEpoch, contextHash: request.contextHash,
    providerRequestHash: request.providerRequestHash,
  }
  const input: ContextReceiptInput = {
    schemaVersion: 'context-receipt/v1',
    receiptId: brandId(deterministicId('context-receipt/v1', identity), 'ContextReceiptId'),
    ...request, includedSourceRefs, exclusions,
  }
  return { ...input, receiptHash: hashContextReceipt(input) }
}

/** Durable append-once Context receipts in the rebuildable Context derivation database. */
export class ContextReceiptStore {
  readonly #db: DatabaseSync

  constructor(path: string) {
    this.#db = new DatabaseSync(path)
    this.#db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;')
    const version = (this.#db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
    if (version < 0 || version > 2) {
      this.#db.close()
      throw new Error(`unsupported Context derivation schema version ${version}`)
    }
    this.#db.exec(RECEIPT_SCHEMA)
    if (version < 2) this.#db.exec('PRAGMA user_version=2')
  }

  append(request: CreateContextReceiptRequest): ContextReceipt {
    const receipt = createContextReceipt(request)
    const text = jsonText(receipt)
    this.#db.prepare(`
      INSERT OR IGNORE INTO context_receipts(
        receipt_id, namespace_key, round_id, participant_id, receipt_json, receipt_hash
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      receipt.receiptId, worldAddressKey(receipt.address), receipt.roundId,
      receipt.participantId, text, receipt.receiptHash,
    )
    const stored = this.#db.prepare(`
      SELECT receipt_json, receipt_hash FROM context_receipts
      WHERE namespace_key = ? AND round_id = ? AND participant_id = ?
    `).get(
      worldAddressKey(receipt.address), receipt.roundId, receipt.participantId,
    ) as { receipt_json: string; receipt_hash: WorldHash }
    if (stored.receipt_json !== text || stored.receipt_hash !== receipt.receiptHash) {
      failWorld({
        errorCode: 'CONTEXT_REBUILD_DIVERGED', category: 'integrity',
        message: 'Context receipt diverged for the same deterministic identity', retryable: false,
        correlationId: `context-receipt:${receipt.receiptId}`, address: receipt.address, roundId: receipt.roundId,
      })
    }
    return receipt
  }

  read(receiptId: string): ContextReceipt | undefined {
    const row = this.#db.prepare(`
      SELECT namespace_key, receipt_json, receipt_hash FROM context_receipts WHERE receipt_id = ?
    `).get(receiptId) as { namespace_key: string; receipt_json: string; receipt_hash: WorldHash } | undefined
    if (row === undefined) return undefined
    const receipt = JSON.parse(row.receipt_json) as ContextReceipt
    this.#verify(receipt, row.namespace_key, row.receipt_hash)
    return receipt
  }

  listRound(address: WorldAddress, roundId: InteractionRoundId): readonly ContextReceipt[] {
    const rows = this.#db.prepare(`
      SELECT receipt_id FROM context_receipts
      WHERE namespace_key = ? AND round_id = ? ORDER BY participant_id, receipt_id
    `).all(worldAddressKey(address), roundId) as Array<{ receipt_id: string }>
    return rows.map(row => this.read(row.receipt_id)!)
  }

  reset(address: WorldAddress): void {
    this.#db.prepare('DELETE FROM context_receipts WHERE namespace_key = ?').run(worldAddressKey(address))
  }

  close(): void {
    this.#db.close()
  }

  #verify(receipt: ContextReceipt, namespaceKey: string, columnHash: WorldHash): void {
    const { receiptHash: _receiptHash, ...input } = receipt
    if (receipt.receiptHash !== hashContextReceipt(input) || receipt.receiptHash !== columnHash
      || worldAddressKey(receipt.address) !== namespaceKey) {
      throw new Error(`Context receipt ${receipt.receiptId} failed durable verification`)
    }
  }
}

/** Explain only durable provenance. It never attempts to explain a model's internal reasoning. */
export class ContextExplainService {
  constructor(private readonly receipts: ContextReceiptStore) {}

  explain(receiptId: string, audience: ContextExplainAudience, requesterCharacterId?: CharacterId): ContextExplainReport {
    const receipt = this.receipts.read(receiptId)
    if (receipt === undefined) throw new Error(`Context receipt ${receiptId} does not exist`)
    if (audience === 'player') {
      if (requesterCharacterId === undefined || receipt.subjectCharacterId !== requesterCharacterId) {
        failWorld({
          errorCode: 'UNAUTHORIZED', category: 'admission',
          message: 'Player cannot explain another participant Context', retryable: false,
          correlationId: `context-explain:${receiptId}`, address: receipt.address, roundId: receipt.roundId,
        })
      }
      return {
        schemaVersion: 'context-explain-player/v1', audience: 'player', receiptId: receipt.receiptId,
        verified: true, roundId: receipt.roundId, asOfWorldSeq: receipt.asOfWorldSeq,
        contextHash: receipt.contextHash, providerRequestHash: receipt.providerRequestHash,
      }
    }
    return {
      schemaVersion: 'context-explain/v1', audience, receiptId: receipt.receiptId, verified: true,
      address: receipt.address, roundId: receipt.roundId, participantId: receipt.participantId,
      subjectCharacterId: receipt.subjectCharacterId, asOfWorldSeq: receipt.asOfWorldSeq,
      componentHashes: receipt.componentHashes, includedSourceRefs: receipt.includedSourceRefs,
      exclusions: receipt.exclusions, contextHash: receipt.contextHash,
      providerRequestHash: receipt.providerRequestHash,
    }
  }

  rebuild(request: CreateContextReceiptRequest): ContextReceipt {
    return this.receipts.append(request)
  }

  verify(receiptId: string): { readonly receiptId: string; readonly verified: true; readonly receiptHash: WorldHash } {
    const receipt = this.receipts.read(receiptId)
    if (receipt === undefined) throw new Error(`Context receipt ${receiptId} does not exist`)
    return { receiptId, verified: true, receiptHash: receipt.receiptHash }
  }
}
