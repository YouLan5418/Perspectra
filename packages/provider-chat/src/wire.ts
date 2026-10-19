import type { CallInspection } from './request-inspector.ts'

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

/** One prepared call: the messages to send, the JSON Schema the answer is bound to, and what to ask for. */
export interface ChatCall {
  readonly inspection?: CallInspection
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

interface OfferedAffordance {
  readonly actionType?: unknown
  readonly interactions?: readonly WorldJsonObject[]
  /** Where a `move` may go, as the world stated it, one entry per location. */
  readonly destinations?: readonly WorldJsonObject[]
}

/** Movement's own request shape: a place, named. */
const MOVE_PARAMETERS: WorldJsonObject = { type: 'object', additionalProperties: false,
  required: ['locationId'], properties: { locationId: { type: 'string', minLength: 1 } } }

/**
 * Where a move may go: the world's own destinations, as a closed set. A model left to name a place it was
 * never shown names one that does not exist, and the world refuses the call after it was paid for. The names
 * travel in the description, because an id is what the request needs and the name is what a model chooses by.
 */
function moveParameters(offer: OfferedAffordance | undefined): WorldJsonObject {
  const places = (offer?.destinations ?? []).flatMap(entry => {
    const locationId = text(entry.locationId)
    return locationId === undefined ? [] : [{ locationId, name: text(entry.name) }]
  })
  if (places.length === 0) return MOVE_PARAMETERS
  return { type: 'object', additionalProperties: false, required: ['locationId'],
    properties: { locationId: { type: 'string', enum: places.map(place => place.locationId),
      description: places.map(place => place.name === undefined ? place.locationId
        : `${place.locationId} (${place.name})`).join(', ') } } }
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
      arguments: object(choice.argumentSchema) ?? { type: 'object', additionalProperties: false,
        ...(argumentKeys.length === 0 ? {} : {
          required: argumentKeys,
          properties: Object.fromEntries(argumentKeys.map(key =>
            [key, { type: typeof argumentsValue[key], ...constOf(argumentsValue[key]) }])),
        }) },
    },
  }
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

/** Parameters offered to the current single-character perform tool, in stable move/interact order. */
export function operationSchemas(affordances: WorldJsonValue | undefined): readonly {
  readonly actionType: 'move' | 'interact'; readonly parameters: WorldJsonObject
}[] {
  const entries = Array.isArray(affordances) ? affordances.map(object) : []
  const move = entries.find(entry => entry?.actionType === 'move')
  const interactions = entries.find(entry => entry?.actionType === 'interact')?.interactions
  const steps = Array.isArray(interactions) ? interactions.map(choice => optionSchema(choice as WorldJsonObject)) : []
  return [
    { actionType: 'move', parameters: moveParameters(move as OfferedAffordance | undefined) },
    ...(steps.length === 0 ? [] : [{ actionType: 'interact' as const,
      parameters: steps.length === 1 ? steps[0]! : { oneOf: steps } }]),
  ]
}
