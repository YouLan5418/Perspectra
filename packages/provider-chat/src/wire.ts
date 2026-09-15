import type { WorldJsonObject, WorldJsonValue } from '@harness-world/contracts'
import { objectValue as object, textValue as text } from './value.ts'

/**
 * One message as the Host assembled it, or as an endpoint accepts it. Roles stay strings: which roles an
 * endpoint knows is the endpoint's business, and the only mapping this adapter makes is the one below.
 */
export interface ChatMessage {
  readonly role: string
  readonly content: string
}

/**
 * What a character call carries: the assembled messages and the Host's own description of the contract.
 * It is not itself World JSON - the messages are a list of role/content pairs, not a JSON segment - so the
 * caller hands it over as the context it received and this adapter reads only those two fields.
 */
export interface ExactProviderRequest {
  readonly messages: readonly ChatMessage[]
  readonly tools: WorldJsonObject
}

/** One prepared call: the messages to send, the JSON Schema the answer is bound to, and what to ask for. */
export interface ChatCall {
  readonly messages: readonly ChatMessage[]
  readonly schema: WorldJsonObject
  readonly description: string
}

/**
 * The Host's context uses a `developer` segment for the character-controller contract; the endpoints this
 * adapter talks to know system, user, assistant and tool. That mapping is the adapter's business and not
 * the world's: nothing about what the model is told changes, only which role carries it. Every other
 * message passes through as it was assembled.
 */
export function chatMessages(messages: readonly ChatMessage[]): readonly ChatMessage[] {
  return messages.map(message => message.role === 'developer'
    ? { role: 'system', content: message.content } : message)
}

/** The parsed content of every message that is a Context segment, in the order they were assembled. */
function segments(messages: readonly ChatMessage[]): readonly WorldJsonObject[] {
  const parsed: WorldJsonObject[] = []
  for (const message of messages) {
    let value: unknown
    try {
      value = JSON.parse(message.content)
    } catch {
      // A message that is not a JSON segment is prose, and prose is not an offer to read structure from.
      continue
    }
    const segment = object(value)
    if (segment !== undefined) parsed.push(segment)
  }
  return parsed
}

function segmentContent(parsed: readonly WorldJsonObject[], kind: string): unknown {
  const found = parsed.find(segment => segment.segmentKind === kind)
  return found?.content
}

interface OfferedInteraction {
  readonly interactions?: readonly WorldJsonObject[]
  readonly performances?: readonly WorldJsonObject[]
}

/** The interaction options the context itself offers, which is where a step's exact choices come from. */
function offeredInteraction(parsed: readonly WorldJsonObject[]): OfferedInteraction {
  const content = segmentContent(parsed, 'affordances')
  const entry = Array.isArray(content) ? content.map(object).find(value => value?.actionType === 'interact') : undefined
  return entry ?? {}
}

/**
 * The parameters each protocol action takes. This is `submit_actions/v7`'s own vocabulary rather than a
 * world's: the Host states which action types a group allows and, for an interaction, the exact request
 * keys through the options it offers; what speech and movement carry is fixed by the protocol.
 */
const STEP_PARAMETERS: Readonly<Record<string, WorldJsonObject>> = {
  speak: { type: 'object', additionalProperties: false, required: ['text'],
    properties: { text: { type: 'string', minLength: 1, maxLength: 500 } } },
  move: { type: 'object', additionalProperties: false, required: ['locationId'],
    properties: { locationId: { type: 'string', minLength: 1 } } },
  take: { type: 'object', additionalProperties: false, required: ['entityId'],
    properties: { entityId: { type: 'string', minLength: 1 } } },
}

/** A `const` for a value the Host stated, and nothing where it stated none. */
function constOf(value: WorldJsonValue | undefined): WorldJsonObject {
  return value === undefined ? {} : { const: value }
}

/** One offered interaction option, as an exact choice: every const here is the Host's own answer. */
function optionSchema(choice: WorldJsonObject): WorldJsonObject {
  const targetRef = object(choice.targetRef) ?? {}
  const definitionRef = object(choice.definitionRef) ?? {}
  const argumentsValue = object(choice.arguments) ?? {}
  const argumentKeys = Object.keys(argumentsValue)
  return {
    type: 'object', additionalProperties: false,
    required: ['targetRef', 'bindingId', 'definitionRef', 'arguments'],
    properties: {
      targetRef: { type: 'object', additionalProperties: false, required: ['kind', 'id'],
        properties: { kind: { type: 'string', ...constOf(targetRef.kind) },
          id: { type: 'string', ...constOf(targetRef.id) } } },
      bindingId: { type: 'string', ...constOf(choice.bindingId) },
      definitionRef: { type: 'object', additionalProperties: false, required: ['id', 'version'],
        properties: { id: { type: 'string', ...constOf(definitionRef.id) },
          version: { type: 'integer', ...constOf(definitionRef.version) } } },
      arguments: { type: 'object', additionalProperties: false,
        ...(argumentKeys.length === 0 ? {} : {
          required: argumentKeys,
          properties: Object.fromEntries(argumentKeys.map(key =>
            [key, { type: typeof argumentsValue[key], ...constOf(argumentsValue[key]) }])),
        }) },
    },
  }
}

/** A cue list, as the schema that keeps a model inside the vocabulary the world will judge it against. */
function cueList(cues: readonly string[]): WorldJsonObject {
  return { type: 'array', maxItems: 8, uniqueItems: true, items: { type: 'string', enum: cues } }
}

function manifestationSchema(cues: readonly string[]): WorldJsonObject {
  return { type: 'object', additionalProperties: false, required: ['independent', 'onSuccess'],
    properties: { independent: cueList(cues), onSuccess: cueList(cues) } }
}

/**
 * The cues the definitions behind the offered options accept, as the union a model may state. A
 * definition's answer is per definition, so this union is the only list a model can use without proposing
 * something the world would refuse; with no offered definition accepting anything, a step states nothing.
 */
function acceptedInteractCues(offer: OfferedInteraction): readonly string[] {
  const accepted = new Set<string>()
  for (const entry of offer.performances ?? []) {
    for (const binding of Array.isArray(entry.accepted) ? entry.accepted : []) {
      const cue = text(object(binding)?.cue)
      if (cue !== undefined) accepted.add(cue)
    }
  }
  return [...accepted].sort()
}

/** The actor this call belongs to, from the character anchor the Host assembled for it. */
function anchoredActor(parsed: readonly WorldJsonObject[]): string | undefined {
  return text(object(segmentContent(parsed, 'character_anchor'))?.characterId)
}

/**
 * The wire schema a real endpoint needs. The Host's `tools` payload describes the contract - the group's
 * policy, the closed cue vocabulary per action, and where the options live - rather than being a JSON
 * Schema a model can bind to, so an adapter has to render one. Nothing here is invented: the action types
 * come from the group's declaration, the interaction options from the affordances the context offers, the
 * cues from the definitions behind them, and the actor from its own character anchor.
 */
export function actionGroupWireSchema(exact: ExactProviderRequest): WorldJsonObject {
  const tools = exact.tools
  const parsed = segments(exact.messages)
  const group = object(tools.actionGroup) ?? {}
  const allowed = (Array.isArray(group.allowedActionTypes) ? group.allowedActionTypes : []).map(text)
    .filter((value): value is string => value !== undefined)
  const declaredCues = object(object(group.manifestation)?.schemasByAction) ?? {}
  const offer = offeredInteraction(parsed)
  const steps = (offer.interactions ?? []).map(optionSchema)
  const interactCues = acceptedInteractCues(offer)
  const actorId = anchoredActor(parsed)
  const maximum = typeof tools.maximumExternalActions === 'number' ? tools.maximumExternalActions : 2
  const variants: WorldJsonObject[] = []
  for (const actionType of allowed) {
    const frozen = actionType === 'interact'
    // A step with no option to address satisfies nothing, and `oneOf` with no member is not a schema at
    // all: such an action type is left out of the union rather than rendered as an impossible one.
    const parameters = frozen
      ? (steps.length === 0 ? undefined : steps.length === 1 ? steps[0]! : { oneOf: steps })
      : STEP_PARAMETERS[actionType]
    // An action type the protocol does not define a request shape for is not offered rather than guessed.
    if (parameters === undefined) continue
    const declared = object(declaredCues[actionType])
    const manifestation = frozen
      ? (interactCues.length > 0 ? manifestationSchema(interactCues) : undefined)
      : declared
    variants.push({
      type: 'object', additionalProperties: false,
      required: ['actionId', 'actorId', 'actionType', 'actionVersion', 'parameters'],
      properties: {
        actionId: { type: 'string', minLength: 1 },
        actorId: actorId === undefined ? { type: 'string', minLength: 1 } : { type: 'string', const: actorId },
        actionType: { type: 'string', const: actionType },
        actionVersion: { type: 'integer', const: frozen ? 2 : 1 },
        parameters,
        ...(manifestation === undefined ? {} : { manifestation }),
      },
    })
  }
  // A world that offers nothing renders as a schema no answer reaches, which is the honest rendering of
  // "this character has no options": the model is told to abstain by a shape it cannot act through.
  return {
    type: 'object', additionalProperties: false, required: ['schemaVersion', 'decision', 'actions'],
    properties: {
      schemaVersion: { type: 'integer', const: 7 },
      decision: { type: 'string', enum: ['act', 'abstain'] },
      actions: variants.length === 0 ? { type: 'array', maxItems: 0 }
        : { type: 'array', maxItems: maximum,
          items: variants.length === 1 ? variants[0]! : { oneOf: variants } },
    },
  }
}

/** What the model is told to do with the schema, out of the group's own declared policy. */
export function actionGroupDescription(exact: ExactProviderRequest): string {
  const group = object(exact.tools.actionGroup) ?? {}
  const maximum = typeof exact.tools.maximumExternalActions === 'number' ? exact.tools.maximumExternalActions : 2
  return 'Submit exactly the actions this character takes, in the shape this schema states.'
    + ` At most ${maximum} step(s), in proposal order`
    + `${group.failure === 'stop_remaining_steps' ? '; a step the world rejects ends the rest' : ''}.`
}

/** One prepared character call, ready to send. */
export function actionGroupCall(exact: ExactProviderRequest): ChatCall {
  return { messages: chatMessages(exact.messages), schema: actionGroupWireSchema(exact),
    description: actionGroupDescription(exact) }
}

/**
 * One prepared interpretation call. The Host's intent request already carries the JSON Schema its own
 * binder validates against, so the adapter renders the request as messages and hands that schema over
 * unchanged: the semantics belong to the Host, the formatting to the adapter.
 */
export function intentCall(request: WorldJsonObject): ChatCall {
  const contract = text(request.contract) ?? ''
  const schema = object(request.responseSchema)
  if (schema === undefined) throw new TypeError('player intent request carries no response schema')
  return {
    messages: [
      { role: 'system', content: `${contract} Answer by returning the registered tool payload only.` },
      { role: 'user', content: JSON.stringify({ sourceText: text(request.sourceText) ?? '',
        affordances: Array.isArray(request.affordances) ? request.affordances : [] }) },
    ],
    schema,
    description: 'Select the exact affordances this player input addresses, preserving source order.',
  }
}
