import Ajv from 'ajv'
import { describe, expect, it } from 'vitest'
import { createStepManifestationSchema, type WorldJsonObject } from '@harness-world/contracts'
import { actionGroupCall, actionGroupDescription, actionGroupWireSchema, chatMessages, intentCall,
  type ExactProviderRequest } from './wire.ts'

const segment = (segmentKind: string, content: unknown) =>
  ({ role: 'user', content: JSON.stringify({ segmentKind, content }) })

/** The Host's own tool description, as the frozen context assembles it. */
function tools(over: WorldJsonObject = {}): WorldJsonObject {
  return {
    type: 'object', schemaVersion: 'submit_actions/v7', maximumExternalActions: 2, maximumReflectionOperations: 4,
    actionGroup: { version: 'bounded-action-group/v2', allowedActionTypes: ['speak', 'move', 'interact'],
      maximumSpeechActions: 1, maximumWorldOperations: 1, order: 'proposal', failure: 'stop_remaining_steps',
      interleaving: 'forbidden', newInformationRequiresNextCall: true,
      manifestation: { optional: true, schemasByAction: {
        speak: createStepManifestationSchema('speak'), move: createStepManifestationSchema('move'),
        interact: createStepManifestationSchema('interact') } } },
    interact: { parameters: ['targetRef', 'bindingId', 'definitionRef', 'arguments'],
      choices: 'context.affordances.interactions', performanceAcceptances: 'context.affordances.performances',
      execution: 'revalidate_current_bound_prefix' },
    ...over,
  }
}

/** What the world offers this character: two interactions, one of them taking cues and one taking none. */
const affordanceSegment: readonly WorldJsonObject[] = [
  { actionType: 'speak', actionVersion: 1 },
  { actionType: 'move', actionVersion: 1 },
  { actionType: 'interact', actionVersion: 2,
    performances: [{ definitionRef: { id: 'base:give', version: 1 },
      accepted: [{ cue: 'smile', placement: 'both', requiresRole: null },
        { cue: 'frown', placement: 'both', requiresRole: null }] }],
    interactions: [
      { targetRef: { kind: 'entity', id: 'entity:umbrella' }, bindingId: 'binding:umbrella-give',
        definitionRef: { id: 'base:give', version: 1 }, arguments: { recipientId: 'character:friend' } },
      { targetRef: { kind: 'entity', id: 'entity:cup' }, bindingId: 'binding:cup-take',
        definitionRef: { id: 'base:take', version: 1 }, arguments: {} },
    ] },
]

function exact(over: Partial<ExactProviderRequest> = {}): ExactProviderRequest {
  return {
    messages: [
      { role: 'system', content: '{"authority":"world_event_log"}' },
      { role: 'developer', content: '{"role":"portray exactly one character"}' },
      segment('character_anchor', { characterId: 'character:companion', name: '同行者' }),
      segment('affordances', affordanceSegment),
      segment('output_reminder', { tool: 'submit_actions/v7' }),
    ],
    tools: tools(),
    ...over,
  }
}

const compiled = (request: ExactProviderRequest) => new Ajv({ strict: false }).compile(actionGroupWireSchema(request))

const give = (over: WorldJsonObject = {}): WorldJsonObject => ({ actionId: 'a1', actorId: 'character:companion',
  actionType: 'interact', actionVersion: 2, parameters: { targetRef: { kind: 'entity', id: 'entity:umbrella' },
    bindingId: 'binding:umbrella-give', definitionRef: { id: 'base:give', version: 1 },
    arguments: { recipientId: 'character:friend' } }, ...over })

describe('the wire schema an endpoint can bind to', () => {
  it('renders the group declaration, the offered options and the accepted cues', () => {
    const validate = compiled(exact())
    expect(validate({ schemaVersion: 7, decision: 'act', actions: [give()] })).toBe(true)
    expect(validate({ schemaVersion: 7, decision: 'abstain', actions: [] })).toBe(true)
    expect(validate({ schemaVersion: 7, decision: 'act', actions: [give({ actionVersion: 1 })] })).toBe(false)
    expect(validate({ schemaVersion: 7, decision: 'act', actions: [give({ actorId: 'character:other' })] })).toBe(false)
    expect(validate({ schemaVersion: 7, decision: 'act', actions: [3] })).toBe(false)
    expect(validate({ schemaVersion: 8, decision: 'act', actions: [give()] })).toBe(false)
    // The cue union is the offered definitions' own answer: a cue outside it is not in the schema at all.
    expect(validate({ schemaVersion: 7, decision: 'act',
      actions: [give({ manifestation: { independent: ['nod'], onSuccess: [] } })] })).toBe(false)
    expect(validate({ schemaVersion: 7, decision: 'act',
      actions: [give({ manifestation: { independent: ['smile'], onSuccess: ['frown'] } })] })).toBe(true)
    // The other offered option is the same step shape with the Host's own arguments left out of it.
    expect(validate({ schemaVersion: 7, decision: 'act', actions: [{ actionId: 'a1', actorId: 'character:companion',
      actionType: 'interact', actionVersion: 2, parameters: { targetRef: { kind: 'entity', id: 'entity:cup' },
        bindingId: 'binding:cup-take', definitionRef: { id: 'base:take', version: 1 }, arguments: {} } }] })).toBe(true)
    // Speech keeps the protocol's own parameters and the whole closed vocabulary for its own step.
    expect(validate({ schemaVersion: 7, decision: 'act', actions: [{ actionId: 'a1', actorId: 'character:companion',
      actionType: 'speak', actionVersion: 1, parameters: { text: '雨小了。' },
      manifestation: { independent: ['smile'], onSuccess: ['quiet_voice'] } }] })).toBe(true)
    expect(validate({ schemaVersion: 7, decision: 'act', actions: [{ actionId: 'a1', actorId: 'character:companion',
      actionType: 'move', actionVersion: 1, parameters: { text: 'not a location' } }] })).toBe(false)
  })

  it('states no cue list where no offered definition accepts one', () => {
    const validate = compiled(exact({ messages: [segment('character_anchor', { characterId: 'character:companion' }),
      segment('affordances', [{ actionType: 'interact', actionVersion: 2, performances: [] }])] }))
    expect(validate({ schemaVersion: 7, decision: 'act', actions: [{ actionId: 'a1', actorId: 'character:companion',
      actionType: 'interact', actionVersion: 2, parameters: {}, manifestation: { independent: [], onSuccess: [] } }] })).toBe(false)
  })

  it('renders what a Host that said less still says', () => {
    // No affordance segment at all: the interaction step has no option to address, so it is left out of the
    // union entirely - `oneOf: []` is not a schema - while speech and movement stay, and the actor is only
    // a string because no anchor named one.
    const bare = actionGroupWireSchema(exact({ messages: [{ role: 'user', content: 'not a segment' }] }))
    const compiledBare = new Ajv({ strict: false }).compile(bare)
    expect(JSON.stringify(bare)).toContain('"actorId":{"type":"string","minLength":1}')
    expect(JSON.stringify(bare)).toContain('"actionType":{"type":"string","const":"speak"}')
    expect(JSON.stringify(bare)).not.toContain('"const":"interact"')
    expect(compiledBare({ schemaVersion: 7, decision: 'abstain', actions: [] })).toBe(true)
    // A group that allows nothing renders as a schema nothing reaches, which is what an empty offer means.
    const none = actionGroupWireSchema(exact({ tools: tools({ actionGroup: {
      ...(tools().actionGroup as WorldJsonObject), allowedActionTypes: [] } }) }))
    expect(new Ajv({ strict: false }).compile(none)({ schemaVersion: 7, decision: 'act',
      actions: [{ actionId: 'a', actorId: 'character:companion', actionType: 'speak', actionVersion: 1,
        parameters: { text: '好' } }] })).toBe(false)
    // An action type the protocol has no request shape for is left out rather than guessed at.
    const filtered = actionGroupWireSchema(exact({ tools: tools({ maximumExternalActions: 1,
      actionGroup: { ...(tools().actionGroup as WorldJsonObject), allowedActionTypes: ['speak', 'reflect'] } }) }))
    const validate = new Ajv({ strict: false }).compile(filtered)
    expect(JSON.stringify(filtered)).not.toContain('reflect')
    expect(validate({ schemaVersion: 7, decision: 'act', actions: [{ actionId: 'a1', actorId: 'character:companion',
      actionType: 'speak', actionVersion: 1, parameters: { text: '好' } }] })).toBe(true)
    expect(validate({ schemaVersion: 7, decision: 'act', actions: [
      { actionId: 'a1', actorId: 'character:companion', actionType: 'speak', actionVersion: 1, parameters: { text: '好' } },
      { actionId: 'a2', actorId: 'character:companion', actionType: 'speak', actionVersion: 1, parameters: { text: '好' } }] })).toBe(false)
  })

  it('renders the shapes a Host that stated less still produces', () => {
    // No declared cue vocabulary, no group maximum, and options and accepted lists that are partly not what
    // they should be: each one is read for what it is, and the schema states only what the Host did.
    const sparse = actionGroupWireSchema({
      messages: [segment('affordances', [{ actionType: 'interact', actionVersion: 2,
        performances: [{ definitionRef: { id: 'base:give', version: 1 }, accepted: 'not an array' },
          { definitionRef: { id: 'base:give', version: 1 }, accepted: [null, { cue: '' }, { cue: 'nod' }] }],
        interactions: [{ bindingId: 'binding:sparse' }] }])],
      tools: { type: 'object', schemaVersion: 'submit_actions/v7',
        actionGroup: { version: 'bounded-action-group/v2', allowedActionTypes: ['speak', 'interact', 7] } },
    })
    const validate = new Ajv({ strict: false }).compile(sparse)
    expect(JSON.stringify(sparse)).toContain('"enum":["nod"]')
    // An option that names no target or arguments is still an option: its consts are simply not stated.
    expect(validate({ schemaVersion: 7, decision: 'act', actions: [{ actionId: 'a1', actorId: 'character:any',
      actionType: 'interact', actionVersion: 2, parameters: { targetRef: { kind: 'entity', id: 'entity:any' },
        bindingId: 'binding:sparse', definitionRef: { id: 'base:give', version: 1 }, arguments: {} } }] })).toBe(true)
    // With no declared vocabulary a speech step has no cue list at all, rather than an invented one.
    expect(validate({ schemaVersion: 7, decision: 'act', actions: [{ actionId: 'a1', actorId: 'character:any',
      actionType: 'speak', actionVersion: 1, parameters: { text: '好' } }] })).toBe(true)
    expect(validate({ schemaVersion: 7, decision: 'act', actions: [{ actionId: 'a1', actorId: 'character:any',
      actionType: 'speak', actionVersion: 1, parameters: { text: '好' },
      manifestation: { independent: [], onSuccess: [] } }] })).toBe(false)
    // A non-string in the declared list is not an action type, and the group maximum falls back to the
    // protocol's own two: three steps are refused.
    const speakSteps = (count: number) => Array.from({ length: count }, (_, index) => ({ actionId: `a${index}`,
      actorId: 'character:any', actionType: 'speak', actionVersion: 1, parameters: { text: '好' } }))
    expect(validate({ schemaVersion: 7, decision: 'act', actions: speakSteps(2) })).toBe(true)
    expect(validate({ schemaVersion: 7, decision: 'act', actions: speakSteps(3) })).toBe(false)
  })

  it('reads a Host that described nothing at all without inventing anything', () => {
    // A message whose JSON is a primitive is not a segment, and a tool description with no group declares
    // no action type: the rendered schema then reaches nothing, which is the honest answer to "no options".
    const nothing = actionGroupWireSchema({ messages: [{ role: 'user', content: '1234' }], tools: {} })
    const validate = new Ajv({ strict: false }).compile(nothing)
    expect((nothing.properties as WorldJsonObject).actions).toEqual({ type: 'array', maxItems: 0 })
    expect(validate({ schemaVersion: 7, decision: 'act', actions: [{ actionId: 'a1', actorId: 'character:any',
      actionType: 'speak', actionVersion: 1, parameters: { text: '好' } }] })).toBe(false)
  })

  it('tells the model what the group allows, out of the group’s own declaration', () => {
    expect(actionGroupDescription(exact())).toContain('At most 2 step(s)')
    expect(actionGroupDescription(exact())).toContain('a step the world rejects ends the rest')
    const permissive = actionGroupDescription(exact({ tools: tools({ maximumExternalActions: 1,
      actionGroup: { ...(tools().actionGroup as WorldJsonObject), failure: 'continue' } }) }))
    expect(permissive).toContain('At most 1 step(s)')
    expect(permissive).not.toContain('ends the rest')
    expect(actionGroupDescription({ messages: [], tools: {} })).toContain('At most 2 step(s)')
  })

  it('maps the role the endpoints do not know and passes every other message through', () => {
    expect(chatMessages([{ role: 'developer', content: 'a' }, { role: 'system', content: 'b' },
      { role: 'user', content: 'c' }])).toEqual([{ role: 'system', content: 'a' }, { role: 'system', content: 'b' },
      { role: 'user', content: 'c' }])
    expect(actionGroupCall(exact()).messages[1])
      .toEqual({ role: 'system', content: '{"role":"portray exactly one character"}' })
  })
})

describe('the interpretation call', () => {
  const responseSchema: WorldJsonObject = { type: 'object', additionalProperties: false, required: ['version'] }
  const request: WorldJsonObject = {
    version: 'player-intent-request/v2', contract: 'Interpret only the player intent.',
    sourceText: '我把杯子递给他', affordances: [{ affordanceId: 'give', actionType: 'interact', actionVersion: 2,
      parameters: { bindingId: 'binding:cup-give' }, performances: ['smile'] }],
    responseSchema,
  }

  it('renders the Host’s request as messages and hands its schema over unchanged', () => {
    const call = intentCall(request)
    expect(call.schema).toEqual(responseSchema)
    expect(call.messages[0]!.role).toBe('system')
    expect(call.messages[0]!.content).toContain('Interpret only the player intent.')
    expect(JSON.parse(call.messages[1]!.content))
      .toEqual({ sourceText: '我把杯子递给他', affordances: request.affordances })
  })

  it('refuses a request it cannot bind an answer to, and renders the empty one', () => {
    expect(() => intentCall({ ...request, responseSchema: null })).toThrow('no response schema')
    expect(() => intentCall({})).toThrow('no response schema')
    // A request with no contract and no source text still renders: the semantics are the Host's, and an
    // empty statement is the Host's to make rather than something for the adapter to refuse.
    expect(intentCall({ responseSchema }).messages[1]!.content)
      .toBe(JSON.stringify({ sourceText: '', affordances: [] }))
  })
})
