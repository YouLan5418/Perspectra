import { describe, expect, it } from 'vitest'
import { Ajv } from 'ajv'
import { ACTION_GROUP_CUES, brandId, type CharacterId } from '@harness-world/contracts'
import { createExperimentActionReferences, type ExperimentMessage } from './compact-context.ts'
import { groupedPlayerCommand, groupedPlaytestProposal, groupedPlaytestRequest } from './grouped-playtest.ts'

const actorId: CharacterId = brandId('character:alice', 'CharacterId')
const references = createExperimentActionReferences({
  locations: [{ locationId: 'location:kitchen', name: '厨房' }, { locationId: 'location:hall', name: '门厅' }],
  entities: [{ entityId: 'entity:cup', kind: 'cup', locationId: 'location:kitchen' }],
})

function contextMessages(): readonly ExperimentMessage[] {
  return [
    { role: 'system', content: '{"authority":"world_event_log"}' },
    { role: 'developer', content: '{"forbidden":[]}' },
    ...Array.from({ length: 10 }, (_, index) => ({ role: 'user' as const, content: `{"segmentKind":"segment-${index}"}` })),
  ]
}

function step(actionType: string, parameters: Record<string, unknown>, manifestation?: Record<string, unknown>) {
  return {
    actionId: `${actionType}-step`, actorId, actionType, actionVersion: 1, parameters,
    ...(manifestation === undefined ? {} : { manifestation }),
  }
}

describe('grouped playtest request contract', () => {
  it.each([4, 5] as const)('accepts exactly the placements the v%s schema accepts, with no host-only residual rule', version => {
    const request = groupedPlaytestRequest(contextMessages(), actorId, version, false, references)
    const validate = new Ajv({ strict: false }).compile(request.schema)
    const codes = Object.keys(ACTION_GROUP_CUES)
    const variants: readonly (readonly [string, Record<string, unknown>])[] = [
      ['speak', { text: '你好' }], ['move', { locationId: 'location:kitchen' }],
      version === 4 ? ['take', { entityId: 'entity:cup' }]
        : ['interact', { targetId: 'entity:cup', interactionId: 'core:take', arguments: {} }],
    ]
    for (const [actionType, parameters] of variants) {
      // Each code is absent, independent, or onSuccess: 3^8 combinations per action.
      for (let combination = 0; combination < 3 ** codes.length; combination++) {
        let digits = combination
        const manifestation = { independent: [] as string[], onSuccess: [] as string[] }
        for (const code of codes) {
          const placement = digits % 3
          digits = Math.floor(digits / 3)
          if (placement === 1) manifestation.independent.push(code)
          if (placement === 2) manifestation.onSuccess.push(code)
        }
        const proposal = { schemaVersion: version, decision: 'act', actions: [step(actionType, parameters, manifestation)] }
        let hostAccepted = true
        try { groupedPlaytestProposal(proposal, actorId, 'agent:alice', version, false) } catch { hostAccepted = false }
        const schemaAccepted = validate(proposal)
        // The schema can no longer be more permissive than the host on this axis: a cue repeated across the
        // two lists and an empty pair are both collapsed rather than failed, so the residual host-only rule
        // set is empty and the two sides agree on every placement.
        expect(hostAccepted, JSON.stringify({ actionType, manifestation, errors: validate.errors })).toBe(schemaAccepted)
      }
      for (const manifestation of [
        { independent: ['smile', 'smile'], onSuccess: [] },
        { independent: [], onSuccess: ['smile', 'smile'] },
        { independent: ['unknown'], onSuccess: [] },
      ]) {
        const proposal = { schemaVersion: version, decision: 'act', actions: [step(actionType, parameters, manifestation)] }
        expect(validate(proposal)).toBe(false)
        expect(() => groupedPlaytestProposal(proposal, actorId, 'agent:alice', version, false)).toThrow()
      }
      for (const manifestation of [
        { independent: [], onSuccess: [] },
        { independent: ['smile'], onSuccess: ['smile'] },
      ]) {
        const proposal = { schemaVersion: version, decision: 'act', actions: [step(actionType, parameters, manifestation)] }
        // Both are schema-legal, and the host now accepts them too: it collapses the repeat and the empty
        // pair instead of failing the whole group. Nothing the schema allows is rejected any more.
        expect(validate(proposal)).toBe(true)
        expect(() => groupedPlaytestProposal(proposal, actorId, 'agent:alice', version, false)).not.toThrow()
      }
      expect(validate({ schemaVersion: version, decision: 'act', actions: [step(actionType, parameters)] })).toBe(true)
    }
  }, 30_000)

  it('builds a v4 request that only exposes speak/move/take and no interact vocabulary', () => {
    const request = groupedPlaytestRequest(contextMessages(), actorId, 4, false, references)
    expect(request.renderer).toBe('grouped-playtest/v2')
    expect(request.mode).toBe('full')
    expect(request.messages).toHaveLength(contextMessages().length + 1)
    const contract = request.messages[2]!.content
    expect(request.messages[2]!.role).toBe('system')
    expect(contract).toContain('"const":4')
    expect(contract).toContain('"const":"take"')
    expect(contract).not.toContain('"const":"interact"')
    const schema = request.schema as { properties: { actions: { maxItems: number } } }
    expect(schema.properties.actions.maxItems).toBe(2)
  })

  it('builds a v5 request that exposes interact and drops reflection for reaction calls', () => {
    const root = groupedPlaytestRequest(contextMessages(), actorId, 5, false, references)
    expect(root.messages[2]!.content).toContain('"const":"interact"')
    const rootSchema = root.schema as { properties: Record<string, unknown> }
    expect(rootSchema.properties).toHaveProperty('reflection')

    const reaction = groupedPlaytestRequest(contextMessages(), actorId, 5, true, references)
    const reactionSchema = reaction.schema as { properties: Record<string, unknown> }
    expect(reactionSchema.properties).not.toHaveProperty('reflection')
  })

  it('hashes the source and rendered message sets deterministically', () => {
    const first = groupedPlaytestRequest(contextMessages(), actorId, 5, false, references)
    const second = groupedPlaytestRequest(contextMessages(), actorId, 5, false, references)
    expect(first.sourceMessagesHash).toBe(second.sourceMessagesHash)
    expect(first.renderedMessagesHash).toBe(second.renderedMessagesHash)
    expect(first.sourceMessagesHash).not.toBe(first.renderedMessagesHash)
  })
})

describe('grouped playtest proposal validation', () => {
  it('accepts a legal v4 speech-then-move group with closed manifestation cues', () => {
    const proposal = groupedPlaytestProposal({
      schemaVersion: 4, decision: 'act', actions: [
        step('speak', { text: '原来你在这里。' }, { independent: ['smile'], onSuccess: ['quiet_voice'] }),
        step('move', { locationId: 'location:kitchen' }, { independent: [], onSuccess: ['slow_walk'] }),
      ],
    }, actorId, 'agent:alice', 4, false)
    expect(proposal.decision).toBe('act')
    expect(proposal.actions.map(action => action.actionType)).toEqual(['speak', 'move'])
  })

  it('accepts a v5 interact step and rejects the v4 take vocabulary', () => {
    const interact = {
      schemaVersion: 5, decision: 'act', actions: [
        step('interact', { targetId: 'entity:cup', interactionId: 'core:take', arguments: {} }),
      ],
    }
    expect(() => groupedPlaytestProposal(interact, actorId, 'agent:alice', 5, false)).not.toThrow()
    expect(() => groupedPlaytestProposal(interact, actorId, 'agent:alice', 4, false)).toThrow()
  })

  it('rejects unknown cues, mis-applied cues and malformed groups', () => {
    const unknownCue = {
      schemaVersion: 4, decision: 'act', actions: [
        step('speak', { text: '你好' }, { independent: ['dance'], onSuccess: [] }),
      ],
    }
    expect(() => groupedPlaytestProposal(unknownCue, actorId, 'agent:alice', 4, false)).toThrow()

    const misappliedCue = {
      schemaVersion: 4, decision: 'act', actions: [
        step('speak', { text: '你好' }, { independent: ['quiet_voice'], onSuccess: [] }),
      ],
    }
    expect(() => groupedPlaytestProposal(misappliedCue, actorId, 'agent:alice', 4, false)).toThrow()

    const twoSpeeches = {
      schemaVersion: 4, decision: 'act', actions: [
        step('speak', { text: '甲' }), step('speak', { text: '乙' }),
      ],
    }
    expect(() => groupedPlaytestProposal(twoSpeeches, actorId, 'agent:alice', 4, false)).toThrow()

    const threeSteps = {
      schemaVersion: 4, decision: 'act', actions: [
        step('speak', { text: '甲' }), step('move', { locationId: 'location:kitchen' }),
        step('move', { locationId: 'location:hall' }),
      ],
    }
    expect(() => groupedPlaytestProposal(threeSteps, actorId, 'agent:alice', 4, false)).toThrow()

    const wrongActor = {
      schemaVersion: 4, decision: 'act', actions: [
        { ...step('speak', { text: '你好' }), actorId: 'character:bob' },
      ],
    }
    expect(() => groupedPlaytestProposal(wrongActor, actorId, 'agent:alice', 4, false)).toThrow()
  })

  it('forbids reflection operations during a reaction call', () => {
    const withReflection = {
      schemaVersion: 4, decision: 'act', actions: [step('speak', { text: '你好' })],
      reflection: { operations: [{ operationId: 'op:1' }] },
    }
    expect(() => groupedPlaytestProposal(withReflection, actorId, 'agent:alice', 4, true)).toThrow()
  })
})

describe('grouped player command parsing', () => {
  it('maps /say to a speech action for both protocol versions', () => {
    expect(groupedPlayerCommand('/say 你好', 4)).toEqual({ actionType: 'speak', parameters: { text: '你好' } })
    expect(groupedPlayerCommand('/say 你好', 5)).toEqual({ actionType: 'speak', parameters: { text: '你好' } })
  })

  it('parses /interact with and without a recipient only in v5', () => {
    expect(groupedPlayerCommand('/interact entity:cup core:take', 5)).toEqual({
      actionType: 'interact',
      parameters: { targetId: 'entity:cup', interactionId: 'core:take', arguments: {} },
    })
    expect(groupedPlayerCommand('/interact entity:cup core:give character:bob', 5)).toEqual({
      actionType: 'interact',
      parameters: { targetId: 'entity:cup', interactionId: 'core:give', arguments: { recipientId: 'character:bob' } },
    })
    expect(groupedPlayerCommand('/interact entity:cup core:take', 4)).toBeUndefined()
  })

  it('rejects the retired /take command and malformed interact arity', () => {
    expect(() => groupedPlayerCommand('/take entity:cup', 5)).toThrow()
    expect(() => groupedPlayerCommand('/interact entity:cup', 5)).toThrow()
    expect(() => groupedPlayerCommand('/interact entity:cup core:give a b', 5)).toThrow()
  })

  it('returns undefined for plain speech and unrelated slash commands', () => {
    expect(groupedPlayerCommand('你好', 5)).toBeUndefined()
    expect(groupedPlayerCommand('/status', 5)).toBeUndefined()
  })
})
