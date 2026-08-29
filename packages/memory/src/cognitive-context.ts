import {
  canonicalizeWorldJson,
  compareWorldText,
  deterministicId,
  hashWorldJson,
  type ActionRequest,
  type CharacterId,
  type CharacterView,
  type CognitiveMemoryReceipt,
  type CognitiveMemoryWatermark,
  type CognitiveRecallResult,
  type ExtractiveL1Summary,
  type FaultInjector,
  type InteractionRoundId,
  type ProposalContext,
  type RecallQueryPlan,
  type WorldAddress,
  type WorldHash,
  type WorldJsonObject,
  type WorldJsonValue,
} from '@harness-world/contracts'
import { CharacterViewBuilder, type WorldStore } from '@harness-world/store-sqlite'
import { LocalMemoryStore, memorySourceRef, type MemorySourceRef, type RecalledMemory } from './local-memory.ts'

function recallQuery(parameters: WorldJsonValue): string {
  if (typeof parameters === 'string') return parameters
  if (typeof parameters !== 'object' || parameters === null || Array.isArray(parameters)) return ''
  const object = parameters as WorldJsonObject
  return Object.keys(object).sort(compareWorldText).flatMap(key => {
    const value = object[key]
    return typeof value === 'string' ? [value] : []
  }).join(' ')
}

export interface CognitiveProposalContext extends ProposalContext, WorldJsonObject {
  readonly agentContextVersion: 2
  readonly participantId: string
  readonly characterView: CharacterView
  readonly sceneDecision: WorldJsonValue
  readonly memoryRecall: readonly RecalledMemory[]
  readonly memorySourceRefs: readonly MemorySourceRef[]
  readonly recallResultHash: WorldHash
  readonly capability: { readonly actorId: CharacterId; readonly allowedActionTypes: readonly string[] }
  readonly contextHash: WorldHash
  readonly recallPlan?: RecallQueryPlan
  readonly recall?: CognitiveRecallResult
}

export interface PrepareCognitiveContextRequest {
  readonly address: WorldAddress
  readonly roundId: InteractionRoundId
  readonly tick: number
  readonly participantId: string
  readonly characterId: CharacterId
  readonly asOfWorldSeq: number
  readonly playerAction: ActionRequest
  readonly candidateHash: WorldHash
  readonly allowedActionTypes: readonly string[]
  readonly sceneDecision: WorldJsonValue
  readonly correlationId: string
  readonly heartbeat?: () => void
}

/** Phase 8 worker boundary: callers supply only an exact namespace and required World watermark. */
export class CognitiveMemoryWorker {
  constructor(private readonly memory: LocalMemoryStore, private readonly faultInjector?: FaultInjector) {}

  catchUp(address: WorldAddress, characterId: CharacterId, requiredAsOfSeq: number): CognitiveMemoryReceipt {
    return this.catchUpWithContext(
      address, characterId, requiredAsOfSeq, `memory-catchup:${characterId}:${requiredAsOfSeq}`,
    )
  }

  catchUpWithContext(
    address: WorldAddress,
    characterId: CharacterId,
    requiredAsOfSeq: number,
    correlationId: string,
    heartbeat?: () => void,
  ): CognitiveMemoryReceipt {
    const receipt = this.memory.catchUpV2(address, characterId, requiredAsOfSeq, correlationId, heartbeat)
    this.faultInjector?.hit('memory.after-catchup-commit')
    return receipt
  }

  recall(plan: RecallQueryPlan): CognitiveRecallResult {
    return this.memory.recallV2(plan)
  }

  watermark(address: WorldAddress, characterId: CharacterId): CognitiveMemoryWatermark | undefined {
    return this.memory.cognitiveWatermark(address, characterId)
  }

  summaries(address: WorldAddress, characterId: CharacterId): ExtractiveL1Summary[] {
    return this.memory.cognitiveSummaries(address, characterId)
  }

  reset(address: WorldAddress, characterId: CharacterId): number {
    return this.memory.resetCognitiveNamespace(address, characterId)
  }
}

/** Durable per-character Memory catch-up and stable agent Context v2 assembly. */
export class CognitiveMemoryService {
  readonly #memory: LocalMemoryStore
  readonly #views: CharacterViewBuilder
  readonly #worker: CognitiveMemoryWorker | undefined

  constructor(
    path: string,
    private readonly worldStore: WorldStore,
    private readonly faultInjector?: FaultInjector,
    readonly version: 1 | 2 = 1,
  ) {
    this.#memory = new LocalMemoryStore(path, worldStore)
    this.#views = new CharacterViewBuilder(worldStore)
    this.#worker = version === 2 ? new CognitiveMemoryWorker(this.#memory, faultInjector) : undefined
  }

  enqueue(address: WorldAddress, characterIds: readonly CharacterId[], asOfWorldSeq: number): void {
    for (const characterId of [...new Set(characterIds)].sort(compareWorldText)) {
      this.#memory.enqueueCognitiveJob(address, characterId, asOfWorldSeq)
    }
  }

  catchUp(
    address: WorldAddress,
    characterId: CharacterId,
    asOfWorldSeq: number,
    correlationId: string,
    heartbeat?: () => void,
  ): CharacterView {
    if (this.version === 2) {
      this.catchUpReceipt(address, characterId, asOfWorldSeq, correlationId, heartbeat)
      return this.#views.rebuildAt(address, characterId, asOfWorldSeq, heartbeat)
    }
    this.#memory.enqueueCognitiveJob(address, characterId, asOfWorldSeq)
    try {
      heartbeat?.()
      this.faultInjector?.hit('memory.before-catchup')
      this.#memory.reconcile({ address, characterId, asOfWorldSeq, correlationId }, heartbeat)
      const view = this.#views.rebuildAt(address, characterId, asOfWorldSeq, heartbeat)
      for (const [kind, records] of [
        ['observation', view.observations],
        ['claim', view.claims],
        ['goal', view.goals],
      ] as const) {
        for (const record of records) {
          heartbeat?.()
          const source = memorySourceRef(kind, record)
          this.#memory.capture({
            address,
            characterId,
            memoryId: deterministicId(`memory:${kind}`, { characterId, source }),
            text: Buffer.from(canonicalizeWorldJson(record.value)).toString('utf8'),
            metadata: { kind, source },
            sources: [source],
            asOfWorldSeq,
            correlationId,
          })
        }
      }
      this.#memory.recordCognitiveJobResult(address, characterId, asOfWorldSeq, 'completed', null)
      heartbeat?.()
      return view
    } catch (error: unknown) {
      this.#memory.recordCognitiveJobResult(address, characterId, asOfWorldSeq, 'failed', String(error))
      throw error
    }
  }

  prepare(request: PrepareCognitiveContextRequest): CognitiveProposalContext {
    const characterView = this.catchUp(
      request.address, request.characterId, request.asOfWorldSeq, request.correlationId,
      request.heartbeat,
    )
    const query = recallQuery(request.playerAction.parameters)
    const v2Plan: RecallQueryPlan | undefined = this.version === 2 ? {
      schemaVersion: 'recall-query-plan/v1',
      planId: deterministicId('round-recall-plan/v1', {
        address: request.address, roundId: request.roundId, participantId: request.participantId,
      }),
      address: request.address, characterId: request.characterId, asOfWorldSeq: request.asOfWorldSeq,
      query, limit: 10, rankingAlgorithm: 'fts5-bm25-stable/v1',
    } : undefined
    const v2Recall = v2Plan === undefined ? undefined : this.#memory.recallV2(v2Plan)
    const memoryRecall = v2Recall === undefined
      ? this.#memory.recall(request.address, request.characterId, query, request.asOfWorldSeq)
      : v2Recall.memories.map(memory => ({
        memoryId: memory.memoryId, text: memory.text,
        metadata: { ...memory.metadata as WorldJsonObject, source: memory.sourceRef },
        sourceMaxSeq: memory.sourceRef.sourceSeq, captureHash: memory.captureHash,
      }))
    const memorySourceRefs = (v2Recall === undefined
      ? memoryRecall.flatMap(memory => {
        const metadata = memory.metadata as WorldJsonObject
        return [metadata.source as MemorySourceRef]
      })
      : v2Recall.receipt.selectedSourceRefs as readonly MemorySourceRef[])
      .toSorted((left, right) => compareWorldText(left.sourceKind, right.sourceKind) || compareWorldText(left.sourceId, right.sourceId))
    const recallResultHash = v2Recall?.receipt.resultHash
      ?? hashWorldJson('cognitive-memory-recall', { query, memories: memoryRecall, sources: memorySourceRefs })
    const capability = {
      actorId: request.characterId,
      allowedActionTypes: [...request.allowedActionTypes].sort(compareWorldText),
    }
    const base = {
      address: request.address,
      roundId: request.roundId,
      tick: request.tick,
      playerAction: request.playerAction,
      candidateHash: request.candidateHash,
      agentContextVersion: 2 as const,
      participantId: request.participantId,
      characterView,
      sceneDecision: request.sceneDecision,
      memoryRecall,
      memorySourceRefs,
      recallResultHash,
      capability,
      ...(v2Plan === undefined || v2Recall === undefined ? {} : { recallPlan: v2Plan, recall: v2Recall }),
    }
    return { ...base, contextHash: hashWorldJson('agent-context-envelope/v2', base) }
  }

  recall(address: WorldAddress, characterId: CharacterId, query: string, asOfWorldSeq: number): RecalledMemory[] {
    this.catchUp(address, characterId, asOfWorldSeq, `memory-recall:${characterId}:${asOfWorldSeq}`)
    if (this.version === 2) {
      return this.#memory.recallV2({
        schemaVersion: 'recall-query-plan/v1',
        planId: deterministicId('application-recall-plan/v1', { address, characterId, query, asOfWorldSeq }),
        address, characterId, asOfWorldSeq, query, limit: 10, rankingAlgorithm: 'fts5-bm25-stable/v1',
      }).memories.map(memory => ({
        memoryId: memory.memoryId, text: memory.text,
        metadata: {
          ...memory.metadata as WorldJsonObject,
          kind: memory.memoryKind, epistemicKind: memory.epistemicKind, source: memory.sourceRef,
        },
        sourceMaxSeq: memory.sourceRef.sourceSeq, captureHash: memory.captureHash,
      }))
    }
    return this.#memory.recall(address, characterId, query, asOfWorldSeq)
  }

  catchUpReceipt(
    address: WorldAddress,
    characterId: CharacterId,
    requiredAsOfSeq: number,
    correlationId = `memory-catchup:${characterId}:${requiredAsOfSeq}`,
    heartbeat?: () => void,
  ): CognitiveMemoryReceipt {
    if (this.version !== 2) throw new TypeError('Cognitive Memory receipt requires version 2')
    return this.#worker!.catchUpWithContext(address, characterId, requiredAsOfSeq, correlationId, heartbeat)
  }

  recallWithReceipt(plan: RecallQueryPlan): CognitiveRecallResult {
    if (this.version !== 2) throw new TypeError('Recall receipt requires Cognitive Memory version 2')
    this.catchUpReceipt(plan.address, plan.characterId, plan.asOfWorldSeq, `memory-recall:${plan.planId}`)
    return this.#worker!.recall(plan)
  }

  watermark(address: WorldAddress, characterId: CharacterId): CognitiveMemoryWatermark | undefined {
    return this.#worker?.watermark(address, characterId)
  }

  summaries(address: WorldAddress, characterId: CharacterId): ExtractiveL1Summary[] {
    return this.#worker?.summaries(address, characterId) ?? []
  }

  /** Consume World-transaction jobs idempotently; a crash before the receipt simply repeats derived work. */
  processPending(
    address: WorldAddress,
    ownerId: string,
    fencingToken: number,
    heartbeat: () => void,
  ): { readonly completed: number; readonly failed: readonly { readonly characterId: CharacterId; readonly error: string }[] } {
    let completed = 0
    const failed: Array<{ characterId: CharacterId; error: string }> = []
    for (const job of this.worldStore.readCognitiveJobs(address)) {
      try {
        this.catchUp(address, job.characterId, job.asOfWorldSeq, `cognitive-job:${job.jobId}`, heartbeat)
        heartbeat()
        this.worldStore.recordCognitiveJobResult(
          address, job.jobId, ownerId, fencingToken, 'completed', null, `cognitive-job:${job.jobId}`,
        )
        completed += 1
      } catch (error: unknown) {
        const message = String(error)
        this.worldStore.recordCognitiveJobResult(
          address, job.jobId, ownerId, fencingToken, 'failed', message, `cognitive-job:${job.jobId}`,
        )
        failed.push({ characterId: job.characterId, error: message })
        if (error instanceof Error && 'envelope' in error
          && (error as { envelope?: { category?: string } }).envelope?.category === 'integrity') throw error
      }
    }
    return { completed, failed }
  }

  /** Repair derived Memory during quarantine Maintenance from a verified World prefix. */
  rebuildBranch(
    address: WorldAddress,
    characterIds: readonly CharacterId[],
    asOfWorldSeq: number,
    correlationId: string,
  ): WorldHash {
    const views = [...new Set(characterIds)].sort(compareWorldText).map(characterId => {
      if (this.version === 2) this.#worker!.reset(address, characterId)
      else this.#memory.resetNamespace(address, characterId)
      return this.catchUp(address, characterId, asOfWorldSeq, `${correlationId}:${characterId}`).bundleHash
    })
    return hashWorldJson('cognitive-memory-branch-rebuild', { address, asOfWorldSeq, views })
  }

  job(address: WorldAddress, characterId: CharacterId, asOfWorldSeq: number) {
    return this.#memory.cognitiveJob(address, characterId, asOfWorldSeq)
  }

  close(): void {
    this.#memory.close()
  }
}
