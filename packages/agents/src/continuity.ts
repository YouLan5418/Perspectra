import { DatabaseSync } from 'node:sqlite'
import {
  brandId,
  canonicalizeWorldJson,
  deterministicId,
  hashContinuityCheckpoint,
  hashInteractionBlock,
  hashInteractionTail,
  hashWorldJson,
  worldAddressKey,
  type CharacterContinuityCheckpoint,
  type CharacterContinuityCheckpointInput,
  type CharacterId,
  type CheckpointCognitionEntry,
  type CheckpointSummaryRef,
  type CognitiveMemoryWatermark,
  type ContextSourceRef,
  type ExtractiveL1Summary,
  type InteractionBlock,
  type InteractionBlockInput,
  type InteractionObservation,
  type InteractionTail,
  type StoredWorldEvent,
  type TransactionId,
  type WorldAddress,
  type WorldHash,
  type WorldJsonObject,
  type WorldJsonValue,
} from '@harness-world/contracts'
import { CognitionProjectionRebuilder, type WorldStore } from '@harness-world/store-sqlite'

const CONTEXT_DERIVATION_SCHEMA = `
CREATE TABLE IF NOT EXISTS continuity_checkpoints (
  checkpoint_id TEXT PRIMARY KEY,
  namespace_key TEXT NOT NULL,
  as_of_seq INTEGER NOT NULL,
  checkpoint_json TEXT NOT NULL,
  checkpoint_hash TEXT NOT NULL,
  UNIQUE(namespace_key, as_of_seq)
);
CREATE INDEX IF NOT EXISTS continuity_checkpoints_prefix
  ON continuity_checkpoints(namespace_key, as_of_seq);
`

export interface ContinuityMemoryReader {
  watermark(address: WorldAddress, characterId: CharacterId): CognitiveMemoryWatermark | undefined
  summaries(address: WorldAddress, characterId: CharacterId): readonly ExtractiveL1Summary[]
}

function compareText(left: string, right: string): number {
  return Number(left > right) - Number(left < right)
}

function contextNamespace(address: WorldAddress, characterId: CharacterId): string {
  return `${worldAddressKey(address)}\u001f${characterId}`
}

function jsonText(value: WorldJsonValue): string {
  return Buffer.from(canonicalizeWorldJson(value)).toString('utf8')
}

function parseJson<T extends WorldJsonValue>(text: string): T {
  return JSON.parse(text) as T
}

function sourceRef(event: StoredWorldEvent): ContextSourceRef {
  return {
    sourceKind: 'world_event', sourceId: `event:${event.seq}`,
    sourceSeq: event.seq, sourceHash: event.eventHash,
  }
}

function isActive(kind: string, value: WorldJsonObject): boolean {
  if (kind === 'subjective-claim') return value.status === 'active'
  if (kind === 'character-goal') return value.status === 'active' || value.status === 'blocked'
  if (kind === 'relationship-attitude' || kind === 'affect-episode' || kind === 'inner-tension') {
    return value.status === 'active'
  }
  if (kind === 'commitment') return value.status === 'active'
  return kind === 'open-loop' && value.status === 'open'
}

function cognitionContent(value: WorldJsonValue): WorldJsonValue {
  if (Array.isArray(value)) return value.map(cognitionContent)
  if (typeof value !== 'object' || value === null) return value
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== 'source' && key !== 'basisRefs')
    .map(([key, child]) => [key, cognitionContent(child)]))
}

function assertSummary(summary: ExtractiveL1Summary): void {
  const { summaryHash: _summaryHash, ...base } = summary
  if (summary.summaryHash !== hashWorldJson('memory-l1-summary/v1', base)) {
    throw new Error(`Memory L1 Summary ${summary.summaryId} hash diverged`)
  }
}

function summaryRef(summary: ExtractiveL1Summary): CheckpointSummaryRef {
  return {
    summaryId: summary.summaryId,
    sourceStartSeq: summary.sourceStartSeq,
    sourceEndSeq: summary.sourceEndSeq,
    summaryHash: summary.summaryHash,
  }
}

function checkpointInput(
  address: WorldAddress,
  characterId: CharacterId,
  asOfWorldSeq: number,
  memoryEpoch: number,
  activeCognition: readonly CheckpointCognitionEntry[],
  summaryRefs: readonly CheckpointSummaryRef[],
): CharacterContinuityCheckpointInput {
  const sourceSeqs = [
    ...activeCognition.map(entry => entry.sourceRef.sourceSeq),
    ...summaryRefs.flatMap(summary => [summary.sourceStartSeq, summary.sourceEndSeq]),
  ]
  const identity = { address, characterId, asOfWorldSeq, memoryEpoch, activeCognition, summaryRefs }
  return {
    schemaVersion: 'continuity-checkpoint/v1',
    checkpointId: brandId(deterministicId('continuity-checkpoint/v1', identity), 'ContinuityCheckpointId'),
    address,
    characterId,
    asOfWorldSeq,
    memoryEpoch,
    sourceStartSeq: sourceSeqs.length === 0 ? asOfWorldSeq : Math.min(...sourceSeqs),
    sourceEndSeq: asOfWorldSeq,
    activeCognition,
    summaryRefs,
  }
}

/** Durable, rebuildable continuity baseline. It references Memory L1 and never invents another summary. */
export class ContinuityCheckpointService {
  readonly #db: DatabaseSync
  readonly #cognition: CognitionProjectionRebuilder

  constructor(
    path: string,
    private readonly world: WorldStore,
    private readonly memory: ContinuityMemoryReader,
  ) {
    this.#db = new DatabaseSync(path)
    this.#db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;')
    const version = (this.#db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
    if (version !== 0 && version !== 1 && version !== 2) {
      this.#db.close()
      throw new Error(`unsupported Context derivation schema version ${version}`)
    }
    this.#db.exec(CONTEXT_DERIVATION_SCHEMA)
    if (version === 0) this.#db.exec('PRAGMA user_version=1')
    this.#cognition = new CognitionProjectionRebuilder(world)
  }

  rebuildAt(address: WorldAddress, characterId: CharacterId, asOfWorldSeq: number): CharacterContinuityCheckpoint {
    if (!Number.isSafeInteger(asOfWorldSeq) || asOfWorldSeq < 0) {
      throw new RangeError('asOfWorldSeq must be a non-negative safe integer')
    }
    const watermark = this.memory.watermark(address, characterId)
    if (watermark === undefined || watermark.verifiedThroughSeq < asOfWorldSeq
      || watermark.capturedThroughSeq < asOfWorldSeq) {
      throw new Error('Cognitive Memory watermark is behind the requested Checkpoint')
    }
    const cognition = this.#cognition.rebuildCharacterAt(address, characterId, asOfWorldSeq)
    const activeCognition = cognition.claims.concat(
      cognition.goals, cognition.relationships, cognition.affects, cognition.innerTensions,
      cognition.commitments, cognition.openLoops,
    )
      .filter(record => isActive(record.kind, record.value as WorldJsonObject))
      .map(record => ({
        kind: record.kind, id: record.id,
        value: cognitionContent(record.value), sourceRef: record.sourceRef,
      }))
      .sort((left, right) => compareText(left.kind, right.kind) || compareText(left.id, right.id))
    const summaries = this.memory.summaries(address, characterId)
      .filter(summary => summary.sourceEndSeq <= asOfWorldSeq)
      .sort((left, right) => left.sourceStartSeq - right.sourceStartSeq)
    summaries.forEach(assertSummary)
    const input = checkpointInput(
      address, characterId, asOfWorldSeq, watermark.memoryEpoch, activeCognition, summaries.map(summaryRef),
    )
    const checkpoint: CharacterContinuityCheckpoint = {
      ...input, checkpointHash: hashContinuityCheckpoint(input),
    }
    const namespace = contextNamespace(address, characterId)
    const existing = this.#db.prepare(`
      SELECT checkpoint_json, checkpoint_hash FROM continuity_checkpoints
      WHERE namespace_key = ? AND as_of_seq = ?
    `).get(namespace, asOfWorldSeq) as { checkpoint_json: string; checkpoint_hash: WorldHash } | undefined
    if (existing !== undefined) {
      if (existing.checkpoint_json !== jsonText(checkpoint) || existing.checkpoint_hash !== checkpoint.checkpointHash) {
        throw new Error('Continuity Checkpoint is divergent for the same character watermark')
      }
      return checkpoint
    }
    this.#db.prepare(`
      INSERT INTO continuity_checkpoints(checkpoint_id, namespace_key, as_of_seq, checkpoint_json, checkpoint_hash)
      VALUES (?, ?, ?, ?, ?)
    `).run(checkpoint.checkpointId, namespace, asOfWorldSeq, jsonText(checkpoint), checkpoint.checkpointHash)
    return checkpoint
  }

  latestAt(address: WorldAddress, characterId: CharacterId, asOfWorldSeq: number): CharacterContinuityCheckpoint | undefined {
    const row = this.#db.prepare(`
      SELECT checkpoint_json FROM continuity_checkpoints
      WHERE namespace_key = ? AND as_of_seq <= ? ORDER BY as_of_seq DESC LIMIT 1
    `).get(contextNamespace(address, characterId), asOfWorldSeq) as { checkpoint_json: string } | undefined
    if (row === undefined) return undefined
    const checkpoint = parseJson<CharacterContinuityCheckpoint>(row.checkpoint_json)
    this.#verifyStored(checkpoint)
    if (worldAddressKey(checkpoint.address) !== worldAddressKey(address)
      || checkpoint.characterId !== characterId || checkpoint.asOfWorldSeq > asOfWorldSeq) {
      throw new Error('Continuity Checkpoint scope diverged from its storage namespace')
    }
    return checkpoint
  }

  reset(address: WorldAddress, characterId: CharacterId): void {
    this.#db.prepare('DELETE FROM continuity_checkpoints WHERE namespace_key = ?')
      .run(contextNamespace(address, characterId))
  }

  close(): void {
    this.#db.close()
  }

  #verifyStored(checkpoint: CharacterContinuityCheckpoint): void {
    const { checkpointHash: _checkpointHash, ...input } = checkpoint
    if (checkpoint.checkpointHash !== hashContinuityCheckpoint(input)) {
      throw new Error(`Continuity Checkpoint ${checkpoint.checkpointId} hash diverged`)
    }
  }
}

function observationFrom(event: StoredWorldEvent, characterId: CharacterId): InteractionObservation | undefined {
  if (event.eventType !== 'observation.upsert') return undefined
  if (typeof event.data !== 'object' || event.data === null || Array.isArray(event.data)) {
    throw new Error(`observation.upsert@${event.seq} is malformed`)
  }
  const data = event.data as WorldJsonObject
  if (typeof data.id !== 'string' || typeof data.value !== 'object' || data.value === null || Array.isArray(data.value)) {
    throw new Error(`observation.upsert@${event.seq} is malformed`)
  }
  const value = data.value as WorldJsonObject
  if (value.observerId !== characterId) return undefined
  return { observationId: data.id, content: value, sourceRef: sourceRef(event) }
}

/** Rebuild a character-safe recent tail only from committed observations and Authority identities. */
export class InteractionTailBuilder {
  constructor(private readonly world: WorldStore) {}

  rebuildAt(
    address: WorldAddress,
    characterId: CharacterId,
    afterSeq: number,
    asOfWorldSeq: number,
    maximumBlocks: number,
  ): InteractionTail {
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0 || !Number.isSafeInteger(asOfWorldSeq)
      || asOfWorldSeq < afterSeq || !Number.isSafeInteger(maximumBlocks) || maximumBlocks < 0) {
      throw new RangeError('Interaction Tail bounds must be ordered non-negative safe integers')
    }
    const grouped = new Map<TransactionId, StoredWorldEvent[]>()
    for (const event of this.world.readEvents(address, asOfWorldSeq)) {
      if (event.seq <= afterSeq) continue
      const group = grouped.get(event.transactionId) ?? []
      group.push(event)
      grouped.set(event.transactionId, group)
    }
    const blocks: InteractionBlock[] = []
    for (const [transactionId, events] of grouped) {
      const observations = events.flatMap(event => {
        const observation = observationFrom(event, characterId)
        return observation === undefined ? [] : [observation]
      })
      if (observations.length === 0) continue
      const committed = this.world.committedRound(address, transactionId)
      if (committed === undefined) throw new Error(`Interaction transaction ${transactionId} is not committed`)
      // Verify any durable Authority record, but do not expose its whole-ledger Hash to a character-scoped Tail.
      this.world.readRoundAuthority(address, transactionId)
      const input: InteractionBlockInput = {
        schemaVersion: 'interaction-block/v1', transactionId, roundId: committed.roundId,
        startSeq: observations[0]!.sourceRef.sourceSeq,
        endSeq: observations.at(-1)!.sourceRef.sourceSeq,
        tick: committed.tick,
        observations,
        authorityHash: null,
      }
      blocks.push({ ...input, blockHash: hashInteractionBlock(input) })
    }
    const selected = maximumBlocks === 0 ? [] : blocks.slice(-maximumBlocks)
    const input = {
      schemaVersion: 'interaction-tail/v1' as const,
      address, characterId, afterSeq, asOfWorldSeq, blocks: selected,
    }
    return { ...input, tailHash: hashInteractionTail(input) }
  }
}
