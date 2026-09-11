import {
  canonicalizeWorldJson,
  compareWorldText,
  deterministicId,
  hashWorldJson,
  RECALL_KEYWORD_STRATEGY_ID,
  type ActionRequest,
  type AnyCognitiveRecallResult,
  type AnyRecallQueryPlan,
  type CharacterId,
  type CharacterView,
  type CognitiveMemoryReceipt,
  type CognitiveMemoryWatermark,
  type ExtractiveL1Summary,
  type FaultInjector,
  type InteractionRoundId,
  type ManifestationProposal,
  type ProposalContext,
  type RecallClue,
  type RecallTokenizerId,
  type WorldAddress,
  type WorldHash,
  type WorldJsonObject,
  type WorldJsonValue,
} from '@harness-world/contracts'
import { CharacterViewBuilder, type WorldStore } from '@harness-world/store-sqlite'
import {
  DEFAULT_RECALL_LIMIT, LocalMemoryStore, memorySourceRef,
  type MemorySourceRef, type RecallCandidateDiagnostics, type RecalledMemory,
} from './local-memory.ts'

function legacyRecallQuery(parameters: WorldJsonValue): string {
  if (typeof parameters === 'string') return parameters
  if (typeof parameters !== 'object' || parameters === null || Array.isArray(parameters)) return ''
  const object = parameters as WorldJsonObject
  return Object.keys(object).sort(compareWorldText).flatMap(key => {
    const value = object[key]
    return typeof value === 'string' ? [value] : []
  }).join(' ')
}

function reactionRecallQuery(stimulus: WorldJsonValue): string {
  if (typeof stimulus === 'string') return stimulus
  if (Array.isArray(stimulus)) return stimulus.map(reactionRecallQuery).filter(Boolean).join(' ')
  if (typeof stimulus !== 'object' || stimulus === null) return ''
  const object = stimulus as WorldJsonObject
  return Object.keys(object).sort(compareWorldText)
    .map(key => reactionRecallQuery(object[key]!)).filter(Boolean).join(' ')
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
  readonly recallPlan?: AnyRecallQueryPlan
  readonly recall?: AnyCognitiveRecallResult
}

export interface PrepareCognitiveContextRequest {
  readonly address: WorldAddress
  readonly roundId: InteractionRoundId
  readonly tick: number
  readonly participantId: string
  readonly characterId: CharacterId
  readonly asOfWorldSeq: number
  readonly playerAction: ActionRequest
  readonly playerManifestation?: ManifestationProposal
  readonly candidateHash: WorldHash
  readonly allowedActionTypes: readonly string[]
  readonly sceneDecision: WorldJsonValue
  /** Scene membership from the authoritative Scene decision, used only as a Recall clue. */
  readonly sceneCharacterIds?: readonly CharacterId[]
  readonly correlationId: string
  readonly heartbeat?: () => void
}

export interface PrepareCognitiveStimulusRequest {
  readonly address: WorldAddress
  readonly roundId: InteractionRoundId
  readonly participantId: string
  readonly characterId: CharacterId
  readonly asOfWorldSeq: number
  readonly stimulus: WorldJsonValue
  /** Scene membership from the authoritative Scene decision, used only as a Recall clue. */
  readonly sceneCharacterIds?: readonly CharacterId[]
  readonly correlationId: string
  readonly heartbeat?: () => void
}

export interface PreparedCognitiveStimulus {
  readonly characterView: CharacterView
  readonly memoryRecall: readonly RecalledMemory[]
  readonly memorySourceRefs: readonly MemorySourceRef[]
  readonly recallResultHash: WorldHash
  readonly recallPlan?: AnyRecallQueryPlan
  readonly recall?: AnyCognitiveRecallResult
}

/** Phase 8 worker boundary: callers supply only an exact namespace and required World watermark. */
export class CognitiveMemoryWorker {
  constructor(
    private readonly memory: LocalMemoryStore,
    private readonly faultInjector?: FaultInjector,
    /** Kept here so every catch-up of a selected world builds the keyword index in the same transaction. */
    private readonly recallTokenizer?: RecallTokenizerId,
  ) {}

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
    const receipt = this.memory.catchUpV2(
      address, characterId, requiredAsOfSeq, correlationId, heartbeat,
      this.recallTokenizer === undefined ? undefined : { keywordTokenizerId: this.recallTokenizer },
    )
    this.faultInjector?.hit('memory.after-catchup-commit')
    return receipt
  }

  recall(plan: AnyRecallQueryPlan): AnyCognitiveRecallResult {
    return plan.schemaVersion === 'recall-query-plan/v2'
      ? this.memory.recallKeywords(plan)
      : this.memory.recallV2(plan)
  }

  recallDiagnostics(plan: AnyRecallQueryPlan): RecallCandidateDiagnostics {
    return this.memory.recallDiagnostics(plan)
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
    /**
     * Selects the versioned keyword Recall strategy, or keeps the frozen path when omitted. The selection
     * reaches the Recall receipt, so a rebuild that asks for a different one fails closed instead of
     * silently changing what a character is shown.
     */
    readonly recallTokenizer?: RecallTokenizerId,
  ) {
    this.#memory = new LocalMemoryStore(path, worldStore)
    this.#views = new CharacterViewBuilder(worldStore)
    this.#worker = version === 2 ? new CognitiveMemoryWorker(this.#memory, faultInjector, recallTokenizer) : undefined
  }

  /**
   * Build the Recall plan this service selects. The plan generation follows the selection, and the plan
   * identity follows the generation, so a world cannot silently reinterpret one generation's receipts as
   * another's.
   */
  #recallPlan(
    scope: { readonly address: WorldAddress; readonly characterId: CharacterId; readonly asOfWorldSeq: number },
    planId: string,
    query: string,
    clues: readonly RecallClue[],
  ): AnyRecallQueryPlan {
    if (this.recallTokenizer === undefined) {
      return {
        schemaVersion: 'recall-query-plan/v1', planId, address: scope.address, characterId: scope.characterId,
        asOfWorldSeq: scope.asOfWorldSeq, query, limit: DEFAULT_RECALL_LIMIT,
        rankingAlgorithm: 'fts5-bm25-stable/v1',
      }
    }
    return {
      schemaVersion: 'recall-query-plan/v2', planId, address: scope.address, characterId: scope.characterId,
      asOfWorldSeq: scope.asOfWorldSeq, queryText: query, strategyId: RECALL_KEYWORD_STRATEGY_ID,
      tokenizerId: this.recallTokenizer, dictionaryEnabled: false, dictionaryWatermark: null,
      clues, resultLimit: DEFAULT_RECALL_LIMIT,
    }
  }

  /**
   * Structural clues for one Recall: who is present according to the authoritative Scene decision, and
   * which of this character's own objectives are still open. Nothing here widens permission — both
   * sources are already visible to the character and rebuildable at the same as-of.
   */
  #recallClues(
    scope: { readonly address: WorldAddress; readonly characterId: CharacterId; readonly asOfWorldSeq: number },
    sceneCharacterIds: readonly CharacterId[] | undefined,
  ): readonly RecallClue[] {
    if (this.recallTokenizer === undefined) return []
    const clues: RecallClue[] = []
    for (const memberId of [...new Set(sceneCharacterIds ?? [])].sort(compareWorldText)) {
      if (memberId === scope.characterId) continue
      clues.push({ kind: 'present_character', sourceId: memberId, text: memberId })
    }
    return [...clues, ...this.#memory.openObjectiveClues(scope.address, scope.characterId, scope.asOfWorldSeq)]
  }

  #executeRecall(plan: AnyRecallQueryPlan): AnyCognitiveRecallResult {
    return plan.schemaVersion === 'recall-query-plan/v2'
      ? this.#memory.recallKeywords(plan)
      : this.#memory.recallV2(plan)
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
    const stimulus = request.playerManifestation === undefined
      ? request.playerAction.parameters
      : { action: request.playerAction.parameters, manifestation: request.playerManifestation }
    const stimulusRequest = {
      address: request.address,
      roundId: request.roundId,
      participantId: request.participantId,
      characterId: request.characterId,
      asOfWorldSeq: request.asOfWorldSeq,
      stimulus,
      ...(request.sceneCharacterIds === undefined ? {} : { sceneCharacterIds: request.sceneCharacterIds }),
      correlationId: request.correlationId,
      ...(request.heartbeat === undefined ? {} : { heartbeat: request.heartbeat }),
    }
    const prepared = this.#prepareStimulus(stimulusRequest, legacyRecallQuery(stimulus))
    const capability = {
      actorId: request.characterId,
      allowedActionTypes: [...request.allowedActionTypes].sort(compareWorldText),
    }
    const base = {
      address: request.address,
      roundId: request.roundId,
      tick: request.tick,
      playerAction: request.playerAction,
      ...(request.playerManifestation === undefined ? {} : { playerManifestation: request.playerManifestation }),
      candidateHash: request.candidateHash,
      agentContextVersion: 2 as const,
      participantId: request.participantId,
      characterView: prepared.characterView,
      sceneDecision: request.sceneDecision,
      memoryRecall: prepared.memoryRecall,
      memorySourceRefs: prepared.memorySourceRefs,
      recallResultHash: prepared.recallResultHash,
      capability,
      ...(prepared.recallPlan === undefined || prepared.recall === undefined
        ? {}
        : { recallPlan: prepared.recallPlan, recall: prepared.recall }),
    }
    return { ...base, contextHash: hashWorldJson('agent-context-envelope/v2', base) }
  }

  /** Prepare the same verified Memory prefix for a non-player durable stimulus. */
  prepareStimulus(request: PrepareCognitiveStimulusRequest): PreparedCognitiveStimulus {
    return this.#prepareStimulus(request, reactionRecallQuery(request.stimulus))
  }

  #prepareStimulus(request: PrepareCognitiveStimulusRequest, query: string): PreparedCognitiveStimulus {
    const characterView = this.catchUp(
      request.address, request.characterId, request.asOfWorldSeq, request.correlationId,
      request.heartbeat,
    )
    const plan = this.version === 2
      ? this.#recallPlan(
        { address: request.address, characterId: request.characterId, asOfWorldSeq: request.asOfWorldSeq },
        deterministicId(
          this.recallTokenizer === undefined ? 'round-recall-plan/v1' : 'round-recall-plan/v2',
          { address: request.address, roundId: request.roundId, participantId: request.participantId },
        ),
        query,
        this.#recallClues(
          { address: request.address, characterId: request.characterId, asOfWorldSeq: request.asOfWorldSeq },
          request.sceneCharacterIds,
        ),
      )
      : undefined
    const receiptRecall = plan === undefined ? undefined : this.#executeRecall(plan)
    const memoryRecall = receiptRecall === undefined
      ? this.#memory.recall(request.address, request.characterId, query, request.asOfWorldSeq)
      : receiptRecall.memories.map(memory => ({
        memoryId: memory.memoryId, text: memory.text,
        metadata: { ...memory.metadata as WorldJsonObject, source: memory.sourceRef },
        sourceMaxSeq: memory.sourceRef.sourceSeq, captureHash: memory.captureHash,
      }))
    const memorySourceRefs = (receiptRecall === undefined
      ? memoryRecall.flatMap(memory => {
        const metadata = memory.metadata as WorldJsonObject
        return [metadata.source as MemorySourceRef]
      })
      : receiptRecall.receipt.selectedSourceRefs as readonly MemorySourceRef[])
      .toSorted((left, right) => compareWorldText(left.sourceKind, right.sourceKind) || compareWorldText(left.sourceId, right.sourceId))
    const recallResultHash = receiptRecall?.receipt.resultHash
      ?? hashWorldJson('cognitive-memory-recall', { query, memories: memoryRecall, sources: memorySourceRefs })
    return {
      characterView,
      memoryRecall,
      memorySourceRefs,
      recallResultHash,
      ...(plan === undefined || receiptRecall === undefined ? {} : { recallPlan: plan, recall: receiptRecall }),
    }
  }

  recall(address: WorldAddress, characterId: CharacterId, query: string, asOfWorldSeq: number): RecalledMemory[] {
    this.catchUp(address, characterId, asOfWorldSeq, `memory-recall:${characterId}:${asOfWorldSeq}`)
    if (this.version === 2) {
      return this.#executeRecall(this.#applicationRecallPlan(address, characterId, query, asOfWorldSeq))
        .memories.map(memory => ({
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

  /**
   * Measure how many candidates the default Recall plan matches. This is the same plan and the same result
   * limit a real Recall uses, so the difference is exactly what one Recall leaves unseen.
   */
  diagnoseRecall(
    address: WorldAddress,
    characterId: CharacterId,
    query: string,
    asOfWorldSeq: number,
  ): RecallCandidateDiagnostics {
    if (this.version !== 2) {
      return {
        schemaVersion: 'recall-candidates/v1', address, characterId, asOfWorldSeq, query,
        matchedCount: this.#memory.countRecall(address, characterId, query, asOfWorldSeq),
        limit: DEFAULT_RECALL_LIMIT,
      }
    }
    return this.recallDiagnostics(this.#applicationRecallPlan(address, characterId, query, asOfWorldSeq))
  }

  /**
   * The single default Recall plan, so a diagnostic can never describe a plan production does not use.
   * Its identity follows the generation, for the same reason the round plan does.
   */
  #applicationRecallPlan(
    address: WorldAddress,
    characterId: CharacterId,
    query: string,
    asOfWorldSeq: number,
  ): AnyRecallQueryPlan {
    return this.#recallPlan(
      { address, characterId, asOfWorldSeq },
      deterministicId(
        this.recallTokenizer === undefined ? 'application-recall-plan/v1' : 'application-recall-plan/v2',
        { address, characterId, query, asOfWorldSeq },
      ),
      query,
      // This path has no Scene membership, so it stays keyword-only rather than guessing one.
      [],
    )
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

  recallWithReceipt(plan: AnyRecallQueryPlan): AnyCognitiveRecallResult {
    if (this.version !== 2) throw new TypeError('Recall receipt requires Cognitive Memory version 2')
    this.catchUpReceipt(plan.address, plan.characterId, plan.asOfWorldSeq, `memory-recall:${plan.planId}`)
    return this.#worker!.recall(plan)
  }

  /**
   * Measure how much one Recall plan's result limit drops. This runs the same idempotent catch-up a real
   * Recall does, then counts the candidates before the limit; no Receipt or result is written for the count.
   */
  recallDiagnostics(plan: AnyRecallQueryPlan): RecallCandidateDiagnostics {
    if (this.version !== 2) throw new TypeError('Recall diagnostics require Cognitive Memory version 2')
    this.catchUpReceipt(plan.address, plan.characterId, plan.asOfWorldSeq, `memory-diagnostics:${plan.planId}`)
    return this.#worker!.recallDiagnostics(plan)
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
        const watermark = this.watermark(address, job.characterId)
        if (watermark === undefined || watermark.verifiedThroughSeq <= job.asOfWorldSeq) {
          this.catchUp(address, job.characterId, job.asOfWorldSeq, `cognitive-job:${job.jobId}`, heartbeat)
        }
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
