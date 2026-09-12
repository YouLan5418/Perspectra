import {
  ACTION_GROUP_CUES,
  type ActionGroupCue,
  type ActionGroupProposal,
  type StepManifestation,
  brandId,
  canonicalizeWorldJson,
  compareWorldText,
  failWorld,
  type ActionRequest,
  type CharacterId,
  type ManifestationChannel,
  type ManifestationCueProposal,
  type ManifestationProposal,
  type Proposal,
  type ReflectionOperation,
  type WorldJsonObject,
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

export interface ManifestationProposalEnvelope extends WorldJsonObject {
  readonly participantId: string
  readonly actions: readonly ActionRequest[]
  readonly manifestation?: ManifestationProposal
  readonly actionGroup?: import('@harness-world/contracts').ActionGroupBinding
}

export interface ValidatedSubmitActionsV3 {
  readonly decision: 'act' | 'abstain'
  readonly proposal: ManifestationProposalEnvelope
  readonly reflectionOperations?: readonly ReflectionOperation[]
}

const MANIFESTATION_CHANNELS = new Set<ManifestationChannel>([
  'facial', 'gaze', 'posture', 'gesture', 'voice', 'appearance',
])
const PERSISTENT_MANIFESTATION_CHANNELS = new Set<ManifestationChannel>(['posture', 'appearance'])
const utf8 = new TextEncoder()

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

function boundedText(value: unknown, path: string, maximumBytes: number): string {
  const parsed = text(value, path)
  if (utf8.encode(parsed).byteLength > maximumBytes) throw new TypeError(`${path} exceeds ${maximumBytes} UTF-8 bytes`)
  return parsed
}

/** Strict shared parser for manifestation proposals from either model or manual-player adapters. */
export function parseManifestationProposal(value: unknown): ManifestationProposal {
  const root = record(value, 'submit_actions.manifestation')
  exactWithOptional(root, ['cues'], ['description'], 'submit_actions.manifestation')
  if (!Array.isArray(root.cues) || root.cues.length === 0 || root.cues.length > 8) {
    throw new TypeError('submit_actions.manifestation.cues must contain between 1 and 8 entries')
  }
  const cues = root.cues.map((entry, index): ManifestationCueProposal => {
    const cue = record(entry, `manifestation.cues[${index}]`)
    const persistence = cue.persistence
    if (persistence === 'event_only') {
      exact(cue, ['cueId', 'channel', 'description', 'persistence'], `manifestation.cues[${index}]`)
    } else if (persistence === 'until_changed') {
      exact(cue, ['cueId', 'channel', 'description', 'persistence', 'stateKey', 'operation'], `manifestation.cues[${index}]`)
    } else {
      throw new TypeError(`manifestation.cues[${index}].persistence is unsupported`)
    }
    const cueId = boundedText(cue.cueId, `manifestation.cues[${index}].cueId`, 128)
    const channel = cue.channel
    if (typeof channel !== 'string' || !MANIFESTATION_CHANNELS.has(channel as ManifestationChannel)) {
      throw new TypeError(`manifestation.cues[${index}].channel is unsupported`)
    }
    const description = boundedText(cue.description, `manifestation.cues[${index}].description`, 512)
    if (persistence === 'event_only') return { cueId, channel: channel as ManifestationChannel, description, persistence }
    if (!PERSISTENT_MANIFESTATION_CHANNELS.has(channel as ManifestationChannel)) {
      throw new TypeError('until_changed manifestation is limited to posture and appearance')
    }
    const stateKey = boundedText(cue.stateKey, `manifestation.cues[${index}].stateKey`, 128)
    if (cue.operation !== 'set' && cue.operation !== 'clear') throw new TypeError(`manifestation.cues[${index}].operation is unsupported`)
    return {
      cueId, channel: channel as 'posture' | 'appearance', description,
      persistence, stateKey, operation: cue.operation,
    }
  })
  if (new Set(cues.map(cue => cue.cueId)).size !== cues.length) throw new TypeError('manifestation cueId values must be unique')
  return {
    ...(root.description === undefined ? {} : { description: boundedText(root.description, 'submit_actions.manifestation.description', 2048) }),
    cues,
  }
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
  validateV4(payload: unknown, authorization: SubmitActionsV2Authorization): { readonly proposal: ActionGroupProposal; readonly reflectionOperations?: readonly ReflectionOperation[] } {
    return this.#validateGroup(payload, authorization, 4)
  }

  validateV5(payload: unknown, authorization: SubmitActionsV2Authorization): { readonly proposal: ActionGroupProposal; readonly reflectionOperations?: readonly ReflectionOperation[] } {
    return this.#validateGroup(payload, authorization, 5)
  }

  #validateGroup(payload: unknown, authorization: SubmitActionsV2Authorization, version: 4 | 5): { readonly proposal: ActionGroupProposal; readonly reflectionOperations?: readonly ReflectionOperation[] } {
    try {
      canonicalizeWorldJson(payload as WorldJsonValue)
      const root = record(payload, 'submit_actions')
      exactWithOptional(root, ['schemaVersion', 'decision', 'actions'], ['reflection'], 'submit_actions')
      if (root.schemaVersion !== version) throw new TypeError(`submit_actions.schemaVersion must be ${version}`)
      if (root.decision !== 'act' && root.decision !== 'abstain') throw new TypeError('invalid decision')
      if (!Array.isArray(root.actions) || root.actions.length > 2) throw new TypeError('action group permits at most two steps')
      const manifestations: (StepManifestation | null)[] = []
      const rawActions = root.actions.map((entry, index) => {
        const action = record(entry, `actions[${index}]`)
        exactWithOptional(action, ['actionId', 'actorId', 'actionType', 'actionVersion', 'parameters'], ['manifestation'], 'action')
        let manifestation: StepManifestation | null = null
        if (action.manifestation !== undefined) {
          const value = record(action.manifestation, 'step manifestation')
          exact(value, ['independent', 'onSuccess'], 'step manifestation')
          const parse = (input: unknown, independent: boolean): ActionGroupCue[] => {
            if (!Array.isArray(input) || input.length > 8) throw new TypeError('invalid cue list')
            return input.map(cue => {
              if (typeof cue !== 'string' || !Object.hasOwn(ACTION_GROUP_CUES, cue)) throw new TypeError('unknown cue')
              const name = cue as ActionGroupCue
              const required = ACTION_GROUP_CUES[name].actionType
              if (required !== null && (independent || required !== action.actionType)) throw new TypeError('cue requires matching successful action')
              return name
            })
          }
          const independent = parse(value.independent, true)
          const onSuccess = parse(value.onSuccess, false)
          // The model-facing schema cannot forbid a repeat across the two lists: uniqueItems covers one list
          // only, and onSuccess's enum is a superset of independent's, so a repeat is schema-legal. The only
          // code that can repeat is a universal one, which independent already declares plays whatever the
          // outcome, so the repeat is that one cue restated rather than a second cue: drop it and play the cue
          // once instead of failing the whole group. An empty pair means no manifestation, which is how every
          // consumer already reads it. Repeats inside one list stay fatal, because the schema does forbid them.
          const alwaysOn = new Set(independent)
          const distinctOnSuccess = onSuccess.filter(cue => !alwaysOn.has(cue))
          if (independent.length === 0 && distinctOnSuccess.length === 0) {
            manifestation = null
          } else {
            const all = [...independent, ...distinctOnSuccess]
            if (all.length > 8 || new Set(all).size !== all.length) throw new TypeError('invalid or duplicate step cues')
            manifestation = { independent, onSuccess: distinctOnSuccess }
          }
        }
        manifestations.push(manifestation)
        const { manifestation: _manifestation, ...bare } = action
        return bare
      })
      const parsed = actions(rawActions, authorization)
      if ((root.decision === 'act') !== (parsed.length > 0)) throw new TypeError('inconsistent decision')
      if (parsed.some(action => !['speak', 'move', version === 5 ? 'interact' : 'take'].includes(action.actionType))) throw new TypeError('unsupported group action')
      if (parsed.length === 2 && parsed.filter(action => action.actionType === 'speak').length !== 1) throw new TypeError('group requires exactly one speech and one world operation')
      const reflection = this.validateV2({ schemaVersion: 2, decision: root.decision, actions: rawActions,
        ...(root.reflection === undefined ? {} : { reflection: root.reflection }) }, authorization)
      return { proposal: { participantId: authorization.participantId, actions: parsed,
        actionGroup: { version: 'bounded-action-group/v1', manifestations } },
        ...(reflection.reflectionOperations === undefined ? {} : { reflectionOperations: reflection.reflectionOperations }) }
    } catch (error: unknown) {
      invalid(error, authorization)
    }
  }

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

  validateV3(payload: unknown, authorization: SubmitActionsV2Authorization): ValidatedSubmitActionsV3 {
    try {
      canonicalizeWorldJson(payload as WorldJsonValue)
      const root = record(payload, 'submit_actions')
      exactWithOptional(root, ['schemaVersion', 'decision', 'actions'], ['reflection', 'manifestation'], 'submit_actions')
      if (root.schemaVersion !== 3) throw new TypeError('submit_actions.schemaVersion must be 3')
      if (root.decision !== 'act' && root.decision !== 'abstain') throw new TypeError('submit_actions.decision must be act or abstain')
      const parsedActions = actions(root.actions, authorization)
      if ((root.decision === 'act') !== (parsedActions.length > 0)) throw new TypeError('submit_actions decision and actions are inconsistent')
      const parsedManifestation = root.manifestation === undefined ? undefined : parseManifestationProposal(root.manifestation)
      if (parsedManifestation !== undefined && parsedActions.length !== 1) {
        throw new TypeError('submit_actions manifestation requires exactly one Action')
      }
      if (!Number.isSafeInteger(authorization.maxReflectionOperations) || authorization.maxReflectionOperations < 0) {
        throw new TypeError('maxReflectionOperations must be a non-negative safe integer')
      }
      let reflectionOperations: readonly ReflectionOperation[] | undefined
      if (root.reflection !== undefined) {
        const reflection = record(root.reflection, 'submit_actions.reflection')
        exact(reflection, ['operations'], 'submit_actions.reflection')
        if (!Array.isArray(reflection.operations)) throw new TypeError('submit_actions.reflection.operations must be an array')
        if (reflection.operations.length > authorization.maxReflectionOperations) throw new TypeError('submit_actions reflection exceeds maxReflectionOperations')
        reflectionOperations = reflection.operations as unknown as readonly ReflectionOperation[]
      }
      return {
        decision: root.decision,
        proposal: {
          participantId: authorization.participantId,
          actions: parsedActions,
          ...(parsedManifestation === undefined ? {} : { manifestation: parsedManifestation }),
        },
        ...(reflectionOperations === undefined ? {} : { reflectionOperations }),
      }
    } catch (error: unknown) {
      invalid(error, authorization)
    }
  }
}
