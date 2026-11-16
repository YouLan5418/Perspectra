import type { ActivityStageView } from './contracts/activity-stage.ts'
import type { JSONSchemaType } from 'ajv'
import type {
  ActionAffordance,
  ActivityOperation,
  ActivityState,
  CharacterId,
  StatusChange,
  StatusDefinition,
  StatusReveal,
  StatusTruth,
  WorldEventDraft,
  WorldJsonObject,
  WorldJsonValue,
} from '@perspectra/sdk/contracts'
import type { HostServices } from './host.ts'
import type { BusinessRejection } from './results.ts'
import type { WakeupSource } from './scheduler.ts'
import type { ActivityHooks } from './activities.ts'
import type { DiceRoll } from './dice.ts'
import type { StatusModuleHooks } from './status.ts'

/** The authorized state and candidates one actor may use to offer this operation. */
export interface OperationOfferInput<TState extends WorldJsonObject> {
  readonly actorId: CharacterId
  readonly state: Readonly<Partial<TState>>
  readonly candidates: readonly ActionAffordance[]
  readonly locationId?: string | null
}

export interface OperationOffer<TParams extends WorldJsonObject> {
  readonly id: string
  readonly label: string
  readonly targetId?: string
  /** Fixed offered fields; remaining fields are supplied at execution and validated against argumentSchema. */
  readonly parameters: Partial<TParams>
}

/** Host-bound identity, validated parameters and the applicable trusted state projection. */
export interface OperationResolveInput<TParams extends WorldJsonObject, TState extends WorldJsonObject> {
  readonly actorId: CharacterId
  readonly parameters: TParams
  readonly state: Readonly<TState>
  readonly activity?: Readonly<ActivityState>
  readonly locationId?: string | null
  /** Pure registered module methods; effects remain proposals for this same atomic operation. */
  readonly compute: GameplayComputation
  /** Same-prefix physical projection, and only the declaring module's state. */
  readonly world?: Readonly<WorldJsonObject>
  readonly truth?: Readonly<StatusTruth>
  readonly targetId?: string
  readonly rollDice?: (expression: string) => DiceRoll
}

export interface GameplayComputation {
  <TParams extends WorldJsonObject, TState extends WorldJsonObject, TOutcome extends WorldJsonValue>(
    method: OperationDefinition<TParams, TState, TOutcome>,
    parameters: TParams,
  ): OperationResolution<TOutcome>
}

export interface RestrictionDefinition<TState extends WorldJsonObject> {
  readonly id: string
  /** Keep a blocked destination visible so an attempted action can explain the refusal. */
  readonly showBlocked?: boolean
  /** Includes activity:start/suspend/resume/abandon. interact applies to all of them; forced escape bypasses author restrictions. */
  readonly operations: readonly string[]
  readonly check: (input: {
    readonly actorId: CharacterId
    readonly operationId: string
    readonly parameters: WorldJsonObject
    readonly state: Readonly<TState>
    readonly world?: Readonly<WorldJsonObject>
  }) => BusinessRejection | undefined
}

/** Author-visible result text receives only the projection authorized for one recipient. */
export interface OperationResultProjection<TOutcome extends WorldJsonValue> {
  readonly actorId: CharacterId
  readonly recipientId: CharacterId
  readonly outcome: TOutcome
}

export interface GameplayStatusEffect {
  readonly kind: 'status'
  readonly changes: readonly StatusChange[]
  readonly reveals: readonly StatusReveal[]
  readonly description?: string
}

export interface GameplayActivityEffect {
  readonly kind: 'activity'
  readonly activityKey: string
  readonly state: ActivityState
  readonly description: string
}

export interface GameplayWorldEventEffect {
  readonly kind: 'event'
  readonly event: WorldEventDraft
}

/**
 * A proposed core-recognized effect. The host supplies source identity and checks declaration,
 * authority, audience and final invariants before an effect reaches an atomic commit.
 */
export type GameplayEffect =
  | GameplayStatusEffect
  | GameplayActivityEffect
  | GameplayWorldEventEffect
  | { readonly kind: 'status-result'; readonly result: WorldJsonObject }
  | { readonly kind: 'activity-result'; readonly activityKey: string; readonly result: WorldJsonObject }

export interface GameplayAfterActionInput<TState extends WorldJsonObject, TOutcome extends WorldJsonValue> {
  readonly operationId: string
  readonly actorId: CharacterId
  readonly outcome: TOutcome
  /** State before the adjudicated operation. */
  readonly before: Readonly<TState>
  /** Candidate state after the main result, before any derived effect commits. */
  readonly candidate: Readonly<TState>
  readonly beforeActivities: Readonly<Record<string, Readonly<ActivityState>>>
  readonly candidateActivities: Readonly<Record<string, Readonly<ActivityState>>>
  readonly compute: GameplayComputation
  readonly beforeWorld?: Readonly<WorldJsonObject>
  readonly candidateWorld?: Readonly<WorldJsonObject>
}

export type OperationResolution<TOutcome extends WorldJsonValue> =
  | {
      readonly status: 'accepted'
      readonly outcome: TOutcome
      readonly effects: readonly GameplayEffect[]
    }
  | {
      readonly status: 'rejected'
      readonly rejection: BusinessRejection
    }

export interface OperationNpcDescription<TOutcome extends WorldJsonValue> {
  readonly whenToUse: string
  /** Optional trusted projection. Without one, only the actor receives the typed outcome. */
  readonly projectResult?: (result: OperationResultProjection<TOutcome>) => TOutcome | undefined
  readonly formatResult: (result: OperationResultProjection<TOutcome>) => string
}

export interface OperationUiDescription {
  readonly label: string
  readonly group?: string
  readonly targetKind?: string
  /** String inputs whose selectable values are currently visible scene characters. */
  readonly characterArguments?: readonly string[]
}

export interface OperationDefinition<
  TParams extends WorldJsonObject,
  TState extends WorldJsonObject,
  TOutcome extends WorldJsonValue,
> {
  readonly id: string
  readonly argumentSchema: JSONSchemaType<TParams>
  readonly resultSchema: JSONSchemaType<TOutcome>
  /** Optional binding to one declared activity operation and its current participant/turn checks. */
  readonly activity?: { readonly key: string; readonly operationId: string }
  /** Local status action whose declared actor/target policy the core must recheck. */
  readonly status?: { readonly operationId: string }
  readonly offer?: (input: OperationOfferInput<TState>) => readonly OperationOffer<TParams>[]
  readonly resolve: (input: OperationResolveInput<TParams, TState>) => OperationResolution<TOutcome>
  readonly npc?: OperationNpcDescription<TOutcome>
  readonly ui?: OperationUiDescription
}

export interface GameplayStateInitializationInput<TConfig extends WorldJsonObject> {
  readonly playerId: CharacterId
  readonly characterIds: readonly CharacterId[]
  readonly config: Readonly<TConfig>
}

export interface GameplayActivityInitializationInput {
  readonly playerId: CharacterId
  readonly participantIds: readonly CharacterId[]
  readonly random: () => number
  readonly activityId?: string
  readonly world?: Readonly<WorldJsonObject>
  readonly truth?: Readonly<StatusTruth>
  readonly previous?: WorldJsonObject | null
}

export interface GameplayActivityResultProjection<TOutcome extends WorldJsonValue> {
  readonly activityId: string
  readonly actorId: CharacterId
  readonly recipientId: CharacterId
  readonly outcome: TOutcome
}

export interface GameplayActivityOutcomeInput {
  readonly activityId: string
  readonly operationId: string
  readonly actorId: CharacterId
  readonly recipientId: CharacterId
  readonly outcome: WorldJsonValue
}

/** One authored activity. Runtime registration and execution remain B4 work. */
export interface GameplayActivityDefinition<TOutcome extends WorldJsonValue> {
  readonly key: string
  readonly title: string
  readonly opening?: string
  readonly operations: readonly ActivityOperation[]
  readonly initialize: (input: GameplayActivityInitializationInput) => ActivityState
  readonly resultSchema: JSONSchemaType<TOutcome>
  /** Converts an operation outcome into this recipient's typed activity result. Missing projections stay private. */
  readonly projectResult?: (input: GameplayActivityOutcomeInput) => TOutcome | undefined
  readonly formatResult: (result: GameplayActivityResultProjection<TOutcome>) => string
  /** Common computation hooks; operation resolution remains in the module's registered operations. */
  readonly behavior?: Omit<ActivityHooks, 'resolve'>
}

export interface GameplayPackEntity {
  readonly id: string
  readonly kind: string
}

export interface GameplayConfigValidationInput<TConfig extends WorldJsonObject> {
  readonly config: Readonly<TConfig>
  readonly entities: readonly GameplayPackEntity[]
}

export interface GameplayConfigIssue {
  readonly path: string
  readonly message: string
}

export interface GameplayCycleEndInput<TState extends WorldJsonObject> {
  readonly cycleId: string
  readonly state: Readonly<StatusTruth>
  readonly actors: Readonly<Record<string, Readonly<TState>>>
  readonly activities: Readonly<Record<string, Readonly<ActivityState>>>
}

export interface GameplayProperty {
  readonly key: string
  readonly label: string
  readonly value: WorldJsonValue
}

export interface GameplayPropertyTable {
  readonly kind: 'property-table'
  readonly id: string
  readonly title: string
  readonly properties: readonly GameplayProperty[]
}

export interface GameplayEntry {
  readonly id: string
  readonly title: string
  readonly content: string
}

export interface GameplayEntryList {
  readonly kind: 'entry-list'
  readonly id: string
  readonly title: string
  readonly entries: readonly GameplayEntry[]
}

export type GameplayPanel = GameplayPropertyTable | GameplayEntryList

/** A control changes one input of a currently offered operation owned by this module. */
export interface GameplayControlOperation {
  readonly id: string
  readonly argument: string
}
export interface GameplayBooleanControl {
  readonly operation: GameplayControlOperation
  readonly kind: 'boolean'
  readonly id: string
  readonly label: string
  readonly value: boolean
  readonly disabled?: boolean
  readonly description?: string
}

export interface GameplaySelectControlOption {
  readonly value: string
  readonly label: string
}

export interface GameplaySelectControl {
  readonly operation: GameplayControlOperation
  readonly kind: 'select'
  readonly id: string
  readonly label: string
  readonly value: string
  readonly options: readonly GameplaySelectControlOption[]
  readonly disabled?: boolean
  readonly description?: string
}

export type GameplayControl = GameplayBooleanControl | GameplaySelectControl

export interface GameplayPlayerView {
  readonly stage?: ActivityStageView
  readonly panels?: readonly GameplayPanel[]
  readonly controls?: readonly GameplayControl[]
}

/** The player view only receives state already authorized for the current player. */
export interface GameplayPlayerViewInput<TState extends WorldJsonObject> {
  /** Only this module’s active activities scoped to the participating player; never internal. */
  readonly activities?: readonly WorldJsonObject[]
  readonly playerId: CharacterId
  readonly state: Readonly<Partial<TState>>
}

type OperationTupleItem = {
  readonly id: string
}

type ValidatedOperationTuple<TState extends WorldJsonObject, TOperations extends readonly OperationTupleItem[]> = {
  readonly [TIndex in keyof TOperations]: TOperations[TIndex] extends OperationDefinition<
    infer TParams,
    infer _TOperationState,
    infer TOutcome
  >
    ? TOperations[TIndex] extends OperationDefinition<TParams, TState, TOutcome>
      ? TOperations[TIndex]
      : never
    : never
}

export interface GameplayDataCompatibility {
  /** 当前写入持久状态与活动存档的数据结构语义版本。文案或兼容逻辑修复不递增；状态含义、活动阶段或必要标识破坏性变更时递增。 */
  readonly dataVersion: number
  /** 当前插件可读档兼容的持久数据版本列表；省略时默认为 `[dataVersion]`。 */
  readonly supportedDataVersions?: readonly number[]
}

/** 校验并归一化插件声明的持久数据兼容版本集合。 */
export function resolveSupportedDataVersions(
  declaration: GameplayDataCompatibility,
  pluginId: string,
): readonly number[] {
  if (!Number.isInteger(declaration.dataVersion) || declaration.dataVersion < 1)
    throw new TypeError(`${pluginId} 的 dataVersion 必须是正整数`)
  if (declaration.supportedDataVersions === undefined) return [declaration.dataVersion]
  if (
    !Array.isArray(declaration.supportedDataVersions) ||
    declaration.supportedDataVersions.length === 0 ||
    declaration.supportedDataVersions.some(version => !Number.isInteger(version) || version < 1)
  )
    throw new TypeError(`${pluginId} 的 supportedDataVersions 必须是非空正整数列表`)
  const unique = [...new Set(declaration.supportedDataVersions)]
  if (!unique.includes(declaration.dataVersion))
    throw new TypeError(`${pluginId} 的 supportedDataVersions 必须包含当前 dataVersion（${declaration.dataVersion}）`)
  return unique
}

export interface GameplayDefinition<
  TState extends WorldJsonObject,
  TOperations extends readonly OperationTupleItem[],
  TConfig extends WorldJsonObject,
  TActivityOutcome extends WorldJsonValue,
  TMethods extends readonly OperationTupleItem[] = readonly [],
> extends GameplayDataCompatibility {
  readonly id: string
  readonly version: string
  readonly requiredServices: readonly (keyof HostServices)[]
  readonly states?: readonly StatusDefinition[]
  readonly activities?: readonly GameplayActivityDefinition<TActivityOutcome>[]
  readonly operations: TOperations & ValidatedOperationTuple<TState, TOperations>
  readonly methods?: TMethods & ValidatedOperationTuple<TState, TMethods>
  readonly restrictions?: readonly RestrictionDefinition<TState>[]
  /** Required by the runtime when states are declared; omitted for a pure rule module. */
  readonly initializeState?: (input: GameplayStateInitializationInput<TConfig>) => StatusTruth
  /** Receives only this module's truth, or only known values when preparing offers/player views. */
  readonly projectState?: (input: { readonly actorId: CharacterId; readonly state: Readonly<StatusTruth> }) => TState
  readonly validateState?: (
    state: Readonly<StatusTruth>,
    activities: Readonly<Record<string, Readonly<ActivityState>>>,
  ) => void
  /** Explicit owner-defined merge for competing proposals to one owned status address. */
  readonly combineChanges?: (input: {
    readonly state: Readonly<StatusTruth>
    readonly changes: readonly StatusChange[]
  }) => readonly StatusChange[]
  readonly configSchema: JSONSchemaType<TConfig>
  readonly validateConfig?: (input: GameplayConfigValidationInput<TConfig>) => readonly GameplayConfigIssue[]
  readonly playerView?: (input: GameplayPlayerViewInput<TState>) => GameplayPlayerView
  /** One module-level derivation hook may select any main operation through `operationId`. */
  readonly afterAction?: (input: GameplayAfterActionInput<TState, WorldJsonValue>) => readonly GameplayEffect[]
  readonly onCycleEnd?: (input: GameplayCycleEndInput<TState>) => readonly GameplayEffect[]
  /** Optional pure wakeup sources. Nominations only propose opportunities and owned stimulus sequences. */
  readonly wakeupSources?: readonly WakeupSource[]
  /** Explicit physical resources a trusted rule may affect beyond the acting character. */
  readonly physicalEffects?: { readonly characters: readonly string[]; readonly entities: readonly string[] }
  /** Existing status admission data, attached to registered operations rather than a separate executor. */
  readonly statusPolicy?: {
    readonly characterIds: readonly string[]
    readonly operations: readonly WorldJsonObject[]
    readonly policy: StatusModuleHooks['policy']
  }
}

/** Curried helper keeps shared state explicit while inferring each operation's params and outcome. */
export function defineOperation<TState extends WorldJsonObject>() {
  return <const TParams extends WorldJsonObject, const TOutcome extends WorldJsonValue>(
    definition: OperationDefinition<TParams, TState, TOutcome>,
  ): OperationDefinition<TParams, TState, TOutcome> => definition
}

/** Curried helper retains heterogeneous operations as a readonly tuple instead of widening them. */
export function defineGameplay<
  TState extends WorldJsonObject,
  TConfig extends WorldJsonObject,
  TActivityOutcome extends WorldJsonValue,
>() {
  return <
    const TOperations extends readonly OperationTupleItem[],
    const TMethods extends readonly OperationTupleItem[] = readonly [],
  >(
    definition: GameplayDefinition<TState, TOperations, TConfig, TActivityOutcome, TMethods>,
  ): GameplayDefinition<TState, TOperations, TConfig, TActivityOutcome, TMethods> => definition
}
