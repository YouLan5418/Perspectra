import Ajv, { type ValidateFunction } from 'ajv'
import type { WorldJsonObject, WorldJsonValue } from '@harness-world/contracts'
import type { OperationDefinition } from '@harness-world/plugin-sdk'

export interface CompiledOperationContract<TParams extends WorldJsonObject, TOutcome extends WorldJsonValue> {
  readonly parseParameters: (value: unknown) => TParams
  readonly parseOfferParameters: (value: unknown) => Partial<TParams>
  readonly parseOutcome: (value: unknown) => TOutcome
}

export type GameplayContractErrorCode = 'GAMEPLAY_ARGUMENTS_INVALID' | 'GAMEPLAY_OUTCOME_INVALID'

export class GameplayContractError extends TypeError {
  constructor(
    readonly code: GameplayContractErrorCode,
    readonly operationId: string,
    readonly detail: string,
  ) {
    super(code + ': operation ' + operationId + ' failed schema validation: ' + detail)
    this.name = 'GameplayContractError'
  }
}

function checked<T>(
  ajv: Ajv,
  validate: ValidateFunction<T>,
  value: unknown,
  code: GameplayContractErrorCode,
  operationId: string,
): T {
  if (!validate(value)) {
    throw new GameplayContractError(code, operationId, ajv.errorsText(validate.errors, { separator: '; ' }))
  }
  return structuredClone(value) as T
}

/**
 * Compile the author-facing parameter and result schemas for one operation. These parsers validate and
 * copy external data; they neither authorize an actor nor commit effects.
 */
export function compileOperationContract<
  TParams extends WorldJsonObject,
  TState extends WorldJsonObject,
  TOutcome extends WorldJsonValue,
>(definition: OperationDefinition<TParams, TState, TOutcome>): CompiledOperationContract<TParams, TOutcome> {
  const ajv = new Ajv({ strict: true, allErrors: false, coerceTypes: false, removeAdditional: false })
  const parameters = ajv.compile<TParams>(definition.argumentSchema)
  // Offers validate only supplied fields. Cross-field/completeness constraints belong to execution.
  // Use a separate registry so a perfectly valid $id can be compiled in both contexts.
  const offerAjv = new Ajv({ strict: true, allErrors: false, coerceTypes: false, removeAdditional: false })
  const source = definition.argumentSchema as Record<string, unknown>
  const fieldSchema = Object.fromEntries(
    ['type', '$id', '$schema', '$defs', 'definitions', 'properties', 'patternProperties', 'additionalProperties']
      .filter(key => Object.hasOwn(source, key))
      .map(key => [key, source[key]]),
  )
  const offered = offerAjv.compile<Partial<TParams>>(fieldSchema)
  const outcome = ajv.compile<TOutcome>(definition.resultSchema)
  return {
    parseParameters: value => checked(ajv, parameters, value, 'GAMEPLAY_ARGUMENTS_INVALID', definition.id),
    parseOfferParameters: value => checked(offerAjv, offered, value, 'GAMEPLAY_ARGUMENTS_INVALID', definition.id),
    parseOutcome: value => checked(ajv, outcome, value, 'GAMEPLAY_OUTCOME_INVALID', definition.id),
  }
}
