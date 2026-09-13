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

export interface InteractionRole extends WorldJsonObject {
  readonly name: string
  readonly kind: InteractionTargetRef['kind']
  readonly source: { readonly kind: 'hostActor' } | { readonly kind: 'primaryTarget' } | { readonly kind: 'argument'; readonly field: string }
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
  readonly limits: { readonly maximumEvents: number }
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

export interface InteractionEffectImplementation {
  readonly lock: InteractionImplementationLock
  readonly eventTypes: readonly InteractionRef[]
  readonly build: (context: InteractionExecutionContext) => readonly WorldEventDraft[]
  /** Domain validates the entire event group against the prefix and resolved roles. */
  readonly validate: (context: InteractionExecutionContext, events: readonly WorldEventDraft[]) => void
}

export interface InteractionDefinitionImplementation {
  readonly spec: InteractionDefinitionSpec
  readonly implementationHash: WorldHash
}

export interface InteractionPackageImplementation {
  readonly lock: InteractionImplementationLock
  readonly rules: readonly InteractionRuleImplementation[]
  readonly effects: readonly InteractionEffectImplementation[]
  readonly definitions: readonly InteractionDefinitionImplementation[]
}

export interface InteractionWorldSelection extends WorldJsonObject {
  readonly address: WorldAddress
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
}
