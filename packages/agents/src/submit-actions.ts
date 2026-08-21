import {
  brandId,
  canonicalizeWorldJson,
  failWorld,
  type ActionRequest,
  type CharacterId,
  type Proposal,
  type WorldJsonValue,
} from '@harness-world/contracts'

export interface SubmitActionsAuthorization {
  readonly participantId: string
  readonly actorId: CharacterId
  readonly allowedActionTypes: readonly string[]
  readonly maxActions: number
  readonly correlationId: string
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError(`${path} must be an object`)
  return value as Record<string, unknown>
}

function exact(value: Record<string, unknown>, expected: readonly string[], path: string): void {
  const keys = Object.keys(value).sort()
  const sorted = [...expected].sort()
  if (keys.length !== sorted.length || keys.some((key, index) => key !== sorted[index])) {
    throw new TypeError(`${path} contains missing or unknown fields`)
  }
}

function text(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) throw new TypeError(`${path} must be a non-empty string`)
  return value
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
      if (!Array.isArray(root.actions)) throw new TypeError('submit_actions.actions must be an array')
      if (!Number.isSafeInteger(authorization.maxActions) || authorization.maxActions < 0) throw new TypeError('maxActions must be a non-negative safe integer')
      if (root.actions.length > authorization.maxActions) throw new TypeError('submit_actions exceeds maxActions')
      const actions = root.actions.map((entry, index): ActionRequest => {
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
      if (new Set(actions.map(action => action.actionId)).size !== actions.length) throw new TypeError('actionId values must be unique')
      return { participantId: authorization.participantId, actions }
    } catch (error: unknown) {
      failWorld({
        errorCode: 'MODEL_SCHEMA_INVALID',
        category: 'provider',
        message: error instanceof Error ? error.message : 'unknown submit_actions validation failure',
        retryable: false,
        correlationId: authorization.correlationId,
      })
    }
  }
}
