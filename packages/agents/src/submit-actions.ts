import {
  brandId,
  canonicalizeWorldJson,
  compareWorldText,
  failWorld,
  type ActionRequest,
  type CharacterId,
  type Proposal,
  type ReflectionOperation,
  type WorldJsonValue,
} from '@harness-world/contracts'

export interface SubmitActionsAuthorization {
  readonly participantId: string
  readonly actorId: CharacterId
  readonly allowedActionTypes: readonly string[]
  readonly maxActions: number
  readonly correlationId: string
}

export interface SubmitActionsV2Authorization extends SubmitActionsAuthorization {
  readonly maxReflectionOperations: number
}

export interface ValidatedSubmitActionsV2 {
  readonly decision: 'act' | 'abstain'
  readonly proposal: Proposal
  readonly reflectionOperations?: readonly ReflectionOperation[]
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError(`${path} must be an object`)
  return value as Record<string, unknown>
}

function exact(value: Record<string, unknown>, expected: readonly string[], path: string): void {
  const keys = Object.keys(value).sort(compareWorldText)
  const sorted = [...expected].sort(compareWorldText)
  if (keys.length !== sorted.length || keys.some((key, index) => key !== sorted[index])) {
    throw new TypeError(`${path} contains missing or unknown fields`)
  }
}

function exactWithOptional(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  path: string,
): void {
  const keys = Object.keys(value)
  const allowed = new Set([...required, ...optional])
  if (required.some(key => !(key in value)) || keys.some(key => !allowed.has(key))) {
    throw new TypeError(`${path} contains missing or unknown fields`)
  }
}

function text(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) throw new TypeError(`${path} must be a non-empty string`)
  return value
}

function actions(value: unknown, authorization: SubmitActionsAuthorization): ActionRequest[] {
  if (!Array.isArray(value)) throw new TypeError('submit_actions.actions must be an array')
  if (!Number.isSafeInteger(authorization.maxActions) || authorization.maxActions < 0) throw new TypeError('maxActions must be a non-negative safe integer')
  if (value.length > authorization.maxActions) throw new TypeError('submit_actions exceeds maxActions')
  const parsed = value.map((entry, index): ActionRequest => {
    const action = record(entry, `actions[${index}]`)
    exact(action, ['actionId', 'actorId', 'actionType', 'actionVersion', 'parameters'], `actions[${index}]`)
    const actionId = text(action.actionId, 'actionId')
    const actorId = brandId(text(action.actorId, 'actorId'), 'CharacterId')
    const actionType = text(action.actionType, 'actionType')
    if (actorId !== authorization.actorId) throw new TypeError('action actorId is not authorized')
    if (!authorization.allowedActionTypes.includes(actionType)) throw new TypeError('action type is not authorized')
    if (action.actionVersion !== 1) throw new TypeError('actionVersion must be 1')
    canonicalizeWorldJson(action.parameters as WorldJsonValue)
    return { actionId, actorId, actionType, actionVersion: 1, parameters: action.parameters as WorldJsonValue }
  })
  if (new Set(parsed.map(action => action.actionId)).size !== parsed.length) throw new TypeError('actionId values must be unique')
  return parsed
}

function invalid(error: unknown, authorization: SubmitActionsAuthorization): never {
  failWorld({
    errorCode: 'MODEL_SCHEMA_INVALID',
    category: 'provider',
    message: error instanceof Error ? error.message : 'unknown submit_actions validation failure',
    retryable: false,
    correlationId: authorization.correlationId,
  })
}

/** Strict parser for the only model output tool accepted by V0 Agents. */
export class SubmitActionsValidator {
  validate(payload: unknown, authorization: SubmitActionsAuthorization): Proposal {
    try {
      canonicalizeWorldJson(payload as WorldJsonValue)
      const root = record(payload, 'submit_actions')
      exact(root, ['schemaVersion', 'participantId', 'actions'], 'submit_actions')
      if (root.schemaVersion !== 1) throw new TypeError('submit_actions.schemaVersion must be 1')
      if (root.participantId !== authorization.participantId) throw new TypeError('submit_actions participantId is not authorized')
      return { participantId: authorization.participantId, actions: actions(root.actions, authorization) }
    } catch (error: unknown) {
      invalid(error, authorization)
    }
  }

  validateV2(payload: unknown, authorization: SubmitActionsV2Authorization): ValidatedSubmitActionsV2 {
    try {
      canonicalizeWorldJson(payload as WorldJsonValue)
      const root = record(payload, 'submit_actions')
      exactWithOptional(root, ['schemaVersion', 'decision', 'actions'], ['reflection'], 'submit_actions')
      if (root.schemaVersion !== 2) throw new TypeError('submit_actions.schemaVersion must be 2')
      if (root.decision !== 'act' && root.decision !== 'abstain') throw new TypeError('submit_actions.decision must be act or abstain')
      const parsedActions = actions(root.actions, authorization)
      if ((root.decision === 'act') !== (parsedActions.length > 0)) throw new TypeError('submit_actions decision and actions are inconsistent')
      if (!Number.isSafeInteger(authorization.maxReflectionOperations) || authorization.maxReflectionOperations < 0) {
        throw new TypeError('maxReflectionOperations must be a non-negative safe integer')
      }
      if (root.reflection === undefined) {
        return { decision: root.decision, proposal: { participantId: authorization.participantId, actions: parsedActions } }
      }
      const reflection = record(root.reflection, 'submit_actions.reflection')
      exact(reflection, ['operations'], 'submit_actions.reflection')
      if (!Array.isArray(reflection.operations)) throw new TypeError('submit_actions.reflection.operations must be an array')
      if (reflection.operations.length > authorization.maxReflectionOperations) throw new TypeError('submit_actions reflection exceeds maxReflectionOperations')
      return {
        decision: root.decision,
        proposal: { participantId: authorization.participantId, actions: parsedActions },
        reflectionOperations: reflection.operations as unknown as readonly ReflectionOperation[],
      }
    } catch (error: unknown) {
      invalid(error, authorization)
    }
  }
}
