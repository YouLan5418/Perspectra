import { publicationSegments, publicationSourceText, parseExpressionSegments } from '@harness-world/contracts'
import type { DatabaseSync } from 'node:sqlite'
import {
  canonicalizeWorldJson,
  compareWorldText,
  deterministicId,
  failWorld,
  hashWorldJson,
  worldAddressKey,
  type CognitiveEpistemicKind,
  type CognitiveMemoryEntry,
  type CognitiveMemoryKind,
  type CognitiveMemoryReceipt,
  type CognitiveMemoryWatermark,
  type CharacterId,
  type CharacterView,
  type ContextSourceRef,
  type FaultInjector,
  type WorldAddress,
  type WorldHash,
  type WorldJsonObject,
  type WorldJsonValue,
} from '@harness-world/contracts'
import { openMemoryDatabase } from './memory-schema.ts'
import {
  CognitionProjectionRebuilder,
  CharacterViewBuilder,
  parseWorldJson,
  rollbackAndThrow,
  type WorldStore,
  worldJsonText,
} from '@harness-world/store-sqlite'

function namespace(address: WorldAddress, characterId: CharacterId): string {
  return `${worldAddressKey(address)}\u001f${characterId}`
}

interface CognitiveSourceCandidate {
  readonly sourceType: 'observation' | 'subjective_claim' | 'character_goal'
  readonly sourceRef: ContextSourceRef
  readonly memoryKind: CognitiveMemoryKind
  readonly epistemicKind: Exclude<CognitiveEpistemicKind, 'derived_summary'>
  readonly text: string
  readonly metadata: WorldJsonValue
}

const EPISODIC_OBSERVATION_KINDS = new Set<CognitiveEpistemicKind>([
  'direct_observation',
  'observed_action',
  'subjective_inference',
  'self_intention',
])

function objectValue(value: WorldJsonValue, path: string): WorldJsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${path} must be an object`)
  return value as WorldJsonObject
}

function canonicalText(value: WorldJsonValue): string {
  return typeof value === 'string' ? value : Buffer.from(canonicalizeWorldJson(value)).toString('utf8')
}

function observedManifestation(
  value: WorldJsonValue | undefined,
  path: string,
): { readonly characterId: string; readonly text: string; readonly value: WorldJsonObject } | undefined {
  if (value === undefined) return undefined
  const manifestation = objectValue(value, path)
  if (typeof manifestation.characterId !== 'string' || manifestation.characterId.length === 0) {
    throw new Error('manifestation observation requires characterId')
  }
  if (
    manifestation.description !== null &&
    manifestation.description !== undefined &&
    typeof manifestation.description !== 'string'
  ) {
    throw new Error('manifestation observation description must be string or null')
  }
  if (!Array.isArray(manifestation.cues) || manifestation.cues.length === 0) {
    throw new Error('manifestation observation requires accepted cues')
  }
  const cueDescriptions = manifestation.cues.map((entry, index) => {
    const cue = objectValue(entry, `${path}.cues[${index}]`)
    if (typeof cue.description !== 'string' || cue.description.length === 0) {
      throw new Error('manifestation observation cue requires description')
    }
    return cue.description
  })
  return {
    characterId: manifestation.characterId,
    text: typeof manifestation.description === 'string' ? manifestation.description : cueDescriptions.join('；'),
    value: manifestation,
  }
}

function orderedSources(values: readonly CognitiveSourceCandidate[]): CognitiveSourceCandidate[] {
  // One authoritative World Event can produce at most one captured record for one character.
  return [...values].sort((left, right) => left.sourceRef.sourceSeq - right.sourceRef.sourceSeq)
}

/**
 * The FTS5 MATCH expression for one Recall query. Recall and its diagnostics share this so the counted
 * candidate set can never drift from the set a real Recall ranks.
 */
export function goalObjectiveText(value: WorldJsonValue): string {
  return canonicalText(objectValue(value, 'CharacterGoal').objective as WorldJsonValue)
}

/** One character's authorized experience, as a long-term memory implementation reads it. */
export interface AuthorizedSource extends WorldJsonObject {
  readonly sourceId: string
  readonly sourceHash: string
  readonly epistemicKind: string
  readonly sourceSeq: number
  readonly text: string
}

/**
 * What each character was allowed to experience, captured from committed events. It decides nothing about
 * remembering: that belongs to the memory implementation. The rows stay derivable from the world.
 */
export class AuthorizedSourceStore {
  readonly #db: DatabaseSync
  readonly #viewBuilder: CharacterViewBuilder
  readonly #worldStore: WorldStore

  constructor(
    path: string,
    worldStore: WorldStore,
    private readonly faultInjector?: FaultInjector,
  ) {
    this.#db = openMemoryDatabase(path)
    this.#worldStore = worldStore
    this.#viewBuilder = new CharacterViewBuilder(worldStore)
  }

  /**
   * Rebuild, verify, capture, and receipt one character namespace at an exact World prefix.
   */
  catchUp(
    address: WorldAddress,
    characterId: CharacterId,
    requiredAsOfSeq: number,
    correlationId = `memory-catchup:${characterId}:${requiredAsOfSeq}`,
    heartbeat?: () => void,
  ): CognitiveMemoryReceipt {
    if (!Number.isSafeInteger(requiredAsOfSeq) || requiredAsOfSeq < 0) {
      throw new RangeError('requiredAsOfSeq must be a non-negative safe integer')
    }
    const characterView = this.#viewBuilder.rebuildAt(address, characterId, requiredAsOfSeq, heartbeat)
    const cognitionHistory = new CognitionProjectionRebuilder(this.#worldStore)
      .historyAt(address, requiredAsOfSeq, heartbeat)
      .filter(record => record.characterId === characterId)
    const candidates = orderedSources([
      ...this.#observationCandidates(address, characterId, requiredAsOfSeq, correlationId, heartbeat),
      ...cognitionHistory
        .filter(record => record.kind === 'subjective-claim')
        .map(record => ({
          sourceType: 'subjective_claim' as const,
          sourceRef: record.sourceRef,
          memoryKind: 'belief' as const,
          epistemicKind: 'subjective_inference' as const,
          text: canonicalText(objectValue(record.value, 'SubjectiveClaim').proposition as WorldJsonValue),
          metadata: {
            projectionId: record.id,
            stance: objectValue(record.value, 'SubjectiveClaim').stance as WorldJsonValue,
          },
        })),
      ...cognitionHistory
        .filter(record => record.kind === 'character-goal')
        .map(record => ({
          sourceType: 'character_goal' as const,
          sourceRef: record.sourceRef,
          memoryKind: 'intention' as const,
          epistemicKind: 'self_intention' as const,
          text: goalObjectiveText(record.value),
          metadata: {
            projectionId: record.id,
            status: objectValue(record.value, 'CharacterGoal').status as WorldJsonValue,
          },
        })),
    ])
    const sourceRefs = candidates.map(candidate => candidate.sourceRef)
    const sourceMapHash = hashWorldJson('cognitive-memory-source-map/v2', { address, characterId, sourceRefs })
    const sourceBundleHash = hashWorldJson('cognitive-memory-source-bundle/v2', {
      characterViewHash: characterView.bundleHash,
      cognitionHistoryHash: hashWorldJson('cognitive-memory-cognition-history/v2', cognitionHistory),
      sourceMapHash,
    })
    const key = namespace(address, characterId)
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const current = this.#db
        .prepare(
          `
        SELECT verified_through_seq, captured_through_seq, memory_epoch, source_map_hash
        FROM cognitive_memory_v2_namespaces WHERE namespace_key = ?
      `,
        )
        .get(key) as
        | {
            verified_through_seq: number
            captured_through_seq: number
            memory_epoch: number
            source_map_hash: WorldHash
          }
        | undefined
      if (current !== undefined && current.verified_through_seq > requiredAsOfSeq) {
        this.#unverifiedV2(address, correlationId, 'Cognitive Memory watermark cannot move backward')
      }
      if (current?.verified_through_seq === requiredAsOfSeq && current.source_map_hash !== sourceMapHash) {
        this.#unverifiedV2(address, correlationId, 'Cognitive Memory source map diverged at one watermark')
      }
      const memoryEpoch = current?.memory_epoch ?? 1
      for (const candidate of candidates) this.#captureV2Candidate(key, address, characterId, candidate, correlationId)
      const rows = this.#readV2Entries(key, requiredAsOfSeq)
      const watermark: CognitiveMemoryWatermark = {
        schemaVersion: 'cognitive-memory-watermark/v2',
        address,
        characterId,
        verifiedThroughSeq: requiredAsOfSeq,
        capturedThroughSeq: requiredAsOfSeq,
        memoryEpoch,
        sourceMapHash,
      }
      this.#db
        .prepare(
          `
        INSERT INTO cognitive_memory_v2_namespaces(
          namespace_key, verified_through_seq, captured_through_seq, memory_epoch, source_map_hash, source_bundle_hash
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(namespace_key) DO UPDATE SET
          verified_through_seq = excluded.verified_through_seq,
          captured_through_seq = excluded.captured_through_seq,
          source_map_hash = excluded.source_map_hash,
          source_bundle_hash = excluded.source_bundle_hash
      `,
        )
        .run(key, requiredAsOfSeq, requiredAsOfSeq, memoryEpoch, sourceMapHash, sourceBundleHash)
      const receiptId = deterministicId('cognitive-memory-receipt/v2', {
        address,
        characterId,
        requiredAsOfSeq,
        memoryEpoch,
      })
      const receiptInput = {
        schemaVersion: 'cognitive-memory-receipt/v2' as const,
        receiptId,
        address,
        characterId,
        requiredAsOfSeq,
        watermark,
        sourceBundleHash,
        capturedMemoryIds: rows.map(row => row.memoryId),
        summaryIds: [],
      }
      const receipt: CognitiveMemoryReceipt = {
        ...receiptInput,
        receiptHash: hashWorldJson('cognitive-memory-receipt/v2', receiptInput),
      }
      const existing = this.#db
        .prepare(
          `
        SELECT receipt_hash FROM cognitive_memory_v2_receipts WHERE receipt_id = ?
      `,
        )
        .get(receiptId) as { receipt_hash: WorldHash } | undefined
      if (existing !== undefined && existing.receipt_hash !== receipt.receiptHash) {
        this.#unverifiedV2(address, correlationId, 'Cognitive Memory receipt diverged for one identity')
      }
      this.#db
        .prepare(
          `
        INSERT OR IGNORE INTO cognitive_memory_v2_receipts(
          receipt_id, namespace_key, required_as_of_seq, receipt_hash, receipt_json
        ) VALUES (?, ?, ?, ?, ?)
      `,
        )
        .run(receiptId, key, requiredAsOfSeq, receipt.receiptHash, worldJsonText(receipt))
      this.#db.exec('COMMIT')
      this.faultInjector?.hit('memory.after-catchup-commit')
      heartbeat?.()
      return receipt
    } catch (error: unknown) {
      rollbackAndThrow(this.#db, error)
    }
  }

  watermark(address: WorldAddress, characterId: CharacterId): CognitiveMemoryWatermark | undefined {
    const row = this.#db
      .prepare(
        `
      SELECT verified_through_seq, captured_through_seq, memory_epoch, source_map_hash
      FROM cognitive_memory_v2_namespaces WHERE namespace_key = ?
    `,
      )
      .get(namespace(address, characterId)) as
      | {
          verified_through_seq: number
          captured_through_seq: number
          memory_epoch: number
          source_map_hash: WorldHash
        }
      | undefined
    return row === undefined
      ? undefined
      : {
          schemaVersion: 'cognitive-memory-watermark/v2',
          address,
          characterId,
          verifiedThroughSeq: row.verified_through_seq,
          capturedThroughSeq: row.captured_through_seq,
          memoryEpoch: row.memory_epoch,
          sourceMapHash: row.source_map_hash,
        }
  }

  /** Delete only the v2 derived namespace and advance its epoch before deterministic rebuild. */
  reset(address: WorldAddress, characterId: CharacterId): number {
    const key = namespace(address, characterId)
    const nextEpoch = (this.watermark(address, characterId)?.memoryEpoch ?? 0) + 1
    const emptyHash = hashWorldJson('cognitive-memory-source-map/v2', { address, characterId, sourceRefs: [] })
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      this.#db.prepare(`DELETE FROM cognitive_memory_v2_sources WHERE namespace_key = ?`).run(key)
      this.#db.prepare(`DELETE FROM cognitive_memory_v2_receipts WHERE namespace_key = ?`).run(key)
      this.#db
        .prepare(
          `
        INSERT INTO cognitive_memory_v2_namespaces(
          namespace_key, verified_through_seq, captured_through_seq, memory_epoch, source_map_hash, source_bundle_hash
        ) VALUES (?, 0, 0, ?, ?, ?)
        ON CONFLICT(namespace_key) DO UPDATE SET
          verified_through_seq = 0, captured_through_seq = 0, memory_epoch = excluded.memory_epoch,
          source_map_hash = excluded.source_map_hash, source_bundle_hash = excluded.source_bundle_hash,
          terms_tokenizer_id = NULL
      `,
        )
        .run(key, nextEpoch, emptyHash, emptyHash)
      this.#db.exec('COMMIT')
      return nextEpoch
    } catch (error: unknown) {
      rollbackAndThrow(this.#db, error)
    }
  }

  #observationCandidates(
    address: WorldAddress,
    characterId: CharacterId,
    asOfWorldSeq: number,
    correlationId: string,
    heartbeat?: () => void,
  ): CognitiveSourceCandidate[] {
    const candidates: CognitiveSourceCandidate[] = []
    for (const [index, event] of this.#worldStore
      .readEventsRange(address, 0, asOfWorldSeq, ['observation.upsert'])
      .entries()) {
      if (index % 128 === 0) heartbeat?.()
      try {
        const data = objectValue(event.data, `observation.upsert@${event.seq}`)
        if (typeof data.id !== 'string' || data.id.length === 0)
          throw new Error('observation id must be a non-empty string')
        const value = objectValue(data.value as WorldJsonValue, `observation.upsert@${event.seq}.value`)
        if (value.observerId !== characterId) continue
        const content = value.content ?? value
        const contentObject =
          typeof content === 'object' && content !== null && !Array.isArray(content)
            ? (content as WorldJsonObject)
            : undefined
        const speechValue = contentObject?.speech
        const manifestation = observedManifestation(
          contentObject?.manifestation,
          `observation.upsert@${event.seq}.value.content.manifestation`,
        )
        let memoryKind: CognitiveMemoryKind = 'episodic'
        let epistemicKind: Exclude<CognitiveEpistemicKind, 'derived_summary'>
        let text = canonicalText(content)
        let metadata: WorldJsonValue = { observationId: data.id }
        if (speechValue !== undefined) {
          const speech = objectValue(speechValue, `observation.upsert@${event.seq}.value.content.speech`)
          if (typeof speech.characterId !== 'string') throw new Error('communication observation requires characterId')
          const segments =
            speech.segments === undefined ? publicationSegments(speech) : parseExpressionSegments(speech.segments)
          memoryKind = 'communication'
          epistemicKind = 'reported_speech'
          text =
            publicationSourceText(speech) +
            (manifestation === undefined ? '' : `; ${manifestation.characterId} appeared: ${manifestation.text}`)
          metadata = {
            observationId: data.id,
            speakerId: speech.characterId,
            ...(typeof speech.medium === 'string'
              ? { medium: speech.medium, addresseeIds: speech.addresseeIds ?? [] }
              : {}),
            ...(speech.segments === undefined ? {} : { segments }),
            ...(speech.narration === undefined ? {} : { narration: speech.narration }),
            ...(manifestation === undefined ? {} : { manifestation: manifestation.value }),
          }
        } else if (manifestation !== undefined) {
          epistemicKind = 'direct_observation'
          text = `${manifestation.characterId} appeared: ${manifestation.text}`
          metadata = { observationId: data.id, manifestation: manifestation.value }
        } else {
          const declared = value.epistemicKind
          if (declared !== undefined && !EPISODIC_OBSERVATION_KINDS.has(declared as CognitiveEpistemicKind)) {
            throw new Error('observation epistemicKind is unsupported for episodic capture')
          }
          epistemicKind =
            (declared as Exclude<CognitiveEpistemicKind, 'derived_summary'> | undefined) ??
            (contentObject?.actionType === undefined ? 'direct_observation' : 'observed_action')
        }
        if (contentObject?.playerInput !== undefined) {
          const input = objectValue(contentObject.playerInput, `observation.upsert@${event.seq}.playerInput`)
          if (
            typeof input.actorId !== 'string' ||
            typeof input.sourceText !== 'string' ||
            !Array.isArray(input.sourceSpans)
          )
            throw new Error('player input evidence is malformed')
          // Observations already gate access. Preserve the source when a speech-specific renderer
          // replaces the generic content; it stays a player report, never a committed effect.
          if (speechValue !== undefined)
            text += `; original player input (interpretation evidence, not an adjudicated outcome): ${input.sourceText}`
          metadata = { ...(metadata as WorldJsonObject), playerInput: input }
        }
        candidates.push({
          sourceType: 'observation',
          sourceRef: {
            sourceKind: 'world_event',
            sourceId: `event:${event.seq}`,
            sourceSeq: event.seq,
            sourceHash: event.eventHash,
          },
          memoryKind,
          epistemicKind,
          text,
          metadata,
        })
      } catch (error: unknown) {
        this.#unverifiedV2(address, correlationId, `Observation source is malformed: ${String(error)}`)
      }
    }
    return candidates
  }

  #captureV2Candidate(
    key: string,
    address: WorldAddress,
    characterId: CharacterId,
    candidate: CognitiveSourceCandidate,
    correlationId: string,
  ): void {
    const memoryId = deterministicId('cognitive-memory-entry/v2', {
      address,
      characterId,
      sourceType: candidate.sourceType,
      sourceRef: candidate.sourceRef,
    })
    const captureInput = {
      memoryId,
      memoryKind: candidate.memoryKind,
      epistemicKind: candidate.epistemicKind,
      text: candidate.text,
      metadata: candidate.metadata,
      sourceRef: candidate.sourceRef,
    }
    const captureHash = hashWorldJson('cognitive-memory-capture/v2', captureInput)
    const existing = this.#db
      .prepare(
        `
      SELECT source_seq, source_hash, capture_hash FROM cognitive_memory_v2_sources
      WHERE namespace_key = ? AND source_id = ?
    `,
      )
      .get(key, candidate.sourceRef.sourceId) as
      | {
          source_seq: number
          source_hash: WorldHash
          capture_hash: WorldHash
        }
      | undefined
    if (
      existing !== undefined &&
      (existing.source_seq !== candidate.sourceRef.sourceSeq ||
        existing.source_hash !== candidate.sourceRef.sourceHash ||
        existing.capture_hash !== captureHash)
    ) {
      this.#unverifiedV2(address, correlationId, 'Cognitive Memory source identity is bound to divergent content')
    }
    this.#db
      .prepare(
        `
      INSERT OR IGNORE INTO cognitive_memory_v2_sources(
        namespace_key, memory_id, source_type, source_id, source_seq, source_hash,
        memory_kind, epistemic_kind, text_value, metadata_json, capture_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        key,
        memoryId,
        candidate.sourceType,
        candidate.sourceRef.sourceId,
        candidate.sourceRef.sourceSeq,
        candidate.sourceRef.sourceHash,
        candidate.memoryKind,
        candidate.epistemicKind,
        candidate.text,
        worldJsonText(candidate.metadata),
        captureHash,
      )
  }

  #readV2Entries(key: string, asOfWorldSeq: number): CognitiveMemoryEntry[] {
    const rows = this.#db
      .prepare(
        `
      SELECT memory_id, memory_kind, epistemic_kind, text_value, metadata_json,
             source_id, source_seq, source_hash, capture_hash
      FROM cognitive_memory_v2_sources
      WHERE namespace_key = ? AND source_seq <= ?
      ORDER BY source_seq, source_type, source_id
    `,
      )
      .all(key, asOfWorldSeq) as Array<{
      memory_id: string
      memory_kind: CognitiveMemoryKind
      epistemic_kind: Exclude<CognitiveEpistemicKind, 'derived_summary'>
      text_value: string
      metadata_json: string
      source_id: string
      source_seq: number
      source_hash: WorldHash
      capture_hash: WorldHash
    }>
    return rows.map(row => ({
      memoryId: row.memory_id,
      memoryKind: row.memory_kind,
      epistemicKind: row.epistemic_kind,
      text: row.text_value,
      metadata: parseWorldJson(row.metadata_json),
      sourceRef: {
        sourceKind: 'world_event',
        sourceId: row.source_id,
        sourceSeq: row.source_seq,
        sourceHash: row.source_hash,
      },
      captureHash: row.capture_hash,
    }))
  }

  /** This character's sources through one prefix, in the order they happened. */
  sources(address: WorldAddress, characterId: CharacterId, throughSeq: number): readonly AuthorizedSource[] {
    const rows = this.#db
      .prepare(
        'SELECT source_id,source_hash,epistemic_kind,source_seq,text_value FROM cognitive_memory_v2_sources WHERE namespace_key=? AND source_seq<=? ORDER BY source_seq,source_id',
      )
      .all(namespace(address, characterId), throughSeq) as {
      source_id: string
      source_hash: string
      epistemic_kind: string
      source_seq: number
      text_value: string
    }[]
    return rows.map(row => ({
      sourceId: row.source_id,
      sourceHash: row.source_hash,
      epistemicKind: row.epistemic_kind,
      sourceSeq: row.source_seq,
      text: row.text_value,
    }))
  }

  /** Consume World-transaction jobs idempotently; a crash before the receipt simply repeats derived work. */
  processPending(
    address: WorldAddress,
    ownerId: string,
    fencingToken: number,
    heartbeat: () => void,
  ): {
    readonly completed: number
    readonly failed: readonly { readonly characterId: CharacterId; readonly error: string }[]
  } {
    let completed = 0
    const failed: Array<{ characterId: CharacterId; error: string }> = []
    for (const job of this.#worldStore.readCognitiveJobs(address)) {
      try {
        const watermark = this.watermark(address, job.characterId)
        if (watermark === undefined || watermark.verifiedThroughSeq <= job.asOfWorldSeq) {
          this.catchUp(address, job.characterId, job.asOfWorldSeq, `cognitive-job:${job.jobId}`, heartbeat)
        }
        heartbeat()
        this.#worldStore.recordCognitiveJobResult(
          address,
          job.jobId,
          ownerId,
          fencingToken,
          'completed',
          null,
          `cognitive-job:${job.jobId}`,
        )
        completed += 1
      } catch (error: unknown) {
        const message = String(error)
        this.#worldStore.recordCognitiveJobResult(
          address,
          job.jobId,
          ownerId,
          fencingToken,
          'failed',
          message,
          `cognitive-job:${job.jobId}`,
        )
        failed.push({ characterId: job.characterId, error: message })
        if (
          error instanceof Error &&
          'envelope' in error &&
          (error as { envelope?: { category?: string } }).envelope?.category === 'integrity'
        )
          throw error
      }
    }
    return { completed, failed }
  }

  /** Repair the derived rows during quarantine Maintenance from a verified World prefix. */
  rebuildBranch(
    address: WorldAddress,
    characterIds: readonly CharacterId[],
    asOfWorldSeq: number,
    correlationId: string,
  ): WorldHash {
    const views = [...new Set(characterIds)].sort(compareWorldText).map(characterId => {
      this.reset(address, characterId)
      this.catchUp(address, characterId, asOfWorldSeq, `${correlationId}:${characterId}`)
      return this.#viewBuilder.rebuildAt(address, characterId, asOfWorldSeq).bundleHash
    })
    return hashWorldJson('cognitive-memory-branch-rebuild', { address, asOfWorldSeq, views })
  }

  close(): void {
    this.#db.close()
  }

  #unverifiedV2(address: WorldAddress, correlationId: string, message: string): never {
    failWorld({
      errorCode: 'MEMORY_SOURCE_UNVERIFIED',
      category: 'integrity',
      message,
      retryable: false,
      correlationId,
      address,
    })
  }
}
