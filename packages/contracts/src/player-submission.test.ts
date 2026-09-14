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
    version: 'player-intent-candidate/v1', decision: 'act', reason: 'none',
    actions: [{ key: 'a', affordanceId: 'hold' }, { key: 'b', affordanceId: 'say' }],
    sourceSpans: [
      { actionKey: 'a', startUtf16: 0, endUtf16: 6, text: '我牵住她的手', kind: 'action' },
      { actionKey: 'b', startUtf16: 9, endUtf16: 13, text: '别走😀', kind: 'speech' },
    ],
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
    value.sourceSpans[0].text = 'mutated'
    expect(result.submission.actions[0]!.parameters).toMatchObject({ targetId: 'character:alice' })
    expect(result.submission.sourceSpans[0]!.text).toBe('我牵住她的手')
  })

  it('supports speech first, a single world action and repeated ordered action spans', () => {
    const value = candidate()
    value.actions.reverse()
    const host = { ...binding(), sourceText: '别走😀，我牵住她的手' }
    value.sourceSpans = [
      { actionKey: 'b', startUtf16: 0, endUtf16: 4, text: '别走😀', kind: 'speech' },
      { actionKey: 'a', startUtf16: 5, endUtf16: 7, text: '我牵', kind: 'action' },
      { actionKey: 'a', startUtf16: 7, endUtf16: 11, text: '住她的手', kind: 'action' },
    ]
    expect(bindPlayerIntentCandidate(value, host)).toMatchObject({ submission: { actions: [{ actionType: 'speak' }, { actionType: 'interact' }] } })
    const single = candidate()
    single.actions = [{ key: 'a', affordanceId: 'move' }]
    single.sourceSpans.pop()
    expect(bindPlayerIntentCandidate(single, binding())).toMatchObject({ submission: { actions: [{ actionType: 'move', parameters: { locationId: 'location:next' } }] } })
  })

  it.each(['ambiguous', 'not_afforded', 'unsupported'])('returns %s without inventing an Action', reason => {
    expect(bindPlayerIntentCandidate({ version: 'player-intent-candidate/v1', decision: 'clarification_required', reason, actions: [], sourceSpans: [] },
      { ...binding(), affordances: [] })).toEqual({ status: 'clarification_required', reason })
  })

  const mutations: [string, (value: any) => void][] = [
    ['version', v => { v.version = 'v2' }], ['unknown reason', v => { v.reason = 'free narration' }],
    ['non-array actions', v => { v.actions = {} }], ['non-array spans', v => { v.sourceSpans = null }],
    ['unknown decision', v => { v.decision = 'say' }], ['act reason', v => { v.reason = 'ambiguous' }],
    ['zero actions', v => { v.actions = [] }], ['three actions', v => { v.actions.push(v.actions[0]) }],
    ['actor spoof', v => { v.actions[0].actorId = 'character:alice' }], ['action id spoof', v => { v.actions[0].actionId = 'evil' }],
    ['parameters spoof', v => { v.actions[0].parameters = { cannotEscape: true } }],
    ['unknown choice', v => { v.actions[0].affordanceId = 'unavailable' }], ['duplicate key', v => { v.actions[1].key = 'a' }],
    ['two world actions', v => { v.actions[1].affordanceId = 'move' }], ['two speech actions', v => { v.actions[0].affordanceId = 'say' }],
    ['key wrong type', v => { v.actions[0].key = 3 }], ['key whitespace', v => { v.actions[0].key = ' a' }],
    ['empty key', v => { v.actions[0].key = '' }], ['null action', v => { v.actions[0] = null }],
    ['array action', v => { v.actions[0] = [] }], ['primitive action', v => { v.actions[0] = true }],
    ['foreign span', v => { v.sourceSpans[0].actionKey = 'missing' }],
    ['wrong order', v => { v.actions.reverse() }], ['fraction offset', v => { v.sourceSpans[0].startUtf16 = 0.5 }],
    ['noninteger end', v => { v.sourceSpans[0].endUtf16 = '6' }], ['negative offset', v => { v.sourceSpans[0].startUtf16 = -1 }],
    ['empty span', v => { v.sourceSpans[0].endUtf16 = 0 }], ['out of bounds', v => { v.sourceSpans[0].endUtf16 = 999 }],
    ['overlap', v => { v.sourceSpans[1].startUtf16 = 5 }], ['wrong text type', v => { v.sourceSpans[0].text = 1 }],
    ['rewritten text', v => { v.sourceSpans[0].text = '她无法反抗' }], ['wrong kind', v => { v.sourceSpans[0].kind = 'speech' }],
    ['missing span', v => { v.sourceSpans.pop() }], ['no spans', v => { v.sourceSpans = [] }],
    ['split surrogate', v => { v.sourceSpans[1].endUtf16 = 12; v.sourceSpans[1].text = '别走\ud83d' }],
    ['disconnected speech', v => { v.sourceSpans[1].endUtf16 = 10; v.sourceSpans[1].text = '别'; v.sourceSpans.push({ actionKey: 'b', startUtf16: 10, endUtf16: 13, text: '走😀', kind: 'speech' }) }],
    ['clarification has action', v => { v.decision = 'clarification_required'; v.reason = 'ambiguous' }],
    ['clarification has spans', v => { v.decision = 'clarification_required'; v.reason = 'ambiguous'; v.actions = [] }],
    ['clarification no reason', v => { v.decision = 'clarification_required'; v.actions = []; v.sourceSpans = [] }],
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
    expect(validate({ version: 'player-intent-candidate/v1', decision: 'clarification_required', reason: 'ambiguous', actions: [], sourceSpans: [] })).toBe(true)
    for (const property of ['actorId', 'parameters', 'actionId', 'resolutionAuthority', 'manifestation']) {
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
    const value = { ...candidate(), actions: [{ key: 'a', affordanceId: 'take' }],
      sourceSpans: [{ actionKey: 'a', startUtf16: 0, endUtf16: 4, text: '拿起杯子', kind: 'action' }] }
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

})
