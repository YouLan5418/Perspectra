import {
  compareWorldText,
  hashWorldJson,
  validateResolutionAuthority,
  type InteractionCharacterView,
  type InteractionHostContext,
  type InteractionPackageImplementation,
  type InteractionTargetRef,
  type InteractionViewOption,
  type RulebookResolutionAuthorityV1,
  type WorldHash,
  type WorldJsonObject,
  type WorldJsonValue,
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
import { manifestUsesFrozenInteractions, type CompiledWorldManifest, type CompiledWorldManifestV10 } from './world-spec.ts'

/** Structurally the Rulebook registry's `ActionAffordance`; declared here to keep the import acyclic. */
export interface FrozenActionAffordance {
  readonly actionType: string
  readonly actionVersion: number
  readonly interactions?: readonly WorldJsonObject[]
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
  readonly manifest: CompiledWorldManifest
  readonly events: readonly RulebookEvent[]
  readonly characterId: string
  readonly actionId: string | undefined
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
  if (row === undefined || !exactKeys(row, ['targetRef', 'bindingId', 'definitionRef', 'arguments'])) {
    // A manifestation on an interaction step is refused rather than dropped: the Host still owes the
    // step that turns an accepted performance into an observation fact, and accepting one now would
    // claim something happened that nobody recorded.
    return { reason: row !== undefined && Object.hasOwn(row, 'performance')
      ? 'INTERACTION_PERFORMANCE_NOT_SUPPORTED' : 'INVALID_INTERACTION_PARAMETERS' }
  }
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
  } }
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
  readonly #legacy = new SpeakMoveRulebook()

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
        return { ...rejectRulebookResolution(context.characterId, 'interact', parsed.reason), observationScope: { scope: 'self' } }
      }
      const adjudication = world.resolve(host, parsed.request)
      const interactionTrace: WorldJsonObject = {
        definitionSetHash: adjudication.definitionSetHash,
        resolvedRoleBindingsHash: adjudication.resolvedRoleBindingsHash,
        ruleTraceHash: adjudication.ruleTraceHash,
      }
      return adjudication.status === 'accepted'
        ? { status: 'accepted', events: adjudication.events, observationScope: { scope: 'scene_public' }, interactionTrace }
        : { ...rejectRulebookResolution(context.characterId, 'interact', adjudication.reason),
            observationScope: { scope: 'self' }, interactionTrace }
    }
    const resolution = this.#legacy.resolve(manifest, context.events, context.characterId, action, {
      actionId: context.actionId, resolutionAuthority: authority,
    })
    if (resolution.status !== 'accepted' || action.actionType !== 'move') return resolution
    // A move belongs to no definition, so the world fold runs here: the union of every enabled
    // definition's handlers decides what it ended. `endCharacterRelations` is deliberately not called -
    // v10 has no Kernel-side relation semantics left to fall back to.
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
    return [
      { actionType: 'speak', actionVersion: 1 },
      { actionType: 'move', actionVersion: 1 },
      {
        actionType: 'interact', actionVersion: 2,
        interactions: view.options.map((option: InteractionViewOption) => ({ ...option })),
      },
    ]
  }
}
