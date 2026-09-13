import type { ActionGroupCue } from './action-group.ts'
import type { CharacterId } from './ids.ts'
import type { WorldAddress, WorldEventDraft } from './protocol.ts'
import type { RulebookResolutionAuthorityV1 } from './resolution-authority.ts'
import type { WorldHash, WorldJsonObject } from './world-json.ts'

export interface InteractionRef extends WorldJsonObject {
  readonly id: string
  readonly version: number
}

export interface InteractionTargetRef extends WorldJsonObject {
  readonly kind: 'character' | 'entity' | 'relation'
  readonly id: string
}

export type InteractionField =
  | { readonly name: string; readonly type: 'boolean' }
  | { readonly name: string; readonly type: 'integer'; readonly minimum: number; readonly maximum: number }
  | { readonly name: string; readonly type: 'string'; readonly maxBytes: number; readonly values: readonly string[] }

export interface InteractionParameterSchema extends WorldJsonObject {
  readonly fields: readonly InteractionField[]
}

/**
 * Where a role's object comes from. `derived` is the only source the request cannot name: a relation
 * target already carries its participants, so a definition can bind "the other participant" without
 * the model identifying them. The resolver is a registered, locked component like a rule.
 */
export type InteractionRoleSource =
  | { readonly kind: 'hostActor' }
  | { readonly kind: 'primaryTarget' }
  | { readonly kind: 'argument'; readonly field: string }
  | { readonly kind: 'derived'; readonly resolver: InteractionRef }

export interface InteractionRole extends WorldJsonObject {
  readonly name: string
  readonly kind: InteractionTargetRef['kind']
  readonly source: InteractionRoleSource
  readonly distinctFrom: readonly string[]
}

/** Serializable I1 object-definition contract. Relation-derived slots follow in I3. */
export interface InteractionDefinitionSpec extends WorldJsonObject {
  readonly versionTag: 'interaction-definition/v1'
  readonly id: string
  readonly version: number
  readonly participantRoles: readonly InteractionRole[]
  readonly argumentSchema: InteractionParameterSchema
  readonly bindingConfigSchema: InteractionParameterSchema
  readonly authorityPolicyRef: InteractionRef
  readonly preconditions: readonly InteractionRef[]
  readonly spatialRequirementRefs: readonly InteractionRef[]
  readonly effectBuilderRef: InteractionRef
  readonly effectCapabilityRefs: readonly InteractionRef[]
  readonly dependencyRefs: readonly InteractionRef[]
  /** Registered performance policy. It decides whether this definition accepts a manifestation at all. */
  readonly performancePolicyRef: InteractionRef
  readonly limits: { readonly maximumEvents: number }
}

/**
 * One cue a definition accepts. `placement` mirrors the frozen independent/onSuccess split, and
 * `requiresRole` names the participant role whose state has to hold for the cue to mean anything:
 * without it a cue could describe an object the actor does not actually hold, which is how a
 * manifestation would smuggle in a fact nobody established.
 */
export interface InteractionPerformanceCueBinding extends WorldJsonObject {
  readonly cue: ActionGroupCue
  readonly placement: 'independent' | 'onSuccess' | 'both'
  readonly requiresRole: string | null
}

/**
 * `interaction-performance/v1` never redefines the cue vocabulary: it only narrows the existing
 * eight codes to what one definition accepts, and where. The old table and its normalization are
 * untouched, so an old world is never handed a new meaning.
 */
export interface InteractionPerformancePolicyV1 extends WorldJsonObject {
  readonly version: 'interaction-performance/v1'
  readonly accepted: readonly InteractionPerformanceCueBinding[]
}

/** The submitted manifestation. It reuses the frozen two-list shape, so normalization is shared. */
export interface InteractionPerformance extends WorldJsonObject {
  readonly independent: readonly ActionGroupCue[]
  readonly onSuccess: readonly ActionGroupCue[]
}

export interface InteractionBindingV3 extends WorldJsonObject {
  readonly bindingId: string
  readonly targetRef: InteractionTargetRef
  readonly definitionRef: InteractionRef
  readonly config: WorldJsonObject
}

export interface InteractionRequestV2 extends WorldJsonObject {
  readonly targetRef: InteractionTargetRef
  readonly bindingId: string
  readonly definitionRef: InteractionRef
  readonly arguments: WorldJsonObject
  /** Absent means the step carries no manifestation. The Host re-verifies it against the policy. */
  readonly performance?: InteractionPerformance
}

/** Supplied by the Host from one candidate prefix, never from the Action payload. */
export interface InteractionHostContext extends WorldJsonObject {
  readonly address: WorldAddress
  readonly manifestHash: WorldHash
  readonly asOfWorldSeq: number
  readonly candidatePrefixHash: WorldHash
  readonly actionId: string
  readonly actorId: CharacterId
  readonly authority: RulebookResolutionAuthorityV1
  readonly targets: readonly { readonly ref: InteractionTargetRef; readonly state: WorldJsonObject }[]
  /** The Host authorizes every auxiliary target, not just the primary one. */
  readonly authorizedTargets: readonly InteractionTargetRef[]
}

export interface InteractionExecutionContext extends WorldJsonObject {
  readonly host: InteractionHostContext
  readonly definition: InteractionDefinitionSpec
  readonly binding: InteractionBindingV3
  readonly arguments: WorldJsonObject
  readonly roles: { readonly [name: string]: InteractionTargetRef }
}

export interface InteractionImplementationLock extends WorldJsonObject {
  readonly ref: InteractionRef
  readonly implementationHash: WorldHash
  readonly dependencies: readonly InteractionRef[]
}

export interface InteractionRuleImplementation {
  readonly lock: InteractionImplementationLock
  /** null means accepted; a stable reason means domain rejection. */
  readonly check: (context: InteractionExecutionContext) => string | null
}

/**
 * Resolves a derived role against the candidate snapshot. It sees only the roles resolved before it
 * in declaration order, which keeps the resolution order deterministic and cycle-free by
 * construction; returning null means the role cannot bind and the proposal is rejected.
 */
export interface InteractionDerivedResolverImplementation {
  readonly lock: InteractionImplementationLock
  readonly resolve: (context: InteractionExecutionContext) => InteractionTargetRef | null
}

/** A registered, locked policy. The runtime only narrows submitted cues against it. */
export interface InteractionPerformanceImplementation {
  readonly lock: InteractionImplementationLock
  readonly policy: InteractionPerformancePolicyV1
}

export interface InteractionEffectImplementation {
  readonly lock: InteractionImplementationLock
  readonly eventTypes: readonly InteractionRef[]
  readonly build: (context: InteractionExecutionContext) => readonly WorldEventDraft[]
  /** Domain validates the entire event group against the prefix and resolved roles. */
  readonly validate: (context: InteractionExecutionContext, events: readonly WorldEventDraft[]) => void
}

export interface InteractionDefinitionImplementation extends WorldJsonObject {
  readonly spec: InteractionDefinitionSpec
  readonly implementationHash: WorldHash
}

export interface InteractionPackageImplementation {
  readonly lock: InteractionImplementationLock
  readonly rules: readonly InteractionRuleImplementation[]
  readonly effects: readonly InteractionEffectImplementation[]
  readonly resolvers: readonly InteractionDerivedResolverImplementation[]
  readonly performances: readonly InteractionPerformanceImplementation[]
  readonly definitions: readonly InteractionDefinitionImplementation[]
}

export interface InteractionWorldSelection extends WorldJsonObject {
  readonly address: WorldAddress
  readonly packages: readonly InteractionImplementationLock[]
  readonly definitions: readonly { readonly ref: InteractionRef; readonly definitionHash: WorldHash; readonly implementationHash: WorldHash }[]
  readonly bindings: readonly InteractionBindingV3[]
}

/**
 * Data-only projection of an installed package. Compiling a world needs the locks and the
 * definition descriptions, never the rule or effect functions, so a compile step can accept this
 * without depending on the runtime that installs the implementations.
 */
export interface InteractionPackageDescription extends WorldJsonObject {
  readonly lock: InteractionImplementationLock
  readonly definitions: readonly InteractionDefinitionImplementation[]
}

export function interactionPackageDescription(input: InteractionPackageImplementation): InteractionPackageDescription {
  return {
    lock: input.lock,
    definitions: input.definitions.map(definition => ({ spec: definition.spec, implementationHash: definition.implementationHash })),
  }
}

/**
 * The compiled world's interaction catalog. It is the world selection without an address: the
 * address is bound when a Host opens the world, so one compiled artifact can serve several
 * addresses without recompiling.
 */
export interface InteractionCatalogV3 extends WorldJsonObject {
  readonly version: 'interaction-catalog/v3'
  readonly packages: readonly InteractionImplementationLock[]
  readonly definitions: readonly { readonly ref: InteractionRef; readonly definitionHash: WorldHash; readonly implementationHash: WorldHash }[]
  readonly bindings: readonly InteractionBindingV3[]
}

export interface InteractionAdjudication extends WorldJsonObject {
  readonly status: 'accepted' | 'rejected'
  readonly reason: string
  readonly events: readonly WorldEventDraft[]
  readonly definitionSetHash: WorldHash
  readonly resolvedRoleBindingsHash: WorldHash
  readonly trace: readonly { readonly rule: InteractionRef; readonly reason: string | null }[]
  readonly ruleTraceHash: WorldHash
  /**
   * The performance the policy accepted, or null. It contributes no events: the adjudication's
   * events still come only from the effect builder, and turning an accepted performance into a
   * memorable observation fact stays the Host's step, exactly as it does for the action group path.
   */
  readonly performance: InteractionPerformance | null
}

/**
 * The Host's read-only input for one character's view. It carries the same candidate snapshot the
 * adjudication would use, so an option surviving here is still only a proposal: the real
 * adjudication re-verifies it against the latest candidate prefix.
 */
export interface InteractionViewContext extends WorldJsonObject {
  readonly address: WorldAddress
  readonly manifestHash: WorldHash
  readonly asOfWorldSeq: number
  readonly characterId: CharacterId
  readonly authority: RulebookResolutionAuthorityV1
  readonly candidatePrefixHash: WorldHash
  readonly targets: readonly { readonly ref: InteractionTargetRef; readonly state: WorldJsonObject }[]
  readonly authorizedTargets: readonly InteractionTargetRef[]
  /** Host-owned cropping policy identity; changes when the cropping rules change. */
  readonly viewPolicyHash: WorldHash
}

/** What one offered definition accepts as a manifestation, so the model schema can constrain it. */
export interface InteractionPerformanceAcceptance extends WorldJsonObject {
  readonly definitionRef: InteractionRef
  readonly accepted: readonly InteractionPerformanceCueBinding[]
}

export interface InteractionViewOption extends WorldJsonObject {
  readonly targetRef: InteractionTargetRef
  readonly bindingId: string
  readonly definitionRef: InteractionRef
  readonly arguments: WorldJsonObject
}

/**
 * One character's view. Visible characters, visible items and attemptable options are three
 * separate sets, so a visible target with no option still appears.
 */
export interface InteractionCharacterView extends WorldJsonObject {
  readonly version: 'interaction-view/v1'
  readonly address: WorldAddress
  readonly characterId: CharacterId
  readonly asOfWorldSeq: number
  readonly manifestHash: WorldHash
  readonly viewPolicyHash: WorldHash
  readonly definitionSetHash: WorldHash
  readonly characters: readonly InteractionTargetRef[]
  readonly items: readonly InteractionTargetRef[]
  readonly options: readonly InteractionViewOption[]
  /** One entry per definition that appears in `options`, ordered by definition identity. */
  readonly performances: readonly InteractionPerformanceAcceptance[]
  /** Options the plan accepted before the per-character budget was applied. */
  readonly candidateCount: number
  readonly selectedAffordanceHash: WorldHash
}
