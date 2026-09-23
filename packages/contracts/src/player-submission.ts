import { ACTION_GROUP_CUES,
  type ActionGroupCue, type StepManifestation } from './action-group.ts'
import { assertProtocolString, type CharacterId } from './ids.ts'
import type { ActionRequest, WorldAddress } from './protocol.ts'
import { canonicalizeWorldJson, deterministicId, hashWorldJson, type WorldHash, type WorldJsonObject, type WorldJsonValue } from './world-json.ts'

export interface PlayerSourceSpanV1 extends WorldJsonObject {
  readonly actionId: string
  readonly startUtf16: number
  readonly endUtf16: number
  readonly text: string
  readonly kind: 'speech' | 'narration' | 'action'
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
  /**
   * The cues this choice's definition accepts, as a set: a player may state one of them and nothing else.
   * Absent means the choice cannot carry a step at all, which is a different answer from "it accepts one
   * and the player did not state it" and must stay distinguishable. Placement (whether a cue plays only
   * on success) and any role it names are the definition's business and are adjudicated where the step is
   * decided, exactly as they are for a model's step; this list only says what is worth stating.
   */
  readonly performances?: readonly ActionGroupCue[]
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

/**
 * Deliberately no actor, final ActionId, arbitrary parameters, or narration fields. V2 added the step a
 * player states for the interaction they chose, drawn from the same closed vocabulary and schema the model
 * is handed, so how the player does it is declared rather than narrated into a fact.
 *
 * V3 removes the offsets. A candidate says which words of the player's own text name each action, and the
 * Host locates them: a model asked to count UTF-16 units gets that arithmetic wrong - measured, repeatedly
 * - and a wrong offset is indistinguishable from a sentence nobody said, while a verbatim quote is
 * something the Host can check and place itself.
 */
export function createPlayerIntentCandidateSchema() {
  return {
    type: 'object', additionalProperties: false, required: ['version', 'decision', 'reason', 'actions'],
    properties: {
      version: { const: 'player-intent-candidate/v3' },
      decision: { enum: ['act', 'clarification_required'] },
      reason: { enum: REASONS },
      actions: { type: 'array', maxItems: 2, items: {
        type: 'object', additionalProperties: false, required: ['key', 'affordanceId', 'quotes'],
        properties: { key: { type: 'string', minLength: 1 }, affordanceId: { type: 'string', minLength: 1 },
          quotes: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'string', minLength: 1 } } },
      } },
    },
  }
}

function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) throw new TypeError('player intent has invalid fields')
  return value as Record<string, unknown>
}

function exactWithOptional(value: unknown, required: readonly string[], optional: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('player intent has invalid fields')
  const keys = Object.keys(value)
  if (keys.some(key => !required.includes(key) && !optional.includes(key))
    || required.some(key => !keys.includes(key))) throw new TypeError('player intent has invalid fields')
  return value as Record<string, unknown>
}

/**
 * One list of step cues, from the closed vocabulary. A cue that names a voice or a gait is not one of
 * them: it names an action of its own, and an interaction is never its own step. A repeat inside one list
 * is refused rather than normalized, because the model-facing schema forbids it - a caller that sends one
 * ignored the schema it was handed.
 */
function cueList(value: unknown, maximum: number): readonly ActionGroupCue[] {
  if (!Array.isArray(value) || value.length > maximum) throw new TypeError('player intent cue list is invalid')
  const cues = value.map(cue => {
    if (typeof cue !== 'string' || !Object.hasOwn(ACTION_GROUP_CUES, cue)) throw new TypeError('unknown cue')
    if (ACTION_GROUP_CUES[cue as ActionGroupCue].actionType !== null) {
      throw new TypeError('an interaction step cannot state a voice or gait cue')
    }
    return cue as ActionGroupCue
  })
  if (new Set(cues).size !== cues.length) throw new TypeError('duplicate player intent cue')
  return cues
}

/** The cues one interaction choice accepts, as the Host declared them. */
function acceptedCues(choice: Record<string, unknown>): readonly ActionGroupCue[] {
  if (choice.performances === undefined) return []
  // Only a frozen interaction has a locked policy to accept anything: a catalog entry has no definition
  // behind it, so a list here would be a promise the world cannot keep.
  if (choice.actionType !== 'interact' || choice.actionVersion !== 2) {
    throw new TypeError('only a frozen interaction choice declares accepted cues')
  }
  return cueList(choice.performances, Object.keys(ACTION_GROUP_CUES).length)
}

/** The words one action names, as the Host will look them up in the player's own text. */
function quoteList(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 8) {
    throw new TypeError('player intent action requires the words it names')
  }
  const quotes = value.map(raw => {
    if (typeof raw !== 'string' || raw.length === 0) throw new TypeError('player intent quote is invalid')
    return raw
  })
  // One quote twice states nothing the first did not, and the second could only match words already spent.
  if (new Set(quotes).size !== quotes.length) throw new TypeError('player intent quote is repeated')
  return quotes
}

function step(value: unknown): StepManifestation {
  const root = object(value, ['independent', 'onSuccess'])
  return { independent: cueList(root.independent, 8), onSuccess: cueList(root.onSuccess, 8) }
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
  const choices = new Map<string, { readonly choice: PlayerIntentAffordance; readonly accepted: readonly ActionGroupCue[] }>()
  for (const choice of binding.affordances) {
    const raw = exactWithOptional(choice, ['affordanceId', 'actionType', 'actionVersion', 'parameters'], ['performances'])
    text(choice.affordanceId)
    if (choices.has(choice.affordanceId)
      || !['speak', 'move', 'interact'].includes(choice.actionType)) throw new TypeError('player intent affordance is invalid')
    const version = choice.actionVersion
    // The version belongs to the action type: only a frozen interaction addresses anything above 1, and
    // it addresses exactly 2 - it names a binding and a definition lock, which is the frozen request.
    if (choice.actionType === 'interact' ? version !== 1 && version !== 2 : version !== 1) {
      throw new TypeError('player intent affordance version is unsupported')
    }
    if (choice.actionType === 'speak') {
      if (Object.hasOwn(choice.parameters, 'narration')) {
        const publication = object(choice.parameters, ['text', 'narration'])
        if (publication.text !== '' || publication.narration !== '') throw new TypeError('narration choice must be an empty publication template')
      } else object(choice.parameters, [])
    }
    if (choice.actionType === 'move') text(object(choice.parameters, ['locationId']).locationId)
    if (choice.actionType === 'interact') interactParameters(version, choice.parameters)
    choices.set(choice.affordanceId, { choice, accepted: acceptedCues(raw) })
  }
  const candidate = object(value, ['version', 'decision', 'reason', 'actions'])
  // V3 is the only readable version: the Host publishes exactly this schema in the request it dispatches, so
  // an older candidate is a caller that ignored the contract it was handed rather than a peer to tolerate.
  if (candidate.version !== 'player-intent-candidate/v3' || !REASONS.includes(candidate.reason as never)
    || !Array.isArray(candidate.actions)) throw new TypeError('player intent candidate is invalid')
  if (candidate.decision === 'clarification_required') {
    if (candidate.reason === 'none' || candidate.actions.length !== 0) {
      throw new TypeError('clarification cannot contain actions')
    }
    return { status: 'clarification_required', reason: candidate.reason as 'ambiguous' | 'not_afforded' | 'unsupported' }
  }
  if (candidate.decision !== 'act' || candidate.reason !== 'none' || candidate.actions.length < 1 || candidate.actions.length > 2) {
    throw new TypeError('player intent action group is invalid')
  }
  const keys: string[] = []
  let requiresClarification = false
  const chosen: { readonly key: string; readonly choice: PlayerIntentAffordance
    readonly performance: StepManifestation | undefined; readonly quotes: readonly string[] }[] = []
  for (const raw of candidate.actions) {
    const action = exactWithOptional(raw, ['key', 'affordanceId', 'quotes'], ['performance'])
    const key = text(action.key)
    const found = choices.get(text(action.affordanceId))
    if (keys.includes(key) || found === undefined) throw new TypeError('player intent action is not uniquely afforded')
    const performance = action.performance === undefined ? undefined : step(action.performance)
    // What the player actually wrote, named by the action it belongs to: finding these in the source is what
    // makes a candidate checkable rather than merely well-formed.
    const quotes = quoteList(action.quotes)
    // A step the choice does not accept is not quietly dropped - dropping it would do something the player
    // did not say - and it does not fail the action either: the player is asked again, which is the answer
    // this boundary already gives for an action that is not currently afforded. This covers a step stated
    // for an action that cannot carry one at all, because such a choice declares no accepted cues.
    if (performance !== undefined
      && ![...performance.independent, ...performance.onSuccess].every(cue => found.accepted.includes(cue))) {
      requiresClarification = true
    }
    keys.push(key)
    chosen.push({ key, choice: found.choice, performance, quotes })
  }
  const actions: ActionRequest[] = chosen.map((entry, ordinal) => ({
    actionId: deterministicId('action', { version: 'player-intent-action/v1', address: binding.address, inputId: binding.inputId, ordinal }),
    actorId: binding.actorId, actionType: entry.choice.actionType, actionVersion: entry.choice.actionVersion,
    // The step joins the request the same way the model's does: it is adjudicated by the definition the
    // choice names, against the policy that definition locked, and it never becomes part of the effect.
    parameters: entry.performance === undefined
      ? entry.choice.parameters : { ...entry.choice.parameters, performance: entry.performance },
  }))
  if (actions.filter(action => action.actionType !== 'speak').length > 1) {
    throw new TypeError('player input permits at most one world operation')
  }
  // The Host places each quote rather than being told where it is. Searching on from the previous one is
  // what keeps the actions in the order the player spoke them, and a quote nobody wrote is refused here
  // instead of becoming a span pointing at words that were never said.
  let previousEnd = 0
  const sourceSpans: PlayerSourceSpanV1[] = []
  for (const [ordinal, entry] of chosen.entries()) {
    const action = actions[ordinal]!
    for (const quote of entry.quotes) {
      const start = binding.sourceText.indexOf(quote, previousEnd)
      if (start < 0) {
        if (binding.sourceText.includes(quote)) throw new TypeError('player intent quote is out of source order')
        throw new TypeError('player intent quote is not in the player text')
      }
      previousEnd = start + quote.length
      sourceSpans.push({ actionId: action.actionId, startUtf16: start, endUtf16: previousEnd, text: quote,
        kind: action.actionType === 'speak' ? (Object.hasOwn(entry.choice.parameters, 'narration') ? 'narration' : 'speech') : 'action' })
    }
  }
  for (const action of actions) {
    if (action.actionType !== 'speak') continue
    const spans = sourceSpans.filter(span => span.actionId === action.actionId)
    // A speech is one contiguous quote: joining two of them would invent a sentence nobody said.
    if (spans.length !== 1) throw new TypeError('player speech requires one contiguous quote')
    actions[actions.indexOf(action)] = { ...action, parameters: spans[0]!.kind === 'narration'
      ? { text: '', narration: spans[0]!.text } : { text: spans[0]!.text } }
  }
  // A semantic clarification must not turn an otherwise malformed Provider response into a valid result.
  // Validate every action and source span first, then give the player-facing answer for an unoffered step.
  if (requiresClarification) return { status: 'clarification_required', reason: 'not_afforded' }
  const submission: PlayerSubmissionV2 = {
    version: 'player-submission/v2', sourceText: binding.sourceText,
    sourceTextHash: hashWorldJson('player-source-text/v1', binding.sourceText), actions, sourceSpans,
    interpretationProfile: binding.interpretationProfile, interpretationReceiptHash: binding.interpretationReceiptHash,
  }
  // Detach all selected parameters from mutable Host/Adapter references.
  return { status: 'validated', submission: JSON.parse(new TextDecoder().decode(canonicalizeWorldJson(submission))) as PlayerSubmissionV2 }
}
