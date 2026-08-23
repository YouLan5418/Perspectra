import {
  canonicalizeWorldJson,
  deterministicId,
  hashWorldJson,
  type ActionRequest,
  type CharacterId,
  type CharacterView,
  type FaultInjector,
  type InteractionRoundId,
  type ProposalContext,
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
  return Object.keys(object).sort().flatMap(key => {
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
}

/** Durable per-character Memory catch-up and stable agent Context v2 assembly. */
export class CognitiveMemoryService {
  readonly #memory: LocalMemoryStore
  readonly #views: CharacterViewBuilder

  constructor(path: string, worldStore: WorldStore, private readonly faultInjector?: FaultInjector) {
    this.#memory = new LocalMemoryStore(path, worldStore)
    this.#views = new CharacterViewBuilder(worldStore)
  }

  enqueue(address: WorldAddress, characterIds: readonly CharacterId[], asOfWorldSeq: number): void {
    for (const characterId of [...new Set(characterIds)].sort()) {
      this.#memory.enqueueCognitiveJob(address, characterId, asOfWorldSeq)
    }
  }

  catchUp(address: WorldAddress, characterId: CharacterId, asOfWorldSeq: number, correlationId: string): CharacterView {
    this.#memory.enqueueCognitiveJob(address, characterId, asOfWorldSeq)
    try {
      this.faultInjector?.hit('memory.before-catchup')
      this.#memory.reconcile({ address, characterId, asOfWorldSeq, correlationId })
      const view = this.#views.rebuildAt(address, characterId, asOfWorldSeq)
      for (const [kind, records] of [
        ['observation', view.observations],
        ['claim', view.claims],
        ['goal', view.goals],
      ] as const) {
        for (const record of records) {
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
      return view
    } catch (error: unknown) {
      this.#memory.recordCognitiveJobResult(address, characterId, asOfWorldSeq, 'failed', String(error))
      throw error
    }
  }

  prepare(request: PrepareCognitiveContextRequest): CognitiveProposalContext {
    const characterView = this.catchUp(
      request.address, request.characterId, request.asOfWorldSeq, request.correlationId,
    )
    const query = recallQuery(request.playerAction.parameters)
    const memoryRecall = this.#memory.recall(request.address, request.characterId, query, request.asOfWorldSeq)
    const memorySourceRefs = memoryRecall.flatMap(memory => {
      const metadata = memory.metadata as WorldJsonObject
      return [metadata.source as MemorySourceRef]
    }).sort((left, right) => left.sourceKind.localeCompare(right.sourceKind) || left.sourceId.localeCompare(right.sourceId))
    const recallResultHash = hashWorldJson('cognitive-memory-recall', { query, memories: memoryRecall, sources: memorySourceRefs })
    const capability = { actorId: request.characterId, allowedActionTypes: [...request.allowedActionTypes].sort() }
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
    }
    return { ...base, contextHash: hashWorldJson('agent-context-envelope/v2', base) }
  }

  recall(address: WorldAddress, characterId: CharacterId, query: string, asOfWorldSeq: number): RecalledMemory[] {
    this.catchUp(address, characterId, asOfWorldSeq, `memory-recall:${characterId}:${asOfWorldSeq}`)
    return this.#memory.recall(address, characterId, query, asOfWorldSeq)
  }

  job(address: WorldAddress, characterId: CharacterId, asOfWorldSeq: number) {
    return this.#memory.cognitiveJob(address, characterId, asOfWorldSeq)
  }

  close(): void {
    this.#memory.close()
  }
}
