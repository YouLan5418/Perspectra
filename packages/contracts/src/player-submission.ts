import { assertProtocolString, type CharacterId } from './ids.ts'
import type { ActionRequest, WorldAddress } from './protocol.ts'
import { canonicalizeWorldJson, deterministicId, hashWorldJson, type WorldHash, type WorldJsonObject, type WorldJsonValue } from './world-json.ts'

export interface PlayerSourceSpanV1 extends WorldJsonObject {
  readonly actionId: string
  readonly startUtf16: number
  readonly endUtf16: number
  readonly text: string
  readonly kind: 'speech' | 'action'
}

export interface PlayerSubmissionV2 extends WorldJsonObject {
  readonly version: 'player-submission/v2'
  readonly sourceText: string
  readonly sourceTextHash: WorldHash
  readonly actions: readonly ActionRequest[]
  readonly sourceSpans: readonly PlayerSourceSpanV1[]
  readonly interpretationProfile: string
  readonly interpretationReceiptHash: WorldHash
}

/** Host freezes exact choices; speak alone derives its text from source spans. */
export interface PlayerIntentAffordance extends WorldJsonObject {
  readonly affordanceId: string
  readonly actionType: 'speak' | 'move' | 'interact'
  /**
   * The version of the operation this choice addresses. An interaction a world does not adjudicate
   * through a definition is 1, and a frozen one is 2 because its request names a binding and a
   * definition lock rather than a catalog entry. Speech and movement are always 1.
   */
  readonly actionVersion: 1 | 2
  readonly parameters: WorldJsonObject
}

export interface PlayerIntentBinding {
  readonly address: WorldAddress
  readonly inputId: string
  readonly actorId: CharacterId
  readonly sourceText: string
  readonly interpretationProfile: string
  readonly interpretationReceiptHash: WorldHash
  readonly affordances: readonly PlayerIntentAffordance[]
}

const REASONS = ['none', 'ambiguous', 'not_afforded', 'unsupported'] as const

/** Deliberately no actor, final ActionId, arbitrary parameters, or narration fields. */
export function createPlayerIntentCandidateSchema() {
  return {
    type: 'object', additionalProperties: false, required: ['version', 'decision', 'reason', 'actions', 'sourceSpans'],
    properties: {
      version: { const: 'player-intent-candidate/v1' },
      decision: { enum: ['act', 'clarification_required'] },
      reason: { enum: REASONS },
      actions: { type: 'array', maxItems: 2, items: {
        type: 'object', additionalProperties: false, required: ['key', 'affordanceId'],
        properties: { key: { type: 'string', minLength: 1 }, affordanceId: { type: 'string', minLength: 1 } },
      } },
      sourceSpans: { type: 'array', items: {
        type: 'object', additionalProperties: false, required: ['actionKey', 'startUtf16', 'endUtf16', 'text', 'kind'],
        properties: {
          actionKey: { type: 'string', minLength: 1 }, startUtf16: { type: 'integer', minimum: 0 },
          endUtf16: { type: 'integer', minimum: 1 }, text: { type: 'string', minLength: 1 }, kind: { enum: ['speech', 'action'] },
        },
      } },
    },
  }
}

function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) throw new TypeError('player intent has invalid fields')
  return value as Record<string, unknown>
}

function text(value: unknown): string {
  if (typeof value !== 'string') throw new TypeError('player intent requires a string')
  return assertProtocolString(value, 'player intent identifier')
}

/**
 * The exact parameters of one interaction choice, by the version it addresses. A v1 choice names a
 * catalog entry; a frozen one names the binding and the definition lock it addresses, and both are
 * checked here so a model cannot reach a shape the world's own boundary would refuse later.
 */
function interactParameters(version: 1 | 2, value: unknown): void {
  if (version === 1) {
    const parameters = object(value, ['targetId', 'interactionId', 'arguments'])
    text(parameters.targetId)
    text(parameters.interactionId)
    // Exact dynamic choices (including give recipient) are supplied by the Host.
    arguments_(parameters.arguments)
    return
  }
  const parameters = object(value, ['targetRef', 'bindingId', 'definitionRef', 'arguments'])
  const targetRef = object(parameters.targetRef, ['kind', 'id'])
  if (!['entity', 'character', 'relation'].includes(targetRef.kind as string)) {
    throw new TypeError('player intent interaction target kind is unsupported')
  }
  text(targetRef.id)
  text(parameters.bindingId)
  const definitionRef = object(parameters.definitionRef, ['id', 'version'])
  text(definitionRef.id)
  if (!Number.isSafeInteger(definitionRef.version) || (definitionRef.version as number) < 1) {
    throw new TypeError('player intent interaction definition version must be a positive safe integer')
  }
  arguments_(parameters.arguments)
}

function arguments_(value: unknown): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('player intent interaction arguments must be an object')
  }
}

/** A pure Host binding boundary, not admission or a substitute for Rulebook revalidation. */
export function bindPlayerIntentCandidate(value: unknown, binding: PlayerIntentBinding):
  | { readonly status: 'clarification_required'; readonly reason: 'ambiguous' | 'not_afforded' | 'unsupported' }
  | { readonly status: 'validated'; readonly submission: PlayerSubmissionV2 } {
  canonicalizeWorldJson(value as WorldJsonValue)
  canonicalizeWorldJson(binding as unknown as WorldJsonValue)
  text(binding.inputId)
  text(binding.actorId)
  text(binding.interpretationProfile)
  const address = object(binding.address, ['tenantId', 'worldId', 'branchId'])
  for (const id of Object.values(address)) text(id)
  if (typeof binding.sourceText !== 'string' || binding.sourceText.length === 0
    || !/^sha256:[0-9a-f]{64}$/u.test(binding.interpretationReceiptHash)) throw new TypeError('player intent source or receipt is invalid')
  const choices = new Map<string, PlayerIntentAffordance>()
  for (const choice of binding.affordances) {
    object(choice, ['affordanceId', 'actionType', 'actionVersion', 'parameters'])
    text(choice.affordanceId)
    if (choices.has(choice.affordanceId)
      || !['speak', 'move', 'interact'].includes(choice.actionType)) throw new TypeError('player intent affordance is invalid')
    const version = choice.actionVersion
    // The version belongs to the action type: only a frozen interaction addresses anything above 1, and
    // it addresses exactly 2 - it names a binding and a definition lock, which is the frozen request.
    if (choice.actionType === 'interact' ? version !== 1 && version !== 2 : version !== 1) {
      throw new TypeError('player intent affordance version is unsupported')
    }
    if (choice.actionType === 'speak') object(choice.parameters, [])
    if (choice.actionType === 'move') text(object(choice.parameters, ['locationId']).locationId)
    if (choice.actionType === 'interact') interactParameters(version, choice.parameters)
    choices.set(choice.affordanceId, choice)
  }
  const candidate = object(value, ['version', 'decision', 'reason', 'actions', 'sourceSpans'])
  if (candidate.version !== 'player-intent-candidate/v1' || !REASONS.includes(candidate.reason as never)
    || !Array.isArray(candidate.actions) || !Array.isArray(candidate.sourceSpans)) throw new TypeError('player intent candidate is invalid')
  if (candidate.decision === 'clarification_required') {
    if (candidate.reason === 'none' || candidate.actions.length !== 0 || candidate.sourceSpans.length !== 0) {
      throw new TypeError('clarification cannot contain actions or spans')
    }
    return { status: 'clarification_required', reason: candidate.reason as 'ambiguous' | 'not_afforded' | 'unsupported' }
  }
  if (candidate.decision !== 'act' || candidate.reason !== 'none' || candidate.actions.length < 1 || candidate.actions.length > 2) {
    throw new TypeError('player intent action group is invalid')
  }
  const keys: string[] = []
  const actions: ActionRequest[] = candidate.actions.map((raw, ordinal) => {
    const action = object(raw, ['key', 'affordanceId'])
    const key = text(action.key)
    const choice = choices.get(text(action.affordanceId))
    if (keys.includes(key) || choice === undefined) throw new TypeError('player intent action is not uniquely afforded')
    keys.push(key)
    return {
      actionId: deterministicId('action', { version: 'player-intent-action/v1', address: binding.address, inputId: binding.inputId, ordinal }),
      actorId: binding.actorId, actionType: choice.actionType, actionVersion: choice.actionVersion, parameters: choice.parameters,
    }
  })
  if (actions.length === 2 && actions.filter(action => action.actionType === 'speak').length !== 1) {
    throw new TypeError('two player actions require exactly one speak')
  }
  let previousEnd = 0
  let previousOrdinal = -1
  const sourceSpans: PlayerSourceSpanV1[] = candidate.sourceSpans.map(raw => {
    const span = object(raw, ['actionKey', 'startUtf16', 'endUtf16', 'text', 'kind'])
    const ordinal = keys.indexOf(text(span.actionKey))
    const start = span.startUtf16 as number
    const end = span.endUtf16 as number
    if (ordinal < 0 || ordinal < previousOrdinal || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)
      || start < previousEnd || end <= start || end > binding.sourceText.length
      || typeof span.text !== 'string' || binding.sourceText.slice(start, end) !== span.text) throw new TypeError('player intent source span is invalid')
    const action = actions[ordinal]!
    if (span.kind !== (action.actionType === 'speak' ? 'speech' : 'action')) throw new TypeError('player intent source span kind is invalid')
    previousEnd = end
    previousOrdinal = ordinal
    return { actionId: action.actionId, startUtf16: start, endUtf16: end, text: span.text, kind: span.kind as 'speech' | 'action' }
  })
  for (const action of actions) {
    const spans = sourceSpans.filter(span => span.actionId === action.actionId)
    if (spans.length === 0) throw new TypeError('every player action requires a source span')
    if (action.actionType === 'speak') {
      // Joining disconnected quotes could invent a sentence not present in the source.
      if (spans.length !== 1) throw new TypeError('player speech requires one contiguous source span')
      actions[actions.indexOf(action)] = { ...action, parameters: { text: spans[0]!.text } }
    }
  }
  const submission: PlayerSubmissionV2 = {
    version: 'player-submission/v2', sourceText: binding.sourceText,
    sourceTextHash: hashWorldJson('player-source-text/v1', binding.sourceText), actions, sourceSpans,
    interpretationProfile: binding.interpretationProfile, interpretationReceiptHash: binding.interpretationReceiptHash,
  }
  // Detach all selected parameters from mutable Host/Adapter references.
  return { status: 'validated', submission: JSON.parse(new TextDecoder().decode(canonicalizeWorldJson(submission))) as PlayerSubmissionV2 }
}
