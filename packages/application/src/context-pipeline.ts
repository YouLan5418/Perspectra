import {
  CharacterContextAssembler,
  ContextReceiptStore,
  ContinuityCheckpointService,
  DirectorContextAssembler,
  InteractionTailBuilder,
  StructuredPromptRenderer,
  createPromptRendererLock,
  createProviderToolSchema,
  type CharacterSceneContext,
  type ContextAffordance,
  type CreateContextReceiptRequest,
  type ExactProviderRequest,
  type ProviderModelProfile,
} from '@harness-world/agents'
import {
  PHASE8_CONTEXT_PROFILES,
  deterministicId,
  hashWorldJson,
  type CharacterId,
  type ContextProfileId,
  type ContextReceipt,
  type ContextSourceRef,
  type ProposalContext,
  type WorldHash,
  type WorldJsonObject,
} from '@harness-world/contracts'
import type { CompiledWorldManifest, RulebookResolver } from '@harness-world/kernel'
import { type CognitiveMemoryService, type MemorySourceRef } from '@harness-world/memory'
import {
  CognitionProjectionRebuilder,
  type CharacterRuntimeAvailabilityService,
  type WorldStore,
} from '@harness-world/store-sqlite'
import type { RoundParticipant } from './round-coordinator.ts'
import type { SceneDecision } from './scene-decision.ts'

export interface Phase8ProviderContext extends ProposalContext, WorldJsonObject {
  readonly agentContextVersion: 2
  readonly participantId: string
  readonly contextReceiptId: string
  readonly contextHash: WorldHash
  readonly providerRequestHash: WorldHash
  readonly exactProviderRequest: ExactProviderRequest
}

export interface PreparedPhase8Participant {
  readonly providerContext: Phase8ProviderContext
  readonly receipt: ContextReceipt
  readonly memorySourceRefs: readonly MemorySourceRef[]
  readonly recallResultHash: WorldHash
}

export interface Phase8ContextPipelineOptions {
  readonly path: string
  readonly store: WorldStore
  readonly memory: CognitiveMemoryService
  readonly availability: CharacterRuntimeAvailabilityService
  readonly manifest: CompiledWorldManifest
  readonly manifestHash: WorldHash
  readonly rulebook: RulebookResolver
  readonly modelProfile?: ProviderModelProfile
}

const rendererLock = createPromptRendererLock()
const characterTool = createProviderToolSchema('submit_actions/v2', {
  type: 'object', schemaVersion: 'submit_actions/v2', maximumExternalActions: 2, maximumReflectionOperations: 4,
})
const directorTool = createProviderToolSchema('submit_director_plan/v1', {
  type: 'object', schemaVersion: 'submit_director_plan/v1', maximumDirectives: 8,
})

function compareText(left: string, right: string): number {
  return Number(left > right) - Number(left < right)
}

function defaultModelProfile(): ProviderModelProfile {
  return {
    providerId: 'scripted-provider', modelId: 'scripted-provider/v1',
    maximumInputBytes: 192 * 1024, contextWindowBytes: 256 * 1024,
    outputReserveBytes: 16 * 1024, safetyReserveBytes: 16 * 1024, minimumToolOutputBytes: 1024,
    sampling: { temperaturePermille: 0 }, providerUserPartitionValue: 'replace-at-render',
  }
}

function sceneContext(decision: SceneDecision): CharacterSceneContext {
  if (decision.schemaVersion !== 'scene-decision/v2' || decision.memberIds === undefined
    || decision.directorEligible === undefined || decision.decisionHash === undefined) {
    throw new TypeError('Phase 8 Context requires Scene Decision v2')
  }
  return {
    schemaVersion: decision.schemaVersion, sceneId: decision.sceneId, memberIds: decision.memberIds,
    observerIds: decision.observerIds, schedulableCharacterIds: decision.schedulableCharacterIds,
    visibleResultCharacterIds: decision.visibleResultCharacterIds,
    directorEligible: decision.directorEligible, asOfSeq: decision.asOfSeq, decisionHash: decision.decisionHash,
  }
}

function eventSource(event: ReturnType<WorldStore['readEvents']>[number], sourceKind: string): ContextSourceRef {
  return {
    sourceKind, sourceId: `event:${event.seq}`, sourceSeq: event.seq, sourceHash: event.eventHash,
  }
}

function sceneSources(events: ReturnType<WorldStore['readEvents']>): ContextSourceRef[] {
  return events.filter(event => event.eventType.startsWith('scene.')
    || event.eventType.startsWith('visibility.')
    || event.eventType === 'character.created'
    || event.eventType === 'character.location-changed'
    || event.eventType === 'character.lifecycle-changed')
    .map(event => eventSource(event, 'scene_public_event'))
}

function profileId(manifest: CompiledWorldManifest, characterId: CharacterId): ContextProfileId {
  if (manifest.contentPack?.schemaVersion !== 2) return 'standard'
  const entry = manifest.contentPack.memory.map(value => (
    typeof value === 'object' && value !== null && !Array.isArray(value) ? value as WorldJsonObject : undefined
  )).find(value => value?.characterId === characterId)
  return entry?.profile === 'compact' || entry?.profile === 'standard' || entry?.profile === 'deep'
    ? entry.profile
    : 'standard'
}

function profileHash(id: ContextProfileId): WorldHash {
  const value = PHASE8_CONTEXT_PROFILES.find(profile => profile.profileId === id)!
  return hashWorldJson('context-profile/v1', value)
}

function versionLocks(participantKind: 'character' | 'director') {
  return {
    contextSchema: participantKind === 'character' ? 'character-controller/v2' as const : 'director-planning/v1' as const,
    contextReceiptSchema: 'context-receipt/v1' as const,
    sceneDecisionSchema: 'scene-decision/v2', memorySchema: 'cognitive-memory/v2',
    checkpointSchema: 'continuity-checkpoint/v1', rendererSchema: 'structured-prompt-renderer/v1',
  }
}

/** Formal Phase 8 composition path from verified projections to exact Provider bytes and a durable receipt. */
export class Phase8ContextPipeline {
  readonly #checkpoints: ContinuityCheckpointService
  readonly #tails: InteractionTailBuilder
  readonly #receipts: ContextReceiptStore
  readonly #cognition: CognitionProjectionRebuilder
  readonly #assembler = new CharacterContextAssembler()
  readonly #director = new DirectorContextAssembler()
  readonly #renderer = new StructuredPromptRenderer()
  readonly #modelProfile: ProviderModelProfile

  constructor(private readonly options: Phase8ContextPipelineOptions) {
    if (options.memory.version !== 2 || options.manifest.schemaVersion !== 4) {
      throw new TypeError('Phase 8 Context Pipeline requires Manifest v4 and Cognitive Memory v2')
    }
    this.#checkpoints = new ContinuityCheckpointService(options.path, options.store, options.memory)
    this.#receipts = new ContextReceiptStore(options.path)
    this.#tails = new InteractionTailBuilder(options.store)
    this.#cognition = new CognitionProjectionRebuilder(options.store)
    this.#modelProfile = options.modelProfile ?? defaultModelProfile()
  }

  prepare(
    binding: RoundParticipant,
    context: ProposalContext,
    history: ReturnType<WorldStore['readEvents']>,
    decision: SceneDecision,
    asOfWorldSeq: number,
    heartbeat: () => void,
  ): PreparedPhase8Participant {
    sceneContext(decision)
    return binding.role === 'director'
      ? this.#prepareDirector(binding, context, history, decision, asOfWorldSeq)
      : this.#prepareCharacter(binding, context, history, decision, asOfWorldSeq, heartbeat)
  }

  close(): void {
    this.#receipts.close()
    this.#checkpoints.close()
  }

  #model(address: ProposalContext['address']): ProviderModelProfile {
    return {
      ...this.#modelProfile,
      providerUserPartitionValue: deterministicId('provider-user-partition/v1', {
        tenantId: address.tenantId, worldId: address.worldId,
      }),
    }
  }

  #prepareCharacter(
    binding: RoundParticipant,
    context: ProposalContext,
    history: ReturnType<WorldStore['readEvents']>,
    decision: SceneDecision,
    asOfWorldSeq: number,
    heartbeat: () => void,
  ): PreparedPhase8Participant {
    const prepared = this.options.memory.prepare({
      address: context.address, roundId: context.roundId, tick: context.tick,
      participantId: binding.participantId, characterId: binding.actorId, asOfWorldSeq,
      playerAction: context.playerAction, candidateHash: context.candidateHash,
      allowedActionTypes: binding.allowedActionTypes, sceneDecision: decision,
      correlationId: `context:${context.roundId}:${binding.participantId}`, heartbeat,
    })
    if (prepared.recallPlan === undefined || prepared.recall === undefined) {
      throw new TypeError('Cognitive Memory v2 did not produce a verified Recall receipt')
    }
    const selectedProfile = profileId(this.options.manifest, binding.actorId)
    const checkpoint = this.#checkpoints.latestAt(context.address, binding.actorId, asOfWorldSeq)
      ?? this.#checkpoints.rebuildAt(context.address, binding.actorId, asOfWorldSeq)
    const selectedProfileContract = PHASE8_CONTEXT_PROFILES.find(value => value.profileId === selectedProfile)!
    const tail = this.#tails.rebuildAt(
      context.address, binding.actorId, checkpoint.sourceEndSeq, asOfWorldSeq,
      selectedProfileContract.recentInteractionBlocks,
    )
    const affordances: ContextAffordance[] = this.options.rulebook.affordances({
      manifest: this.options.manifest, events: history, characterId: binding.actorId,
    }).filter(value => binding.allowedActionTypes.includes(value.actionType))
      .map(value => ({ actionType: value.actionType, actionVersion: value.actionVersion }))
      .sort((left, right) => compareText(left.actionType, right.actionType))
    const affordanceHash = hashWorldJson('context-affordances/v1', affordances)
    const scene = sceneContext(decision)
    const sceneRefs = sceneSources(history)
    const cognition = this.#cognition.rebuildCharacterAt(context.address, binding.actorId, asOfWorldSeq)
    const character = this.options.manifest.characters.find(value => value.characterId === binding.actorId)!
    const assembly = this.#assembler.assembleDetailed({
      address: context.address, roundId: context.roundId, participantId: binding.participantId,
      characterId: binding.actorId, controllerId: `provider:${binding.participantId}`, controllerEpoch: 1,
      baseHeadSeq: asOfWorldSeq, asOfWorldSeq, tick: context.tick, manifestHash: this.options.manifestHash,
      contextProfileId: selectedProfile,
      worldPublicAnchor: { metadata: this.options.manifest.metadata, timeMode: this.options.manifest.timeMode },
      characterAnchor: character,
      characterView: prepared.characterView, cognition, checkpoint, tail, sceneDecision: scene,
      sceneSourceRefs: sceneRefs, recallPlan: prepared.recallPlan, recall: prepared.recall,
      stimulus: context.playerAction, stimulusHash: hashWorldJson('context-stimulus/v1', context.playerAction),
      affordances, affordanceHash,
      runtimeAvailability: this.options.availability.get(context.address, binding.actorId)?.state ?? 'offline',
      correlationId: `context:${context.roundId}:${binding.participantId}`,
    })
    const rendered = this.#renderer.renderCharacter({
      context: assembly.bundle, contextProfileId: selectedProfile, renderer: rendererLock,
      toolSchema: characterTool, modelProfile: this.#model(context.address),
      correlationId: `render:${context.roundId}:${binding.participantId}`,
    })
    const receipt = this.#receipts.append({
      address: context.address, roundId: context.roundId, participantKind: 'character',
      participantId: binding.participantId, subjectCharacterId: binding.actorId,
      controllerId: `provider:${binding.participantId}`, controllerEpoch: 1,
      baseHeadSeq: asOfWorldSeq, asOfWorldSeq, tick: context.tick, manifestHash: this.options.manifestHash,
      contextProfileId: selectedProfile, contextProfileHash: assembly.contextProfileHash,
      versionLocks: versionLocks('character'), componentHashes: assembly.componentHashes,
      includedSourceRefs: assembly.includedSourceRefs, exclusions: assembly.exclusions,
      contextHash: assembly.bundle.contextHash, providerRequestHash: rendered.providerRequestHash,
    })
    return this.#result(context, binding, receipt, rendered.exactRequest, prepared.memorySourceRefs, prepared.recallResultHash)
  }

  #prepareDirector(
    binding: RoundParticipant,
    context: ProposalContext,
    history: ReturnType<WorldStore['readEvents']>,
    decision: SceneDecision,
    asOfWorldSeq: number,
  ): PreparedPhase8Participant {
    const scene = sceneContext(decision)
    const sources = sceneSources(history)
    const publicEvents = history.filter(event => event.eventType.startsWith('scene.') || event.eventType === 'character.speak')
    if (scene.observerIds.length > 0 && sources.length === 0) {
      throw new TypeError('Director targets require a durable Scene source')
    }
    const targets = scene.observerIds.map((targetId, index) => ({
      targetId,
      sourceRef: sources[index % sources.length]!,
    }))
    const assembly = this.#director.assembleDetailed({
      address: context.address, roundId: context.roundId, participantId: binding.participantId,
      controllerId: `provider:${binding.participantId}`, controllerEpoch: 1,
      baseHeadSeq: asOfWorldSeq, asOfWorldSeq, tick: context.tick, manifestHash: this.options.manifestHash,
      contextProfileId: 'standard', sceneDecision: scene,
      publicEntries: publicEvents.map(event => ({
        entryId: `${event.eventType}:${event.seq}`, value: event.data,
        sourceRef: eventSource(event, 'scene_public_event'),
      })),
      dramaticSignals: [], environmentAffordances: [...binding.allowedActionTypes],
      directiveTargets: targets, correlationId: `context:${context.roundId}:${binding.participantId}`,
    })
    const rendered = this.#renderer.renderDirector({
      context: assembly.context, contextProfileId: 'standard', renderer: rendererLock,
      toolSchema: directorTool, modelProfile: this.#model(context.address),
      correlationId: `render:${context.roundId}:${binding.participantId}`,
    })
    const emptyHash = hashWorldJson('director-context-empty-component/v1', {})
    const receiptRequest: CreateContextReceiptRequest = {
      address: context.address, roundId: context.roundId, participantKind: 'director',
      participantId: binding.participantId, subjectCharacterId: null,
      controllerId: `provider:${binding.participantId}`, controllerEpoch: 1,
      baseHeadSeq: asOfWorldSeq, asOfWorldSeq, tick: context.tick, manifestHash: this.options.manifestHash,
      contextProfileId: 'standard', contextProfileHash: profileHash('standard'),
      versionLocks: versionLocks('director'),
      componentHashes: {
        characterViewHash: null, sceneDecisionHash: assembly.sceneDecisionHash, checkpointHash: null,
        tailHash: emptyHash, recallHash: emptyHash,
        affordanceHash: hashWorldJson('context-affordances/v1', [...binding.allowedActionTypes].sort(compareText)),
      },
      includedSourceRefs: assembly.includedSourceRefs, exclusions: assembly.exclusions,
      contextHash: assembly.context.contextHash, providerRequestHash: rendered.providerRequestHash,
    }
    const receipt = this.#receipts.append(receiptRequest)
    return this.#result(context, binding, receipt, rendered.exactRequest, [], emptyHash)
  }

  #result(
    context: ProposalContext,
    binding: RoundParticipant,
    receipt: ContextReceipt,
    exactProviderRequest: ExactProviderRequest,
    memorySourceRefs: readonly MemorySourceRef[],
    recallResultHash: WorldHash,
  ): PreparedPhase8Participant {
    return {
      providerContext: {
        ...context, agentContextVersion: 2, participantId: binding.participantId,
        contextReceiptId: receipt.receiptId, contextHash: receipt.contextHash,
        providerRequestHash: receipt.providerRequestHash, exactProviderRequest,
      },
      receipt, memorySourceRefs, recallResultHash,
    }
  }
}
