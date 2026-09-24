import { characterVisibleItems } from './character-visible-items.ts'
import {
  CharacterContextAssembler,
  CharacterContextBudgetPlanner,
  ContextReceiptStore,
  ContinuityCheckpointService,
  DirectorContextAssembler,
  InteractionTailBuilder,
  StructuredPromptRenderer,
  createPromptRendererLock,
  createProviderToolSchema,
  type CharacterSceneContext,
  type ContextAffordance,
  type ContextDigestEntry,
  type CreateContextReceiptRequest,
  type ExactProviderRequest,
  type ProviderModelProfile,
} from '@harness-world/agents'
import {
  PHASE8_CONTEXT_PROFILES,
  compareWorldText,
  createStepManifestationSchema,
  deterministicId,
  hashWorldJson,
  resolutionAuthority,
  type CharacterId,
  type CharacterContinuityCheckpoint,
  type ActionRequest,
  type ContextExclusion,
  type ContextProfileId,
  type ContextReceipt,
  type CharacterCognitionView,
  type ContextSourceRef,
  type InteractionTail,
  type Phase8ContextProfile,
  type ProposalContext,
  type ReactionProposalContext,
  type WorldHash,
  type WorldJsonObject,
  type WorldJsonValue,
} from '@harness-world/contracts'
import {
  manifestUsesFrozenInteractions,
  type CompiledWorldManifest,
  type RulebookResolver,
} from '@harness-world/kernel'
import { type CognitiveMemoryService, type MemorySourceRef } from '@harness-world/memory'
import {
  CognitionProjectionRebuilder,
  type CharacterRuntimeAvailabilityService,
  type WorldStore,
} from '@harness-world/store-sqlite'
import type { RoundParticipant } from './round-coordinator.ts'
import type { SceneDecision } from './scene-decision.ts'
import { provisionalReactionView, provisionalInputEvents, provisionalInputHash, type ProvisionalReactionInput } from './player-provisional.ts'

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
const directorTool = createProviderToolSchema('submit_director_plan/v1', {
  type: 'object', schemaVersion: 'submit_director_plan/v1', maximumDirectives: 8,
})

// The current v10 world speaks one frozen interaction protocol. Keep this shape explicit: its bytes
// are part of the provider request identity, so old tool schemas must not be composed into it.
const frozenInteractionTool = createProviderToolSchema('submit_actions/v7', {
  type: 'object', schemaVersion: 'submit_actions/v7',
  maximumExternalActions: 2, maximumReflectionOperations: 4,
  actionGroup: {
    version: 'bounded-action-group/v2', allowedActionTypes: ['speak', 'move', 'interact'],
    maximumSpeechActions: 2, maximumWorldOperations: 1, order: 'proposal',
    failure: 'stop_remaining_steps', interleaving: 'forbidden',
    newInformationRequiresNextCall: true,
    manifestation: { optional: true, schemasByAction: {
      speak: createStepManifestationSchema('speak'), move: createStepManifestationSchema('move'),
      interact: createStepManifestationSchema('interact'),
    } },
  },
  interact: { parameters: ['targetRef', 'bindingId', 'definitionRef', 'arguments'],
    choices: 'context.affordances.interactions',
    performanceAcceptances: 'context.affordances.performances',
    execution: 'revalidate_current_bound_prefix',
    give: 'possession_transfer_only_no_recipient_consent_or_reaction' },
})
const reactionFrozenInteractionTool = createProviderToolSchema('submit_actions/v7', {
  ...frozenInteractionTool.schema as WorldJsonObject, maximumReflectionOperations: 0,
})

function contextAffordance(value: { readonly actionType: string; readonly actionVersion: number;
  readonly interactions?: readonly WorldJsonObject[]
  readonly destinations?: readonly { readonly locationId: string; readonly name: string }[]
  readonly performances?: readonly WorldJsonObject[] }, decision: SceneDecision): ContextAffordance {
  return { actionType: value.actionType, actionVersion: value.actionVersion,
    ...(value.destinations === undefined ? {} : { destinations: value.destinations }),
    ...(value.performances === undefined ? {} : { performances: value.performances }),
    ...(value.interactions === undefined ? {} : { interactions: value.interactions.filter(choice => {
      const recipient = (choice.arguments as WorldJsonObject).recipientId
      return recipient === undefined || decision.observerIds.includes(recipient as CharacterId)
    }) }) }
}

const compareText = compareWorldText

/**
 * How much of a Context Profile's request budget the second layer may take.
 *
 * The Profile's budget is a hard ceiling on the rendered request, and it is locked by the registry, so the
 * second layer has to live inside it rather than beside it: half the budget for the appended history, the
 * rest for the digest, the current state, the scene and the contracts. A layer that outgrew this would be
 * trimmed back at render time, which is exactly the sliding window this design exists to remove.
 */
const EPOCH_BUDGET_DIVISOR = 2

/**
 * The share of a Context Profile's request budget the long-term digest may take. The digest is Tier 4
 * content, so it is bounded rather than given whatever fits: identity, scene, stimulus and affordances
 * come first in the frozen trim priority, and a digest that ate their room would starve the Round.
 */
const DIGEST_BUDGET_DIVISOR = 8

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
    if (options.memory.version !== 2 || !manifestUsesFrozenInteractions(options.manifest)) {
      throw new TypeError('Context Pipeline requires Manifest v10 and Cognitive Memory v2')
    }
    this.#checkpoints = new ContinuityCheckpointService(options.path, options.store, options.memory)
    this.#receipts = new ContextReceiptStore(options.path)
    this.#tails = new InteractionTailBuilder(options.store)
    this.#cognition = new CognitionProjectionRebuilder(options.store)
    this.#modelProfile = options.modelProfile ?? defaultModelProfile()
  }

  #afforded(value: { readonly actionType: string; readonly actionVersion: number }): boolean {
    if (value.actionType === 'interact') return value.actionVersion === 2
    return value.actionVersion === 1 && (value.actionType === 'speak' || value.actionType === 'move')
  }

  prepare(
    binding: RoundParticipant,
    context: ProposalContext,
    history: ReturnType<WorldStore['readEvents']>,
    decision: SceneDecision,
    asOfWorldSeq: number,
    heartbeat: () => void,
    excludedStimulus?: ActionRequest,
    provisional?: ProvisionalReactionInput,
  ): PreparedPhase8Participant {
    sceneContext(decision)
    return binding.role === 'director'
      ? this.#prepareDirector(binding, context, history, decision, asOfWorldSeq, excludedStimulus, provisional)
      : this.#prepareCharacter(binding, context, history, decision, asOfWorldSeq, heartbeat, excludedStimulus, provisional)
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

  /**
   * Resolve the Continuity baseline, the second layer and the digest for one preparation.
   *
   * The floor is the baseline's source end, so the two always agree. While the blocks appended since that
   * floor fit their budget, the baseline is reused unchanged: the rendered prefix stays byte-identical, and
   * a Provider can reuse everything from the two contracts to the end of the appended history. Only when
   * the second layer outgrows its budget — or when there is no baseline yet — does the floor move once, to
   * just before the Profile's retained window. The Character and the Reaction path both call this, so they
   * cannot drift apart.
   */
  #continuity(
    address: ProposalContext['address'],
    characterId: CharacterId,
    asOfWorldSeq: number,
    profile: Phase8ContextProfile,
  ): {
    readonly checkpoint: CharacterContinuityCheckpoint
    readonly tail: InteractionTail
    readonly digest: readonly ContextDigestEntry[]
  } {
    const existing = this.#checkpoints.latestAt(address, characterId, asOfWorldSeq)
    const floor = existing?.sourceEndSeq ?? asOfWorldSeq
    const window = this.#tails.rebuildWindow(
      address, characterId, floor, asOfWorldSeq, profile.recentInteractionBlocks,
    )
    const budget = Math.floor(profile.maximumRequestBytes / EPOCH_BUDGET_DIVISOR)
    const rebuild = existing === undefined
      || Buffer.byteLength(JSON.stringify(window.tail), 'utf8') > budget
    const chosenFloor = rebuild ? window.rebuiltFloor : floor
    return {
      checkpoint: existing !== undefined && chosenFloor === floor
        ? existing
        : this.#checkpoints.rebuildAt(address, characterId, chosenFloor),
      tail: rebuild ? window.rebuiltTail : window.tail,
      digest: this.#digest(
        address, characterId, chosenFloor,
        Math.floor(profile.maximumRequestBytes / DIGEST_BUDGET_DIVISOR),
      ),
    }
  }

  /**
   * The L1 Summaries covering Rounds the Tail no longer carries, newest kept first when the byte budget
   * runs out. A Summary is taken whole or not at all — a half Summary would be a second, shorter account
   * of the same Rounds. The text is the Summary's own; nothing here re-derives or rewrites it.
   */
  #digest(
    address: ProposalContext['address'],
    characterId: CharacterId,
    tailFloor: number,
    maximumBytes: number,
  ): readonly ContextDigestEntry[] {
    const summaries = this.options.memory.summaries(address, characterId)
      .filter(summary => summary.sourceEndSeq <= tailFloor)
      .sort((left, right) => left.sourceStartSeq - right.sourceStartSeq)
    const selected: ContextDigestEntry[] = []
    let bytes = 0
    for (let index = summaries.length - 1; index >= 0; index -= 1) {
      const summary = summaries[index]!
      const text = summary.extracts.join('\n')
      const size = Buffer.byteLength(text, 'utf8')
      if (bytes + size > maximumBytes) break
      bytes += size
      selected.unshift({
        summaryId: summary.summaryId, sourceStartSeq: summary.sourceStartSeq,
        sourceEndSeq: summary.sourceEndSeq, summaryHash: summary.summaryHash,
        text, sourceRefs: summary.sourceRefs,
      })
    }
    return selected
  }

  #prepareCharacter(
    binding: RoundParticipant,
    context: ProposalContext,
    history: ReturnType<WorldStore['readEvents']>,
    decision: SceneDecision,
    asOfWorldSeq: number,
    heartbeat: () => void,
    excludedStimulus?: ActionRequest,
    provisional?: ProvisionalReactionInput,
  ): PreparedPhase8Participant {
    const legacyStimulus = context.playerManifestation === undefined
      ? context.playerAction
      : { action: context.playerAction, manifestation: context.playerManifestation }
    const stimulus = provisional === undefined ? legacyStimulus : provisionalReactionView(provisional, history)
    const recallAction = provisional === undefined ? context.playerAction : {
      ...context.playerAction, actionType: 'context.provisional-stimulus', parameters: stimulus,
    }
    const prepared = this.options.memory.prepare({
      address: context.address, roundId: context.roundId, tick: context.tick,
      participantId: binding.participantId, characterId: binding.actorId, asOfWorldSeq,
      playerAction: recallAction, candidateHash: context.candidateHash,
      ...(context.playerManifestation === undefined ? {} : { playerManifestation: context.playerManifestation }),
      allowedActionTypes: binding.allowedActionTypes, sceneDecision: decision,
      // The Scene decision is the authority on who is present, so it is also the authority for this clue.
      sceneCharacterIds: decision.observerIds,
      correlationId: `context:${context.roundId}:${binding.participantId}`, heartbeat,
    })
    if (prepared.recallPlan === undefined || prepared.recall === undefined) {
      throw new TypeError('Cognitive Memory v2 did not produce a verified Recall receipt')
    }
    const selectedProfile = profileId(this.options.manifest, binding.actorId)
    const selectedProfileContract = PHASE8_CONTEXT_PROFILES.find(value => value.profileId === selectedProfile)!
    const { checkpoint, tail, digest } = this.#continuity(
      context.address, binding.actorId, asOfWorldSeq, selectedProfileContract,
    )
    const affordances: ContextAffordance[] = this.options.rulebook.affordances({
      manifest: this.options.manifest,
      events: provisional === undefined ? history : [...history, ...provisionalInputEvents(provisional)],
      characterId: binding.actorId,
      manifestHash: this.options.manifestHash,
      asOfWorldSeq,
      resolutionAuthority: resolutionAuthority('agent', 'standard'),
    }).filter(value => binding.allowedActionTypes.includes(value.actionType))
      .map(value => contextAffordance(value, decision))
      .sort((left, right) => compareText(left.actionType, right.actionType))
    const affordanceHash = hashWorldJson('context-affordances/v1', affordances)
    const scene = sceneContext(decision)
    const sceneRefs = sceneSources(history, decision)
    const cognition = this.#cognition.rebuildCharacterAt(context.address, binding.actorId, asOfWorldSeq)
    const character = this.options.manifest.characters.find(value => value.characterId === binding.actorId)!
    const { assembly, rendered } = new CharacterContextBudgetPlanner(
      request => this.#assembler.assembleDetailed(request),
      bundle => this.#renderer.renderCharacter({
        context: bundle, contextProfileId: selectedProfile, renderer: rendererLock,
        toolSchema: frozenInteractionTool, modelProfile: this.#model(context.address),
        correlationId: `render:${context.roundId}:${binding.participantId}`,
      }),
    ).plan({
      address: context.address, roundId: context.roundId, participantId: binding.participantId,
      characterId: binding.actorId, controllerId: `provider:${binding.participantId}`, controllerEpoch: 1,
      baseHeadSeq: asOfWorldSeq, asOfWorldSeq, tick: context.tick, manifestHash: this.options.manifestHash,
      contextProfileId: selectedProfile,
      worldPublicAnchor: { metadata: this.options.manifest.metadata, timeMode: this.options.manifest.timeMode },
      characterAnchor: character,
      characterView: prepared.characterView, cognition, checkpoint, tail, digest,
      sceneItems: characterVisibleItems(this.options.manifest, history, binding.actorId, decision.observerIds),
      sceneDecision: scene, sceneSourceRefs: sceneRefs,
      recallPlan: prepared.recallPlan, recall: prepared.recall,
      stimulus, stimulusHash: hashWorldJson('context-stimulus/v1', stimulus),
      ...(provisional === undefined ? {} : { stimulusSourceRefs: [
        { sourceKind: 'round_stimulus', sourceId: 'player-provisional-resolution', sourceSeq: asOfWorldSeq, sourceHash: provisionalInputHash(provisional) },
        { sourceKind: 'round_stimulus', sourceId: 'player-provisional-view', sourceSeq: asOfWorldSeq, sourceHash: hashWorldJson('context-stimulus/v1', stimulus) },
      ] }),
      affordances, affordanceHash,
      groupedOutput: { tool: 'submit_actions/v7', maximumReflectionOperations: 4 },
      runtimeAvailability: this.options.availability.get(context.address, binding.actorId)?.state ?? 'offline',
      correlationId: `context:${context.roundId}:${binding.participantId}`,
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
    return this.#result({ ...context, playerAction: recallAction }, binding, receipt, rendered.exactRequest, prepared.memorySourceRefs, prepared.recallResultHash, cognition)
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
      sceneCharacterIds: decision.observerIds,
      correlationId: `context:${context.roundId}:${binding.participantId}`,
      heartbeat,
    })
    if (prepared.recallPlan === undefined || prepared.recall === undefined) {
      throw new TypeError('Reaction Context requires Cognitive Memory v2 Recall receipts')
    }
    const selectedProfile = profileId(this.options.manifest, binding.actorId)
    const selectedProfileContract = PHASE8_CONTEXT_PROFILES.find(profile => profile.profileId === selectedProfile)!
    const { checkpoint, tail, digest } = this.#continuity(
      context.address, binding.actorId, asOfWorldSeq, selectedProfileContract,
    )
    const affordances: ContextAffordance[] = this.options.rulebook.affordances({
      manifest: this.options.manifest, events: history, characterId: binding.actorId,
      manifestHash: this.options.manifestHash, asOfWorldSeq,
      resolutionAuthority: resolutionAuthority('agent', 'standard'),
    }).filter(value => this.#afforded(value) && binding.allowedActionTypes.includes(value.actionType))
      .map(value => contextAffordance(value, decision))
      .sort((left, right) => compareText(left.actionType, right.actionType))
    const affordanceHash = hashWorldJson('context-affordances/v1', affordances)
    const scene = sceneContext(decision)
    const cognition = this.#cognition.rebuildCharacterAt(context.address, binding.actorId, asOfWorldSeq)
    const character = this.options.manifest.characters.find(value => value.characterId === binding.actorId)!
    const stimulusSourceRefs: ContextSourceRef[] = context.stimulus.stimuli.map(stimulus => ({
      sourceKind: 'reaction_observation', sourceId: stimulus.observationId,
      sourceSeq: stimulus.sourceEventSeq, sourceHash: stimulus.sourceEventHash,
    }))
    const { assembly, rendered } = new CharacterContextBudgetPlanner(
      request => this.#assembler.assembleDetailed(request),
      bundle => this.#renderer.renderCharacter({
        context: bundle, contextProfileId: selectedProfile, renderer: rendererLock,
        toolSchema: reactionFrozenInteractionTool, modelProfile: this.#model(context.address),
        correlationId: `render:${context.roundId}:${binding.participantId}`,
      }),
    ).plan({
      address: context.address, roundId: context.roundId, participantId: binding.participantId,
      characterId: binding.actorId, controllerId: `provider:${binding.participantId}`, controllerEpoch: 1,
      baseHeadSeq: asOfWorldSeq, asOfWorldSeq, tick: context.tick, manifestHash: this.options.manifestHash,
      contextProfileId: selectedProfile,
      worldPublicAnchor: { metadata: this.options.manifest.metadata, timeMode: this.options.manifest.timeMode },
      characterAnchor: character,
      characterView: prepared.characterView, cognition, checkpoint, tail, digest,
      sceneItems: characterVisibleItems(this.options.manifest, history, binding.actorId, decision.observerIds),
      sceneDecision: scene, sceneSourceRefs: sceneSources(history, decision),
      recallPlan: prepared.recallPlan, recall: prepared.recall,
      stimulus: context.stimulus, stimulusHash: hashWorldJson('context-stimulus/v1', context.stimulus),
      stimulusSourceRefs, maximumExternalActions: 2,
      groupedOutput: { tool: 'submit_actions/v7', maximumReflectionOperations: 0 },
      affordances, affordanceHash,
      runtimeAvailability: this.options.availability.get(context.address, binding.actorId)?.state ?? 'offline',
      correlationId: `context:${context.roundId}:${binding.participantId}`,
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
    provisional?: ProvisionalReactionInput,
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
      publicEntries: [...publicEvents.map(event => ({
        entryId: `${event.eventType}:${event.seq}`, value: event.data,
        sourceRef: eventSource(event, 'scene_public_event'),
      })), ...(provisional === undefined ? [] : [{
        entryId: 'player-provisional', value: provisionalReactionView(provisional, history),
        sourceRef: { sourceKind: 'director_visible', sourceId: 'player-provisional', sourceSeq: asOfWorldSeq,
          sourceHash: hashWorldJson('director-provisional-view/v1', provisionalReactionView(provisional, history)) },
      }])],
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
    const visibleContext = provisional === undefined ? context : { ...context, playerAction: {
      ...context.playerAction, actionType: 'context.provisional-stimulus', parameters: provisionalReactionView(provisional, history),
    } }
    return this.#result(visibleContext, binding, receipt, rendered.exactRequest, [], emptyHash)
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
