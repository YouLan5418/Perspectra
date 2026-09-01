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
  PHASE8_SUBMIT_ACTIONS_PROFILE,
  compareWorldText,
  deterministicId,
  hashWorldJson,
  type CharacterId,
  type ActionRequest,
  type ContextExclusion,
  type ContextProfileId,
  type ContextReceipt,
  type CharacterCognitionView,
  type ContextSourceRef,
  type ProposalContext,
  type ReactionProposalContext,
  type WorldHash,
  type WorldJsonObject,
  type WorldJsonValue,
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
  /** Present only for Character participants; it is the exact immutable prefix used by Reflection validation. */
  readonly cognition?: CharacterCognitionView
}

export interface Phase8ReactionProviderContext extends ReactionProposalContext {
  readonly agentContextVersion: 2
  readonly participantId: string
  readonly contextReceiptId: string
  readonly contextHash: WorldHash
  readonly providerRequestHash: WorldHash
  readonly exactProviderRequest: ExactProviderRequest
}

export interface PreparedPhase8ReactionParticipant {
  readonly providerContext: Phase8ReactionProviderContext
  readonly receipt: ContextReceipt
  readonly memorySourceRefs: readonly MemorySourceRef[]
  readonly recallResultHash: WorldHash
  readonly cognition: CharacterCognitionView
}

/** Minimum participant identity required to build an NPC-only Reaction Context. */
export interface ReactionContextBinding {
  readonly participantId: string
  readonly role: 'agent' | 'director'
  readonly actorId: CharacterId
  readonly allowedActionTypes: readonly string[]
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
  type: 'object', ...PHASE8_SUBMIT_ACTIONS_PROFILE,
})
const reactionCharacterTool = createProviderToolSchema('submit_actions/v2', {
  type: 'object', ...PHASE8_SUBMIT_ACTIONS_PROFILE, maximumExternalActions: 1,
})
const directorTool = createProviderToolSchema('submit_director_plan/v1', {
  type: 'object', schemaVersion: 'submit_director_plan/v1', maximumDirectives: 8,
})

const compareText = compareWorldText

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

type StoredEvent = ReturnType<WorldStore['readEvents']>[number]

function objectValue(value: WorldJsonValue | undefined): WorldJsonObject | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as WorldJsonObject
    : undefined
}

function eventSceneId(event: StoredEvent): string | undefined {
  const data = objectValue(event.data)
  const sceneId = event.eventType.startsWith('visibility.')
    ? objectValue(data?.value)?.sceneId
    : data?.sceneId
  return typeof sceneId === 'string' ? sceneId : undefined
}

function sceneSources(events: ReturnType<WorldStore['readEvents']>, decision: SceneDecision): ContextSourceRef[] {
  if (decision.sceneId === null) return []
  const members = new Set(decision.memberIds!)
  return events.filter(event => {
    if (event.eventType.startsWith('scene.') || event.eventType.startsWith('visibility.')) {
      return eventSceneId(event) === decision.sceneId
    }
    if (event.eventType !== 'character.created'
      && event.eventType !== 'character.location-changed'
      && event.eventType !== 'character.lifecycle-changed') return false
    const characterId = objectValue(event.data)?.characterId
    return typeof characterId === 'string' && members.has(characterId as CharacterId)
  }).map(event => eventSource(event, 'scene_public_event'))
}

function stimulusExclusion(action: ActionRequest, asOfWorldSeq: number): ContextExclusion {
  const source: ContextSourceRef = {
    sourceKind: 'round_stimulus', sourceId: action.actionId, sourceSeq: asOfWorldSeq,
    sourceHash: hashWorldJson('context-stimulus/v1', action),
  }
  return { reason: 'audience_forbidden', sourceRefHash: hashWorldJson('context-source-ref/v1', source) }
}

function directorSceneInputs(
  events: ReturnType<WorldStore['readEvents']>,
  decision: SceneDecision,
): {
  readonly publicEvents: readonly StoredEvent[]
  readonly targetSources: ReadonlyMap<CharacterId, StoredEvent>
} {
  if (decision.sceneId === null) return { publicEvents: [], targetSources: new Map() }
  const members = new Map<CharacterId, StoredEvent>()
  const publicEvents: StoredEvent[] = []
  for (const event of events) {
    const data = objectValue(event.data)
    if (event.eventType.startsWith('scene.')) {
      if (typeof data?.sceneId !== 'string') throw new TypeError(`${event.eventType} requires sceneId`)
      if (data.sceneId !== decision.sceneId) continue
      publicEvents.push(event)
      if (event.eventType === 'scene.upsert') {
        const value = objectValue(data.value)
        if (!Array.isArray(value?.participantIds)
          || value.participantIds.some(characterId => typeof characterId !== 'string')) {
          throw new TypeError('scene.upsert requires string participantIds')
        }
        members.clear()
        for (const characterId of value.participantIds) members.set(characterId as CharacterId, event)
      } else if (event.eventType === 'scene.member_joined') {
        if (typeof data.characterId !== 'string') throw new TypeError('scene.member_joined requires characterId')
        members.set(data.characterId as CharacterId, event)
      } else if (event.eventType === 'scene.member_left') {
        if (typeof data.characterId !== 'string') throw new TypeError('scene.member_left requires characterId')
        members.delete(data.characterId as CharacterId)
      }
      continue
    }
    if (event.eventType !== 'character.speak') continue
    if (typeof data?.characterId !== 'string' || typeof data.scope !== 'string') {
      throw new TypeError('Phase 8 character.speak requires characterId and scope')
    }
    if (data.scope === 'scene_public' && members.has(data.characterId as CharacterId)) publicEvents.push(event)
  }
  return { publicEvents, targetSources: members }
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
    excludedStimulus?: ActionRequest,
  ): PreparedPhase8Participant {
    sceneContext(decision)
    return binding.role === 'director'
      ? this.#prepareDirector(binding, context, history, decision, asOfWorldSeq, excludedStimulus)
      : this.#prepareCharacter(binding, context, history, decision, asOfWorldSeq, heartbeat, excludedStimulus)
  }

  /** Build an exact Character Context from a frozen Observation bundle without a synthetic player Action. */
  prepareReaction(
    binding: ReactionContextBinding,
    context: ReactionProposalContext,
    history: ReturnType<WorldStore['readEvents']>,
    decision: SceneDecision,
    asOfWorldSeq: number,
    heartbeat: () => void,
  ): PreparedPhase8ReactionParticipant {
    sceneContext(decision)
    if (binding.role !== 'agent') throw new TypeError('Reaction v1 only supports Character Agent participants')
    return this.#prepareReactionCharacter(binding, context, history, decision, asOfWorldSeq, heartbeat)
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
    excludedStimulus?: ActionRequest,
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
    const sceneRefs = sceneSources(history, decision)
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
      includedSourceRefs: assembly.includedSourceRefs,
      exclusions: [
        ...assembly.exclusions,
        ...(excludedStimulus === undefined ? [] : [stimulusExclusion(excludedStimulus, asOfWorldSeq)]),
      ],
      contextHash: assembly.bundle.contextHash, providerRequestHash: rendered.providerRequestHash,
    })
    return this.#result(context, binding, receipt, rendered.exactRequest, prepared.memorySourceRefs, prepared.recallResultHash, cognition)
  }

  #prepareReactionCharacter(
    binding: ReactionContextBinding,
    context: ReactionProposalContext,
    history: ReturnType<WorldStore['readEvents']>,
    decision: SceneDecision,
    asOfWorldSeq: number,
    heartbeat: () => void,
  ): PreparedPhase8ReactionParticipant {
    const prepared = this.options.memory.prepareStimulus({
      address: context.address,
      roundId: context.roundId,
      participantId: binding.participantId,
      characterId: binding.actorId,
      asOfWorldSeq,
      stimulus: context.stimulus,
      correlationId: `context:${context.roundId}:${binding.participantId}`,
      heartbeat,
    })
    if (prepared.recallPlan === undefined || prepared.recall === undefined) {
      throw new TypeError('Reaction Context requires Cognitive Memory v2 Recall receipts')
    }
    const selectedProfile = profileId(this.options.manifest, binding.actorId)
    const checkpoint = this.#checkpoints.latestAt(context.address, binding.actorId, asOfWorldSeq)
      ?? this.#checkpoints.rebuildAt(context.address, binding.actorId, asOfWorldSeq)
    const selectedProfileContract = PHASE8_CONTEXT_PROFILES.find(profile => profile.profileId === selectedProfile)!
    const tail = this.#tails.rebuildAt(
      context.address, binding.actorId, checkpoint.sourceEndSeq, asOfWorldSeq,
      selectedProfileContract.recentInteractionBlocks,
    )
    const affordances: ContextAffordance[] = this.options.rulebook.affordances({
      manifest: this.options.manifest, events: history, characterId: binding.actorId,
    }).filter(value => value.actionType === 'speak' && value.actionVersion === 1
      && binding.allowedActionTypes.includes(value.actionType))
      .map(value => ({ actionType: value.actionType, actionVersion: value.actionVersion }))
    const affordanceHash = hashWorldJson('context-affordances/v1', affordances)
    const scene = sceneContext(decision)
    const cognition = this.#cognition.rebuildCharacterAt(context.address, binding.actorId, asOfWorldSeq)
    const character = this.options.manifest.characters.find(value => value.characterId === binding.actorId)!
    const stimulusSourceRefs: ContextSourceRef[] = context.stimulus.stimuli.map(stimulus => ({
      sourceKind: 'reaction_observation', sourceId: stimulus.observationId,
      sourceSeq: stimulus.sourceEventSeq, sourceHash: stimulus.sourceEventHash,
    }))
    const assembly = this.#assembler.assembleDetailed({
      address: context.address, roundId: context.roundId, participantId: binding.participantId,
      characterId: binding.actorId, controllerId: `provider:${binding.participantId}`, controllerEpoch: 1,
      baseHeadSeq: asOfWorldSeq, asOfWorldSeq, tick: context.tick, manifestHash: this.options.manifestHash,
      contextProfileId: selectedProfile,
      worldPublicAnchor: { metadata: this.options.manifest.metadata, timeMode: this.options.manifest.timeMode },
      characterAnchor: character,
      characterView: prepared.characterView, cognition, checkpoint, tail, sceneDecision: scene,
      sceneSourceRefs: sceneSources(history, decision), recallPlan: prepared.recallPlan, recall: prepared.recall,
      stimulus: context.stimulus, stimulusHash: hashWorldJson('context-stimulus/v1', context.stimulus),
      stimulusSourceRefs, maximumExternalActions: 1,
      affordances, affordanceHash,
      runtimeAvailability: this.options.availability.get(context.address, binding.actorId)?.state ?? 'offline',
      correlationId: `context:${context.roundId}:${binding.participantId}`,
    })
    const rendered = this.#renderer.renderCharacter({
      context: assembly.bundle, contextProfileId: selectedProfile, renderer: rendererLock,
      toolSchema: reactionCharacterTool, modelProfile: this.#model(context.address),
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
    return {
      providerContext: {
        ...context, agentContextVersion: 2, participantId: binding.participantId,
        contextReceiptId: receipt.receiptId, contextHash: receipt.contextHash,
        providerRequestHash: receipt.providerRequestHash, exactProviderRequest: rendered.exactRequest,
      },
      receipt,
      memorySourceRefs: prepared.memorySourceRefs,
      recallResultHash: prepared.recallResultHash,
      cognition,
    }
  }

  #prepareDirector(
    binding: RoundParticipant,
    context: ProposalContext,
    history: ReturnType<WorldStore['readEvents']>,
    decision: SceneDecision,
    asOfWorldSeq: number,
    excludedStimulus?: ActionRequest,
  ): PreparedPhase8Participant {
    const scene = sceneContext(decision)
    const { publicEvents, targetSources } = directorSceneInputs(history, decision)
    const targets = scene.observerIds.map(targetId => {
      const source = targetSources.get(targetId)
      if (source === undefined) throw new TypeError(`Director target ${targetId} requires a durable Scene source proving focal membership`)
      return { targetId, sourceRef: eventSource(source, 'scene_public_event') }
    })
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
      includedSourceRefs: assembly.includedSourceRefs,
      exclusions: [
        ...assembly.exclusions,
        ...(excludedStimulus === undefined ? [] : [stimulusExclusion(excludedStimulus, asOfWorldSeq)]),
      ],
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
    cognition?: CharacterCognitionView,
  ): PreparedPhase8Participant {
    return {
      providerContext: {
        ...context, agentContextVersion: 2, participantId: binding.participantId,
        contextReceiptId: receipt.receiptId, contextHash: receipt.contextHash,
        providerRequestHash: receipt.providerRequestHash, exactProviderRequest,
      },
      receipt, memorySourceRefs, recallResultHash,
      ...(cognition === undefined ? {} : { cognition }),
    }
  }
}
