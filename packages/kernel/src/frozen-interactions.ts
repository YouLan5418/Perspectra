import {
  compareWorldText,
  hashWorldJson,
  validateResolutionAuthority,
  type InteractionCharacterView,
  type InteractionHostContext,
  type InteractionPackageImplementation,
  type InteractionRef,
  type InteractionTargetRef,
  type InteractionViewOption,
  type RulebookResolutionAuthorityV1,
  type WorldHash,
  type WorldJsonObject,
  type WorldJsonValue,
  ACTION_GROUP_CUES,
  type ActionGroupCue,
  brandId,
  type InteractionRoundId,
  type InteractionPerformanceAcceptance,
} from '@harness-world/contracts'
import { FrozenInteractionWorld, InteractionRegistry } from '@harness-world/interaction-runtime'
import { currentCharacterRelations, currentSceneStates } from './interactions.ts'
import {
  SpeakMoveRulebook,
  currentCharacterLifecycle,
  currentEntityState,
  currentLocation,
  rejectRulebookResolution,
  worldJsonObject,
  type PlayerActionInput,
  type RulebookEvent,
  type RulebookResolution,
} from './rulebook.ts'
import { stepManifestation, resolveManifestation } from './manifestation.ts'
import { manifestUsesFrozenInteractions, type CompiledWorldManifest, type CompiledWorldManifestV10 } from './world-spec.ts'

/** Structurally the Rulebook registry's `ActionAffordance`; declared here to keep the import acyclic. */
export interface FrozenActionAffordance {
  readonly actionType: string
  readonly actionVersion: number
  readonly interactions?: readonly WorldJsonObject[]
  /**
   * Where this character may go, from the world's own locations, for a `move` option. A model that has to
   * invent a destination invents one that does not exist - measured, in a real playtest: the world refused
   * the move and the call was spent - so the places are stated rather than guessed at.
   */
  readonly destinations?: readonly { readonly locationId: string; readonly name: string }[]
  /**
   * What the definitions behind those options accept as a step, one entry per definition, ordered by
   * definition identity. Only definitions that accept something appear: an absent entry and an empty one
   * would mean the same thing to a caller, and the model does not need to be told about either.
   *
   * It is here rather than on each option because it is exactly what a definition's locked policy says -
   * per definition, not per target - and because an option is what a caller turns into request
   * parameters, where a field that is not part of the request would be a trap.
   */
  readonly performances?: readonly InteractionPerformanceAcceptance[]
}

/** What the Host hands the frozen runtime: every candidate target, and the ones this actor may address. */
export interface InteractionHostSnapshot {
  readonly targets: readonly { readonly ref: InteractionTargetRef; readonly state: WorldJsonObject }[]
  readonly authorizedTargets: readonly InteractionTargetRef[]
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.trim() === value ? value : undefined
}

function exactKeys(value: Record<string, WorldJsonValue>, keys: readonly string[]): boolean {
  return Object.keys(value).sort(compareWorldText).join(',') === [...keys].sort(compareWorldText).join(',')
}

/** The candidate prefix is identified by its own contents, never by where it happens to sit. */
function candidatePrefixHash(events: readonly RulebookEvent[]): WorldHash {
  return hashWorldJson('interaction-candidate-prefix/v1', events.map(event => ({
    eventType: event.eventType, eventVersion: event.eventVersion ?? 1, data: event.data,
  })))
}

/**
 * Project one candidate prefix into the snapshot the frozen runtime resolves against, plus the set of
 * targets this actor may currently address.
 *
 * The authorization set is the Host's own reading of "what this character can reach", not a second
 * copy of the definitions' rules: co-located or Scene-sharing characters, items the actor holds or
 * that lie unheld where the actor is, and active relations the actor is a party to. The rules still
 * re-verify each of those, so a guessed identifier is refused here before any rule even runs.
 */
export function interactionHostSnapshot(
  manifest: CompiledWorldManifest,
  events: readonly RulebookEvent[],
  actorId: string,
): InteractionHostSnapshot {
  const scenesByCharacter = new Map<string, string[]>()
  for (const scene of currentSceneStates(events)) {
    if (scene.lifecycle !== 'active') continue
    for (const participantId of scene.participantIds) {
      const list = scenesByCharacter.get(participantId)
      if (list === undefined) scenesByCharacter.set(participantId, [scene.sceneId])
      else list.push(scene.sceneId)
    }
  }
  for (const list of scenesByCharacter.values()) list.sort(compareWorldText)

  const targets: { ref: InteractionTargetRef; state: WorldJsonObject }[] = []
  const characterStates = new Map<string, WorldJsonObject>()
  for (const character of manifest.characters) {
    const characterId = character.characterId as string
    const state: WorldJsonObject = {
      lifecycle: currentCharacterLifecycle(events, characterId) ?? 'missing',
      locationId: currentLocation(events, characterId) ?? null,
      sceneIds: scenesByCharacter.get(characterId) ?? [],
    }
    characterStates.set(characterId, state)
    targets.push({ ref: { kind: 'character', id: characterId }, state })
  }
  const entityStates = new Map<string, WorldJsonObject>()
  for (const entity of manifest.entities) {
    const current = currentEntityState(events, entity.entityId)
    const state: WorldJsonObject = current === undefined
      ? { locationId: null, holderId: null, kind: entity.kind }
      : { locationId: current.locationId, holderId: current.holderId, kind: current.kind }
    entityStates.set(entity.entityId, state)
    targets.push({ ref: { kind: 'entity', id: entity.entityId }, state })
  }
  // Relations keep the four facts the frozen vocabulary names. The relation prefix reader is shared
  // with the closed catalog path rather than duplicated: a second reader could disagree with the first
  // about what a well-formed relation prefix is, and the runtime still has no relation-kind branch.
  const relations = currentCharacterRelations(events)
  for (const relation of relations) {
    targets.push({ ref: { kind: 'relation', id: relation.relationId }, state: {
      interactionId: relation.interactionId, initiatorId: relation.initiatorId,
      targetId: relation.targetId, active: relation.active,
    } })
  }

  const actor = characterStates.get(actorId)
  const actorLocation = actor?.locationId as string | null | undefined
  const actorScenes = actor?.sceneIds as readonly string[] | undefined
  const authorizedTargets: InteractionTargetRef[] = []
  for (const [characterId, state] of characterStates) {
    if (characterId === actorId || actor === undefined || state.lifecycle !== 'active') continue
    const coLocated = typeof actorLocation === 'string' && state.locationId === actorLocation
    const scenes = state.sceneIds as readonly string[]
    const sharesScene = actorScenes !== undefined && scenes.some(scene => actorScenes.includes(scene))
    if (coLocated || sharesScene) authorizedTargets.push({ kind: 'character', id: characterId })
  }
  for (const [entityId, state] of entityStates) {
    if (state.holderId === actorId) authorizedTargets.push({ kind: 'entity', id: entityId })
    else if (state.holderId === null && typeof actorLocation === 'string' && state.locationId === actorLocation) {
      authorizedTargets.push({ kind: 'entity', id: entityId })
    }
  }
  for (const relation of relations) {
    if (relation.active && (relation.initiatorId === actorId || relation.targetId === actorId)) {
      authorizedTargets.push({ kind: 'relation', id: relation.relationId })
    }
  }
  return { targets, authorizedTargets }
}

/** The exact Host facts one frozen resolution needs, gathered from the Rulebook context. */
export interface FrozenInteractionContext {
  readonly publicationCharacters?: number | undefined
  readonly manifest: CompiledWorldManifest
  readonly events: readonly RulebookEvent[]
  readonly characterId: string
  readonly actionId: string | undefined
  /**
   * The Round an accepted performance is recorded against, since a manifestation is a Round-scoped fact.
   * Absent only where a resolution can never produce one - the Host's affordance probes - and then a step
   * that states cues is refused instead of being recorded without a Round.
   */
  readonly roundId: InteractionRoundId | undefined
  readonly manifestHash: WorldHash | undefined
  readonly asOfWorldSeq: number | undefined
  readonly resolutionAuthority: RulebookResolutionAuthorityV1 | undefined
}

/**
 * The Host boundary for an untrusted step. A proposal is model output, so a request naming no binding
 * the world enabled, or a binding whose definition and target it does not actually address, is
 * answered with a rejection rather than handed to the trusted runtime. What survives is a request
 * whose structure the frozen world can refuse on its own terms.
 */
function frozenRequest(
  world: FrozenInteractionWorld,
  manifest: CompiledWorldManifestV10,
  parameters: WorldJsonValue,
  host: InteractionHostContext,
): { readonly request: WorldJsonObject } | { readonly reason: string } {
  const row = worldJsonObject(parameters)
  // A step may state its cues. They are checked here for the vocabulary and shape an interaction may
  // carry at all; whether this definition accepts them is the runtime's decision against its own locked
  // policy, which comes back as a refusal rather than an exception.
  const required = ['targetRef', 'bindingId', 'definitionRef', 'arguments']
  if (row === undefined || !exactKeys(row, Object.hasOwn(row, 'performance') ? [...required, 'performance'] : required)) {
    return { reason: 'INVALID_INTERACTION_PARAMETERS' }
  }
  const performance = row.performance === undefined ? undefined : stepCues(row.performance)
  if (row.performance !== undefined && performance === undefined) return { reason: 'INVALID_INTERACTION_PARAMETERS' }
  // `exactKeys` above already proved all four names are present, so every value check below is about
  // the value itself: a missing key never reaches here and never needs its own branch.
  const bindingId = text(row.bindingId)
  if (bindingId === undefined) return { reason: 'INVALID_INTERACTION_PARAMETERS' }
  const binding = manifest.interactionCatalog.bindings.find(value => value.bindingId === bindingId)
  if (binding === undefined) return { reason: 'INTERACTION_NOT_BOUND' }
  const targetRef = worldJsonObject(row.targetRef as WorldJsonValue)
  const kind = targetRef === undefined ? undefined : targetRef.kind
  const id = targetRef === undefined ? undefined : text(targetRef.id)
  if (targetRef === undefined || !exactKeys(targetRef, ['kind', 'id'])
    || (kind !== 'entity' && kind !== 'character' && kind !== 'relation') || id === undefined) {
    return { reason: 'INVALID_INTERACTION_PARAMETERS' }
  }
  if (binding.targetRef.kind === 'relation') {
    // The binding names the class; the request names the instance. The class is read from the fact the
    // Host already recorded on that instance, so an instance of another class - or one that is not in
    // the snapshot at all - is refused rather than resolved through a binding it does not belong to.
    const entry = kind === 'relation'
      ? host.targets.find(value => value.ref.kind === 'relation' && value.ref.id === id)
      : undefined
    if (entry === undefined || (entry.state as WorldJsonObject).interactionId !== binding.targetRef.id) {
      return { reason: 'INTERACTION_NOT_BOUND' }
    }
  } else if (binding.targetRef.kind !== kind || binding.targetRef.id !== id) {
    return { reason: 'INVALID_INTERACTION_PARAMETERS' }
  }
  const definitionRef = worldJsonObject(row.definitionRef as WorldJsonValue)
  if (definitionRef === undefined || !exactKeys(definitionRef, ['id', 'version'])
    || definitionRef.id !== binding.definitionRef.id || definitionRef.version !== binding.definitionRef.version) {
    return { reason: 'INVALID_INTERACTION_PARAMETERS' }
  }
  const argumentsValue = row.arguments as WorldJsonValue
  // The arguments are checked against the same frozen schema adjudication uses, so a proposal that
  // does not fit its definition is refused here instead of throwing from inside the trusted runtime.
  // A missing binding or a drifted lock still throws: those are integrity failures, not proposals.
  if (!world.acceptsArguments(binding.bindingId, argumentsValue)) return { reason: 'INVALID_INTERACTION_ARGUMENTS' }
  return { request: {
    targetRef: { kind, id }, bindingId: binding.bindingId,
    definitionRef: binding.definitionRef, arguments: argumentsValue,
    ...(performance === undefined ? {} : { performance }),
  } }
}

/**
 * A step's cues, as far as the Host boundary can judge them: the closed vocabulary, minus the voice and
 * gait cues an interaction step may not carry at all, in lists that state no cue twice. Anything else -
 * an unknown code, a cue that needs an action the step is not, a shape the resolver would refuse - is a
 * malformed proposal and belongs on the rejection side of this boundary.
 */
function stepCues(value: WorldJsonValue): { readonly independent: readonly ActionGroupCue[]; readonly onSuccess: readonly ActionGroupCue[] } | undefined {
  const row = worldJsonObject(value)
  if (row === undefined || !exactKeys(row, ['independent', 'onSuccess'])) return undefined
  const read = (input: WorldJsonValue): readonly ActionGroupCue[] | undefined => {
    if (!Array.isArray(input) || input.length > 8) return undefined
    const codes: ActionGroupCue[] = []
    for (const entry of input) {
      const code = text(entry)
      const cue = code === undefined ? undefined : ACTION_GROUP_CUES[code as ActionGroupCue]
      // Speech and gait cues name an action of their own, so an interaction is never their step.
      if (cue === undefined || cue.actionType !== null) return undefined
      codes.push(code as ActionGroupCue)
    }
    if (new Set(codes).size !== codes.length) return undefined
    return codes
  }
  const independent = read(row.independent as WorldJsonValue)
  const onSuccess = read(row.onSuccess as WorldJsonValue)
  return independent === undefined || onSuccess === undefined ? undefined : { independent, onSuccess }
}

/**
 * The frozen interaction path: one installed registry, one frozen world per Manifest, and the single
 * place a v10 candidate set is folded.
 *
 * `interact` resolves through `FrozenInteractionWorld.resolve`, which runs the lifecycle fold itself.
 * `move` is not an interaction, so the shared Rulebook produces the move and this class then hands the
 * result to `FrozenInteractionWorld.fold`. Either way a candidate set is folded exactly once, and no
 * contact semantics live in the Kernel: the handlers the selected definitions declare decide what ends.
 */
export class FrozenInteractionRulebook {
  readonly #registry = new InteractionRegistry()
  readonly #worlds = new Map<string, FrozenInteractionWorld>()
  readonly #base = new SpeakMoveRulebook()

  constructor(packages: readonly InteractionPackageImplementation[]) {
    for (const entry of packages) this.#registry.install(entry)
  }

  /**
   * Freeze the world a Manifest selects, so a Host that is about to write Genesis proves the selection
   * actually closes against what it installed. Registering a version is not the same as being able to
   * resolve it, and a count of installed packages says nothing about whether they are the right ones.
   * `resolve` and `affordances` reuse the same cached world.
   */
  adopt(manifest: CompiledWorldManifest, manifestHash: WorldHash): void {
    if (!manifestUsesFrozenInteractions(manifest)) throw new TypeError('the frozen interaction Rulebook only serves Manifest v10')
    this.#world(manifest, manifestHash)
  }

  #world(manifest: CompiledWorldManifestV10, manifestHash: WorldHash): FrozenInteractionWorld {
    const cached = this.#worlds.get(manifestHash)
    if (cached !== undefined) return cached
    const catalog = manifest.interactionCatalog
    const world = this.#registry.freeze({
      address: manifest.address, packages: catalog.packages,
      definitions: catalog.definitions, bindings: catalog.bindings,
    })
    this.#worlds.set(manifestHash, world)
    return world
  }

  #host(context: FrozenInteractionContext, actionId: string, authority: RulebookResolutionAuthorityV1): InteractionHostContext {
    return {
      address: context.manifest.address,
      manifestHash: context.manifestHash!,
      asOfWorldSeq: context.asOfWorldSeq!,
      candidatePrefixHash: candidatePrefixHash(context.events),
      actionId,
      actorId: context.characterId as InteractionHostContext['actorId'],
      authority,
      ...interactionHostSnapshot(context.manifest, context.events, context.characterId),
    }
  }

  #manifest(context: FrozenInteractionContext): CompiledWorldManifestV10 {
    if (!manifestUsesFrozenInteractions(context.manifest)) throw new TypeError('the frozen interaction Rulebook only serves Manifest v10')
    if (context.manifestHash === undefined || context.asOfWorldSeq === undefined) {
      throw new TypeError('Manifest v10 resolution requires the Host manifest hash and world sequence')
    }
    return context.manifest
  }

  #authority(context: FrozenInteractionContext): RulebookResolutionAuthorityV1 {
    if (context.resolutionAuthority === undefined) throw new TypeError('Manifest v10 resolution requires Host authority')
    return validateResolutionAuthority(context.resolutionAuthority)
  }

  /** One candidate set, folded once. The shared Rulebook owns speech and movement; the world owns the rest. */
  resolve(context: FrozenInteractionContext, action: PlayerActionInput): RulebookResolution {
    const manifest = this.#manifest(context)
    if (context.actionId === undefined) throw new TypeError('Manifest v10 resolution requires an actionId')
    const authority = this.#authority(context)
    if (action.actionType === 'interact') {
      const world = this.#world(manifest, context.manifestHash!)
      const host = this.#host(context, context.actionId, authority)
      const parsed = frozenRequest(world, manifest, action.parameters, host)
      if ('reason' in parsed) {
        // A request that never named a definition has no policy to consult, and naming the reason to the
        // whole Scene would disclose the catalog: whether a binding exists, and for which target. This is
        // not the definition's failure to disclose, so it stays with the actor.
        return { ...rejectRulebookResolution(context.characterId, 'interact', parsed.reason), observationScope: { scope: 'self' } }
      }
      const adjudication = world.resolve(host, parsed.request)
      const interactionTrace: WorldJsonObject = {
        definitionSetHash: adjudication.definitionSetHash,
        resolvedRoleBindingsHash: adjudication.resolvedRoleBindingsHash,
        ruleTraceHash: adjudication.ruleTraceHash,
      }
      const resolvedRoles = adjudication.resolvedRoles
      // The request named the definition lock it addresses, so the evidence can report the same entry
      // the adjudication resolved rather than a second derivation of it.
      const definitionRef = (parsed.request as { definitionRef: InteractionRef }).definitionRef
      const affectedCharacterIds = adjudication.affectedCharacterIds
      // Who may observe the outcome is the definition's own answer, for the status it reached: a world
      // that keeps a refused attempt private declares that, and everyone else observes it as they would
      // observe a success. The rejection fact is written either way.
      const observationScope = adjudication.observationScope
      // An accepted performance is the Host's step to record: the runtime hands over what the definition's
      // policy accepted and contributes no events of its own, and the same shared mapping the action-group
      // path uses turns the cues into the fact. A step nobody declared reads as no step at all.
      const manifestation = stepManifestation(adjudication.performance, adjudication.status === 'accepted')
      if (manifestation !== undefined && context.roundId === undefined) {
        // A step that plays cues has to say which Round it belongs to. This is Host wiring rather than
        // model input: a request that states cues cannot reach here from a Host that withheld the Round.
        throw new TypeError('a manifested interaction step requires the Round it belongs to')
      }
      const manifestationResolution = manifestation === undefined ? undefined : resolveManifestation({
        roundId: context.roundId!, actionId: context.actionId, actorId: brandId(context.characterId, 'CharacterId'),
        manifestation, events: context.events,
      })
      const manifested = manifestationResolution?.events ?? []
      const resolvedManifestation = manifestationResolution === undefined ? {} : {
        manifestation: { proposal: manifestation!, resolution: manifestationResolution },
      }
      return adjudication.status === 'accepted'
        ? { status: 'accepted', events: [...adjudication.events, ...manifested], observationScope,
            interactionTrace, resolvedRoles, definitionRef, affectedCharacterIds, ...resolvedManifestation }
        : { ...rejectRulebookResolution(context.characterId, 'interact', adjudication.reason),
            events: [...rejectRulebookResolution(context.characterId, 'interact', adjudication.reason).events, ...manifested],
            observationScope, interactionTrace, resolvedRoles, definitionRef, affectedCharacterIds, ...resolvedManifestation }
    }
    const resolution = this.#base.resolve(manifest, context.events, context.characterId, action,context.publicationCharacters??2000)
    if (resolution.status !== 'accepted' || action.actionType !== 'move') return resolution
    // A move belongs to no definition, so the world fold runs here: the union of every enabled
    // definition's handlers decide what it ended. v10 has no separate Kernel relation fallback.
    //
    // The fold reasons about the world *after* the move, because the move is what changed reach, so the
    // snapshot it receives is the post-action prefix and the candidate prefix it binds is that same set.
    // An interact is not symmetric: its snapshot is the prefix it was resolved against, and its fold runs
    // inside `resolve()` where the only thing that grows is the candidate event list.
    const postAction = [...context.events, ...resolution.events]
    return {
      ...resolution,
      events: this.#world(manifest, context.manifestHash!).fold(
        this.#host({ ...context, events: postAction }, context.actionId, authority), resolution.events,
      ),
    }
  }

  /** The options this actor may attempt, from the same worlds the adjudication uses. */
  affordances(context: FrozenInteractionContext): readonly FrozenActionAffordance[] {
    const manifest = this.#manifest(context)
    const authority = this.#authority(context)
    // The option list is enumerated under a policy identity that names the world and the runtime
    // revision behind it, so two characters in one world share it and a rebuilt view can prove it.
    const view = this.#world(manifest, context.manifestHash!).view({
      address: manifest.address,
      manifestHash: context.manifestHash!,
      asOfWorldSeq: context.asOfWorldSeq!,
      characterId: context.characterId as InteractionCharacterView['characterId'],
      authority,
      candidatePrefixHash: candidatePrefixHash(context.events),
      viewPolicyHash: hashWorldJson('interaction-view-policy/v1', { manifestHash: context.manifestHash!, manifestVersion: 10 }),
      ...interactionHostSnapshot(manifest, context.events, context.characterId),
    })
    // The move rule itself decides where this character may go - a target that is not a location, or the one
    // it is standing in, is not a move - so the options are asked of it rather than restated here.
    const destinations = manifest.locations
      .filter(location => this.#base.resolve(manifest, context.events, context.characterId, {
        actionType: 'move', parameters: { locationId: location.locationId },
      }).status === 'accepted')
      .map(location => ({ locationId: location.locationId, name: location.name }))
    return [
      { actionType: 'speak', actionVersion: 1 },
      { actionType: 'move', actionVersion: 1,
        ...(destinations.length === 0 ? {} : { destinations }) },
      {
        actionType: 'interact', actionVersion: 2,
        interactions: view.options.map((option: InteractionViewOption) => ({ ...option })),
        performances: view.performances.filter(entry => entry.accepted.length > 0),
      },
    ]
  }
}
