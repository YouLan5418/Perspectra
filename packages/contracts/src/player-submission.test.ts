import Ajv from 'ajv'
import { describe, expect, it } from 'vitest'
import { brandId } from './ids.ts'
import { hashWorldJson } from './world-json.ts'
import { bindPlayerIntentCandidate, createPlayerIntentCandidateSchema,
  type PlayerIntentAffordance, type PlayerIntentBinding } from './player-submission.ts'

function binding(): PlayerIntentBinding {
  return {
    address: { tenantId: brandId('tenant:a', 'TenantId'), worldId: brandId('world:a', 'WorldId'), branchId: brandId('branch:a', 'BranchId') },
    inputId: 'input:1', actorId: brandId('character:player', 'CharacterId'), sourceText: '我牵住她的手，说“别走😀”，她没有挣脱。',
    interpretationProfile: 'intent:test/v1', interpretationReceiptHash: hashWorldJson('test', {}),
    affordances: [
      { affordanceId: 'hold', actionType: 'interact', actionVersion: 1, parameters: { targetId: 'character:alice', interactionId: 'core:hold-hand', arguments: {} } },
      { affordanceId: 'say', actionType: 'speak', actionVersion: 1, parameters: {} },
      { affordanceId: 'move', actionType: 'move', actionVersion: 1, parameters: { locationId: 'location:next' } },
    ],
  }
}

function candidate(): any {
  return {
    version: 'player-intent-candidate/v3', decision: 'act', reason: 'none',
    actions: [{ key: 'a', affordanceId: 'hold', quotes: ['我牵住她的手'] },
      { key: 'b', affordanceId: 'say', quotes: ['别走😀'] }],
  }
}

describe('player submission Host binding', () => {
  it('binds exact choices, local keys and UTF-16 spans without propagating unmapped narration', () => {
    const host = binding()
    const value = candidate()
    const result = bindPlayerIntentCandidate(value, host)
    expect(result.status).toBe('validated')
    if (result.status !== 'validated') throw new Error('expected validated')
    expect(result.submission.actions.map(action => action.actionType)).toEqual(['interact', 'speak'])
    expect(result.submission.actions[1]!.parameters).toEqual({ text: '别走😀' })
    expect(JSON.stringify(result.submission.actions)).not.toContain('她没有挣脱')
    expect(result.submission.sourceText).toBe(host.sourceText)
    expect(result.submission.actions.every(action => action.actorId === host.actorId)).toBe(true)
    expect(result.submission.sourceSpans.map(span => span.actionId)).toEqual(result.submission.actions.map(action => action.actionId))
    expect(bindPlayerIntentCandidate(value, host)).toEqual(result)
    expect(bindPlayerIntentCandidate(value, { ...host, inputId: 'input:2' })).not.toEqual(result)
    expect(bindPlayerIntentCandidate(value, { ...host, address: { ...host.address, branchId: brandId('branch:b', 'BranchId') } })).not.toEqual(result)
    ;(host.affordances[0]!.parameters as any).targetId = 'character:changed'
    value.actions[0].quotes[0] = 'mutated'
    expect(result.submission.actions[0]!.parameters).toMatchObject({ targetId: 'character:alice' })
    expect(result.submission.sourceSpans[0]!.text).toBe('我牵住她的手')
  })

  it('supports speech first, a single world action, and one action named by several quotes', () => {
    const value = candidate()
    // The player spoke before acting, so the quotes come in that order too; and one action may be named by
    // two quotes, which stay in the order they were said.
    value.actions.reverse()
    const host = { ...binding(), sourceText: '别走😀，我牵住她的手' }
    value.actions.find((action: any) => action.key === 'a').quotes = ['我牵', '住她的手']
    expect(bindPlayerIntentCandidate(value, host)).toMatchObject({ submission: { actions: [{ actionType: 'speak' }, { actionType: 'interact' }] } })
    const single = candidate()
    single.actions = [{ key: 'a', affordanceId: 'move', quotes: ['她的手'] }]
    expect(bindPlayerIntentCandidate(single, binding())).toMatchObject({ submission: { actions: [{ actionType: 'move', parameters: { locationId: 'location:next' } }] } })
  })

  it.each(['ambiguous', 'not_afforded', 'unsupported'])('returns %s without inventing an Action', reason => {
    expect(bindPlayerIntentCandidate({ version: 'player-intent-candidate/v3', decision: 'clarification_required', reason, actions: [] },
      { ...binding(), affordances: [] })).toEqual({ status: 'clarification_required', reason })
  })

  const mutations: [string, (value: any) => void][] = [
    ['version', v => { v.version = 'player-intent-candidate/v2' }], ['unknown reason', v => { v.reason = 'free narration' }],
    ['non-array actions', v => { v.actions = {} }], ['missing quotes', v => { delete v.actions[0].quotes }],
    ['unknown decision', v => { v.decision = 'say' }], ['act reason', v => { v.reason = 'ambiguous' }],
    ['zero actions', v => { v.actions = [] }], ['three actions', v => { v.actions.push(v.actions[0]) }],
    ['actor spoof', v => { v.actions[0].actorId = 'character:alice' }], ['action id spoof', v => { v.actions[0].actionId = 'evil' }],
    ['parameters spoof', v => { v.actions[0].parameters = { cannotEscape: true } }],
    ['unknown choice', v => { v.actions[0].affordanceId = 'unavailable' }], ['duplicate key', v => { v.actions[1].key = 'a' }],
    ['two world actions', v => { v.actions[1].affordanceId = 'move' }], ['two speech actions', v => { v.actions[0].affordanceId = 'say' }],
    ['key wrong type', v => { v.actions[0].key = 3 }], ['key whitespace', v => { v.actions[0].key = ' a' }],
    ['empty key', v => { v.actions[0].key = '' }], ['null action', v => { v.actions[0] = null }],
    ['array action', v => { v.actions[0] = [] }], ['primitive action', v => { v.actions[0] = true }],
    ['quotes that are not an array', v => { v.actions[0].quotes = '我牵住她的手' }],
    ['no quotes', v => { v.actions[0].quotes = [] }], ['too many quotes', v => { v.actions[0].quotes = Array(9).fill('手') }],
    ['a quote that is empty', v => { v.actions[0].quotes = [''] }], ['a quote that is not a string', v => { v.actions[0].quotes = [1] }],
    ['a repeated quote', v => { v.actions[0].quotes = ['我牵住她的手', '我牵住她的手'] }],
    // The one that matters: words the player never wrote must not become a span pointing at them.
    ['a quote the player never wrote', v => { v.actions[0].quotes = ['她无法反抗'] }],
    ['a story told out of order', v => { v.actions.reverse() }],
    ['a speech made of two quotes', v => { v.actions[1].quotes = ['别走', '😀'] }],
    ['clarification has action', v => { v.decision = 'clarification_required'; v.reason = 'ambiguous' }],
    ['clarification no reason', v => { v.decision = 'clarification_required'; v.actions = [] }],
  ]
  it.each(mutations)('rejects candidate %s', (_, mutate) => {
    const value = candidate()
    mutate(value)
    expect(() => bindPlayerIntentCandidate(value, binding())).toThrow()
  })

  it.each([
    (v: any) => { v.sourceText = '' }, (v: any) => { v.sourceText = 3 }, (v: any) => { v.interpretationReceiptHash = 'bad' },
    (v: any) => { v.address.branchId = '' }, (v: any) => { v.inputId = '' }, (v: any) => { v.actorId = '' },
    (v: any) => { v.interpretationProfile = '' }, (v: any) => { v.affordances.push(v.affordances[0]) },
    (v: any) => { v.affordances[0].actionVersion = 2 }, (v: any) => { v.affordances[0].actionType = 'reflect' },
    (v: any) => { v.affordances[0].parameters.arguments = null }, (v: any) => { v.affordances[0].parameters.arguments = [] },
    (v: any) => { v.affordances[0].parameters.arguments = 'future' },
    (v: any) => { v.affordances[1].parameters = { text: 'invented speech' } },
    (v: any) => { v.affordances[2].parameters.locationId = '' },
  ])('rejects malformed Host binding %#', mutate => {
    const host = binding()
    mutate(host)
    expect(() => bindPlayerIntentCandidate(candidate(), host)).toThrow()
  })

  it('publishes a closed structural schema and keeps semantic checks at the Host boundary', () => {
    const validate = new Ajv({ strict: true }).compile(createPlayerIntentCandidateSchema())
    expect(validate(candidate())).toBe(true)
    expect(validate({ version: 'player-intent-candidate/v3', decision: 'clarification_required', reason: 'ambiguous', actions: [] })).toBe(true)
    // The published schema is the only readable version: the Host hands it to the interpreter in the very
    // request it hashes, so the version this rejects is the one it never accepted a response for.
    expect(validate({ version: 'player-intent-candidate/v2', decision: 'clarification_required', reason: 'ambiguous', actions: [] })).toBe(false)
    for (const property of ['actorId', 'parameters', 'actionId', 'resolutionAuthority', 'manifestation', 'performance']) {
      // A field the protocol states is typed, not free: a forged one is refused by the schema and by the binder.
      const value = candidate()
      value.actions[0][property] = 'forged'
      expect(validate(value)).toBe(false)
      expect(() => bindPlayerIntentCandidate(value, binding())).toThrow()
    }
    // JSON Schema cannot prove source slicing, actual affordances or cross-array keys.
    const unknown = candidate()
    unknown.actions[0].affordanceId = 'unavailable'
    expect(validate(unknown)).toBe(true)
    expect(() => bindPlayerIntentCandidate(unknown, binding())).toThrow('not uniquely afforded')
  })

  it('binds a frozen interaction choice at its own version, and refuses one it cannot read', () => {
    const take: PlayerIntentAffordance = { affordanceId: 'take', actionType: 'interact', actionVersion: 2, parameters: {
      targetRef: { kind: 'entity', id: 'entity:cup' }, bindingId: 'binding:entity:cup:base:take',
      definitionRef: { id: 'base:take', version: 1 }, arguments: {},
    } }
    const say: PlayerIntentAffordance = { affordanceId: 'say', actionType: 'speak', actionVersion: 1, parameters: {} }
    const frozen = { ...binding(), sourceText: '拿起杯子', affordances: [take, say] }
    const value = { ...candidate(), actions: [{ key: 'a', affordanceId: 'take', quotes: ['拿起杯子'] }] }
    const result = bindPlayerIntentCandidate(value, frozen)
    if (result.status !== 'validated') throw new Error('expected validated')
    // The produced action carries the version the choice named, and the frozen request it named with it.
    expect(result.submission.actions[0]!.actionVersion).toBe(2)
    expect(result.submission.actions[0]!.parameters).toEqual(take.parameters)
    for (const [name, mutate] of [
      ['a version no action type addresses', (choice: any) => { choice.actionVersion = 3 }],
      ['speech at a version above one', (choice: any) => { choice.actionType = 'speak'; choice.parameters = {}; choice.actionVersion = 2 }],
      ['a target kind that is not addressable', (choice: any) => { choice.parameters.targetRef.kind = 'room' }],
      ['a definition version of zero', (choice: any) => { choice.parameters.definitionRef.version = 0 }],
      ['arguments that are not an object', (choice: any) => { choice.parameters.arguments = [] }],
    ] as const) {
      const broken = structuredClone(take) as unknown as Record<string, unknown>
      mutate(broken as any)
      expect(() => bindPlayerIntentCandidate(value,
        { ...frozen, affordances: [broken as unknown as PlayerIntentAffordance] }), name).toThrow()
    }
  })

  it('states how the chosen interaction is done, out of what that definition accepts and nothing else', () => {
    const give = (): PlayerIntentAffordance => ({ affordanceId: 'give', actionType: 'interact', actionVersion: 2,
      parameters: { targetRef: { kind: 'entity', id: 'entity:cup' }, bindingId: 'binding:entity:cup:base:give',
        definitionRef: { id: 'base:give', version: 1 }, arguments: { recipientId: 'character:npc' } },
      performances: ['frown', 'smile', 'nod'] })
    // A definition that accepts nothing is offered without a list, and one cue on such a choice is refused
    // the same way a cue outside the list is: what the player asked for is not among the afforded options.
    const take = (): PlayerIntentAffordance => ({ affordanceId: 'take', actionType: 'interact', actionVersion: 2,
      parameters: { targetRef: { kind: 'entity', id: 'entity:cup' }, bindingId: 'binding:entity:cup:base:take',
        definitionRef: { id: 'base:take', version: 1 }, arguments: {} } })
    const source = '我皱着眉把杯子递给他'
    const host = { ...binding(), sourceText: source, affordances: [give(), take()] }
    const ask = (performance: unknown, affordanceId = 'give') => ({ ...candidate(),
      actions: [{ key: 'a', affordanceId, quotes: [source], performance }] })
    const result = bindPlayerIntentCandidate(ask({ independent: ['frown'], onSuccess: ['smile'] }), host)
    if (result.status !== 'validated') throw new Error('expected validated')
    // The step joins the frozen request, which is where the definition that owns the policy reads it, and
    // that request keeps the shape it always had: the step is the fifth key it already accepts.
    expect(result.submission.actions[0]!.parameters).toEqual({ ...give().parameters,
      performance: { independent: ['frown'], onSuccess: ['smile'] } })
    expect(bindPlayerIntentCandidate(ask({ independent: ['shake_head'], onSuccess: [] }), host))
      .toEqual({ status: 'clarification_required', reason: 'not_afforded' })
    expect(bindPlayerIntentCandidate(ask({ independent: ['nod'], onSuccess: [] }, 'take'), host))
      .toEqual({ status: 'clarification_required', reason: 'not_afforded' })
    const malformedAfterUnoffered = ask({ independent: ['shake_head'], onSuccess: [] })
    malformedAfterUnoffered.actions.push({ key: 'b', affordanceId: 'missing', quotes: [source] })
    expect(() => bindPlayerIntentCandidate(malformedAfterUnoffered, host))
      .toThrow('not uniquely afforded')
    const malformedQuoteAfterUnoffered = ask({ independent: ['shake_head'], onSuccess: [] })
    malformedQuoteAfterUnoffered.actions[0].quotes = ['不是原文']
    expect(() => bindPlayerIntentCandidate(malformedQuoteAfterUnoffered, host))
      .toThrow('quote is not in the player text')
    for (const [name, performance] of [
      ['a voice cue', { independent: ['quiet_voice'], onSuccess: [] }],
      ['a gait cue', { independent: [], onSuccess: ['slow_walk'] }],
      ['an unknown cue', { independent: ['bow'], onSuccess: [] }],
      ['a cue repeated in one list', { independent: ['nod', 'nod'], onSuccess: [] }],
      ['a list longer than the schema allows', { independent: Array.from({ length: 9 }, () => 'nod' as const), onSuccess: [] }],
      ['a list that is not an array', { independent: 'nod', onSuccess: [] }],
      ['a missing list', { independent: ['nod'] }],
      ['a field the step does not have', { independent: [], onSuccess: [], placement: 'both' }],
      ['a step that is not an object', 'nod'],
    ] as const) {
      expect(() => bindPlayerIntentCandidate(ask(performance), host), name).toThrow()
    }
    for (const [name, choice, reason] of [
      ['a catalog entry offering cues', { affordanceId: 'take', actionType: 'interact', actionVersion: 1,
        parameters: { targetId: 'entity:cup', interactionId: 'core:take', arguments: {} }, performances: ['nod'] },
        'only a frozen interaction choice declares accepted cues'],
      ['an unknown accepted cue', { ...give(), performances: ['bow'] }, 'unknown cue'],
      ['a voice cue accepted', { ...give(), performances: ['quiet_voice'] }, 'voice or gait cue'],
      ['the same accepted cue twice', { ...give(), performances: ['nod', 'nod'] }, 'duplicate player intent cue'],
      ['cues accepted on speech', { affordanceId: 'say', actionType: 'speak', actionVersion: 1, parameters: {}, performances: ['nod'] },
        'only a frozen interaction choice declares accepted cues'],
    ] as const) {
      expect(() => bindPlayerIntentCandidate(ask({ independent: [], onSuccess: [] }),
        { ...host, affordances: [choice as PlayerIntentAffordance] }), name).toThrow(reason)
    }
  })

})
