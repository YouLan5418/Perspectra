import { describe, expect, it } from 'vitest'
import { brandId } from '@harness-world/contracts'
import { SpeakMoveRulebook as CoreRulebook, WorldSpecCompiler } from '@harness-world/kernel'
import {
  currentInvestigationState,
  inspectionEvidenceId,
  investigationViewForCharacter,
  MysteryRulebookResolver,
} from './mystery-rulebooks.ts'

function compiled() {
  return new WorldSpecCompiler().compile({
    schemaVersion: 1,
    address: { tenantId: 'tenant:mystery-rulebook', worldId: 'world:mystery-rulebook', branchId: 'branch:main' },
    timeMode: 'TURN_DRIVEN',
    roundQueueLimit: 8,
    rulebook: { rulebookId: 'builtin:speak-move', version: 1 },
    locations: [
      { locationId: 'location:a', name: 'Alpha' },
      { locationId: 'location:b', name: 'Beta' },
    ],
    characters: [{ characterId: 'character:player', name: 'Player', locationId: 'location:a' }],
    playerBindings: [{ principalId: 'principal:player', characterId: 'character:player', sessionId: 'session:player' }],
    plugins: [],
  })
}

class SpeakMoveRulebook {
  readonly #resolver = new MysteryRulebookResolver()

  resolve(
    manifest: Parameters<CoreRulebook['resolve']>[0],
    events: Parameters<CoreRulebook['resolve']>[1],
    characterId: string,
    action: Parameters<CoreRulebook['resolve']>[3],
  ) {
    return this.#resolver.resolve({ manifest, events, characterId, action })
  }
}

describe('MysteryRulebookResolver', () => {
  it('resolves a complete inspect, ask, present, and accuse investigation under Rulebook v3', () => {
    const manifest = {
      ...compiled().manifest,
      rulebook: { rulebookId: 'builtin:speak-move' as const, version: 3 as const },
      entities: [{ entityId: 'entity:desk', locationId: 'location:a', kind: 'key-moved' }],
      characters: [
        { characterId: brandId('character:player', 'CharacterId'), name: 'Player', locationId: 'location:a' },
        { characterId: brandId('character:bob', 'CharacterId'), name: 'Bob', locationId: 'location:a' },
        { characterId: brandId('character:detective', 'CharacterId'), name: 'Detective', locationId: 'location:a' },
      ],
    }
    const base = [
      { eventType: 'character.created', data: { characterId: 'character:player', locationId: 'location:a' } },
      { eventType: 'character.created', data: { characterId: 'character:bob', locationId: 'location:a' } },
      { eventType: 'character.created', data: { characterId: 'character:detective', locationId: 'location:a' } },
      { eventType: 'entity.upsert', data: { entityId: 'entity:desk', locationId: 'location:a', kind: 'key-moved' } },
      {
        eventType: 'claim.upsert',
        data: {
          id: 'claim:culprit',
          value: { characterId: 'character:bob', seed: { proposition: { subject: 'character:bob', predicate: 'is_culprit', object: true } } },
        },
      },
      { eventType: 'claim.upsert', data: { id: 'claim:unrelated', value: { characterId: 'character:player', seed: { note: 'not a proposition' } } } },
      { eventType: 'claim.upsert', data: { id: 'claim:invalid-subject', value: { seed: { proposition: { subject: 1, predicate: 'is_culprit', object: true } } } } },
    ]
    const rulebook = new SpeakMoveRulebook()
    expect(currentInvestigationState(base)).toEqual({ status: 'open', culpritId: null, evidence: [] })
    expect(rulebook.resolve(manifest, base, 'character:player', { actionType: 'inspect', parameters: null }))
      .toMatchObject({ status: 'rejected', reason: 'inspect requires a manifest entityId' })
    expect(rulebook.resolve(manifest, base, 'character:player', { actionType: 'inspect', parameters: { entityId: 'entity:missing' } }))
      .toMatchObject({ status: 'rejected', reason: 'inspect requires a manifest entityId' })
    expect(rulebook.resolve(manifest, base, 'character:player', { actionType: 'dance', parameters: {} }))
      .toMatchObject({ status: 'rejected', reason: 'action type is not afforded by the V0 Rulebook' })
    const unavailable = [...base, {
      eventType: 'entity.taken', data: { entityId: 'entity:desk', characterId: 'character:bob', fromLocationId: 'location:a' },
    }]
    expect(rulebook.resolve(manifest, unavailable, 'character:player', { actionType: 'inspect', parameters: { entityId: 'entity:desk' } }))
      .toMatchObject({ status: 'rejected', reason: 'INSPECTION_TARGET_NOT_AVAILABLE' })

    const inspected = rulebook.resolve(manifest, base, 'character:player', {
      actionType: 'inspect', parameters: { entityId: 'entity:desk' },
    })
    expect(inspected).toMatchObject({
      status: 'accepted',
      events: [
        { eventType: 'entity.inspected', data: { evidenceId: 'evidence:key-moved' } },
        { eventType: 'observation.upsert', data: { value: { observerId: 'character:player' } } },
      ],
    })
    const afterInspect = [...base, ...inspected.events]
    expect(rulebook.resolve(manifest, afterInspect, 'character:player', {
      actionType: 'inspect', parameters: { entityId: 'entity:desk' },
    })).toMatchObject({ status: 'rejected', reason: 'ALREADY_INSPECTED' })

    for (const parameters of [
      { targetCharacterId: 'character:player', topicId: 'entity:desk' },
      { targetCharacterId: 'character:missing', topicId: 'entity:desk' },
      { targetCharacterId: 'character:bob', topicId: '' },
    ]) expect(rulebook.resolve(manifest, afterInspect, 'character:player', { actionType: 'ask', parameters }).status).toBe('rejected')
    const bobAway = [...afterInspect, {
      eventType: 'character.moved', data: { characterId: 'character:bob', toLocationId: 'location:b' },
    }]
    expect(rulebook.resolve(manifest, bobAway, 'character:player', {
      actionType: 'ask', parameters: { targetCharacterId: 'character:bob', topicId: 'entity:desk' },
    })).toMatchObject({ status: 'rejected', reason: 'ASK_TARGET_NOT_PRESENT' })
    const asked = rulebook.resolve(manifest, afterInspect, 'character:player', {
      actionType: 'ask', parameters: { targetCharacterId: 'character:bob', topicId: 'entity:desk' },
    })
    expect(asked).toMatchObject({ status: 'accepted', events: [{ eventType: 'character.asked' }, { eventType: 'observation.upsert' }] })

    expect(rulebook.resolve(manifest, afterInspect, 'character:player', {
      actionType: 'present_evidence', parameters: { evidenceId: 1, targetCharacterId: 'character:detective' },
    }).status).toBe('rejected')
    expect(rulebook.resolve(manifest, afterInspect, 'character:player', {
      actionType: 'present_evidence', parameters: { evidenceId: 'evidence:unknown', targetCharacterId: 'character:detective' },
    })).toMatchObject({ status: 'rejected', reason: 'EVIDENCE_NOT_KNOWN' })
    expect(rulebook.resolve(manifest, afterInspect, 'character:player', {
      actionType: 'present_evidence', parameters: { evidenceId: 'evidence:key-moved', targetCharacterId: 'character:player' },
    }).status).toBe('rejected')
    expect(rulebook.resolve(manifest, [...afterInspect, {
      eventType: 'character.moved', data: { characterId: 'character:detective', toLocationId: 'location:b' },
    }], 'character:player', {
      actionType: 'present_evidence', parameters: { evidenceId: 'evidence:key-moved', targetCharacterId: 'character:detective' },
    })).toMatchObject({ status: 'rejected', reason: 'EVIDENCE_TARGET_NOT_PRESENT' })
    const presented = rulebook.resolve(manifest, afterInspect, 'character:player', {
      actionType: 'present_evidence', parameters: { evidenceId: 'evidence:key-moved', targetCharacterId: 'character:detective' },
    })
    const afterPresented = [...afterInspect, ...presented.events]
    expect(currentInvestigationState(afterPresented).evidence).toEqual([{
      evidenceId: 'evidence:key-moved', discoveredBy: ['character:player'], presentedBy: ['character:player'],
    }])

    for (const parameters of [
      { suspectId: 'character:player', evidenceIds: ['evidence:key-moved'] },
      { suspectId: 'character:missing', evidenceIds: ['evidence:key-moved'] },
      { suspectId: 'character:bob', evidenceIds: [] },
      { suspectId: 'character:bob', evidenceIds: ['evidence:key-moved', 'evidence:key-moved'] },
      { suspectId: 'character:bob', evidenceIds: [1] },
    ]) expect(rulebook.resolve(manifest, afterPresented, 'character:player', { actionType: 'accuse', parameters }).status).toBe('rejected')
    expect(rulebook.resolve(manifest, afterInspect, 'character:player', {
      actionType: 'accuse', parameters: { suspectId: 'character:bob', evidenceIds: ['evidence:key-moved'] },
    })).toMatchObject({ status: 'rejected', reason: 'EVIDENCE_NOT_PRESENTED' })
    expect(rulebook.resolve(manifest, [...afterPresented, {
      eventType: 'character.moved', data: { characterId: 'character:bob', toLocationId: 'location:b' },
    }], 'character:player', {
      actionType: 'accuse', parameters: { suspectId: 'character:bob', evidenceIds: ['evidence:key-moved'] },
    })).toMatchObject({ status: 'rejected', reason: 'ACCUSE_TARGET_NOT_PRESENT' })
    const incorrect = rulebook.resolve(manifest, afterPresented, 'character:player', {
      actionType: 'accuse', parameters: { suspectId: 'character:detective', evidenceIds: ['evidence:key-moved'] },
    })
    expect(incorrect.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ eventType: 'investigation.accusation-resolved', data: expect.objectContaining({ outcome: 'incorrect' }) }),
    ]))
    expect(incorrect.events.some(event => event.eventType === 'investigation.case-closed')).toBe(false)
    expect(() => rulebook.resolve(manifest, [...afterPresented, {
      eventType: 'claim.upsert', data: {},
    }], 'character:player', {
      actionType: 'accuse', parameters: { suspectId: 'character:bob', evidenceIds: ['evidence:key-moved'] },
    })).toThrow('claim.upsert is malformed')
    const removedCulprit = rulebook.resolve(manifest, [...afterPresented, {
      eventType: 'claim.remove', data: { id: 'claim:culprit' },
    }], 'character:player', {
      actionType: 'accuse', parameters: { suspectId: 'character:bob', evidenceIds: ['evidence:key-moved'] },
    })
    expect(removedCulprit.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ eventType: 'investigation.accusation-resolved', data: expect.objectContaining({ outcome: 'incorrect' }) }),
    ]))
    const correct = rulebook.resolve(manifest, afterPresented, 'character:player', {
      actionType: 'accuse', parameters: { suspectId: 'character:bob', evidenceIds: ['evidence:key-moved'] },
    })
    expect(correct.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ eventType: 'investigation.accusation-resolved', data: expect.objectContaining({ outcome: 'correct' }) }),
      expect.objectContaining({ eventType: 'investigation.case-closed', data: expect.objectContaining({ culpritId: 'character:bob' }) }),
    ]))
    const solved = [...afterPresented, ...correct.events]
    expect(currentInvestigationState(solved)).toMatchObject({ status: 'solved', culpritId: 'character:bob' })
    expect(rulebook.resolve(manifest, solved, 'character:player', {
      actionType: 'accuse', parameters: { suspectId: 'character:bob', evidenceIds: ['evidence:key-moved'] },
    })).toMatchObject({ status: 'rejected', reason: 'CASE_ALREADY_CLOSED' })
  })

  it('uses author-only culprit seeds, entity evidence IDs, and a terminal v4 case barrier', () => {
    expect(() => inspectionEvidenceId('')).toThrow('entityId')
    const manifest = {
      ...compiled().manifest,
      rulebook: { rulebookId: 'builtin:speak-move' as const, version: 4 as const },
      entities: [
        { entityId: 'entity:first', locationId: 'location:a', kind: 'trace' },
        { entityId: 'entity:second', locationId: 'location:a', kind: 'trace' },
      ],
      characters: [
        { characterId: brandId('character:player', 'CharacterId'), name: 'Player', locationId: 'location:a' },
        { characterId: brandId('character:alice', 'CharacterId'), name: 'Alice', locationId: 'location:a' },
        { characterId: brandId('character:bob', 'CharacterId'), name: 'Bob', locationId: 'location:a' },
      ],
    }
    const base = [
      { eventType: 'character.created', data: { characterId: 'character:player', locationId: 'location:a' } },
      { eventType: 'character.created', data: { characterId: 'character:alice', locationId: 'location:a' } },
      { eventType: 'character.created', data: { characterId: 'character:bob', locationId: 'location:a' } },
      { eventType: 'entity.upsert', data: { entityId: 'entity:first', locationId: 'location:a', kind: 'trace' } },
      { eventType: 'entity.upsert', data: { entityId: 'entity:second', locationId: 'location:a', kind: 'trace' } },
      { eventType: 'claim.upsert', data: { id: 'claim:forged', value: { seed: { proposition: {
        subject: 'character:alice', predicate: 'is_culprit', object: true,
      } } } } },
      { eventType: 'investigation.culprit-seeded', data: { culpritId: 'character:bob', sourceClaimId: 'claim:author' } },
    ]
    const rulebook = new SpeakMoveRulebook()
    const inspected = rulebook.resolve(manifest, base, 'character:player', {
      actionType: 'inspect', parameters: { entityId: 'entity:first' },
    })
    const evidenceId = inspectionEvidenceId('entity:first')
    expect(inspected).toMatchObject({
      status: 'accepted', events: [{ data: { evidenceId } }, { data: { value: { source: 'rulebook:investigation/v4' } } }],
    })
    expect(inspectionEvidenceId('entity:second')).not.toBe(evidenceId)
    const afterInspect = [...base, ...inspected.events]
    const presented = rulebook.resolve(manifest, afterInspect, 'character:player', {
      actionType: 'present_evidence', parameters: { evidenceId, targetCharacterId: 'character:bob' },
    })
    const afterPresented = [...afterInspect, ...presented.events]
    expect(investigationViewForCharacter(currentInvestigationState(afterPresented), 'character:player')).toEqual({
      status: 'open', culpritId: null, evidence: [{ evidenceId, presented: true }],
    })
    expect(investigationViewForCharacter(currentInvestigationState(afterPresented), 'character:bob').evidence).toEqual([])
    const forged = rulebook.resolve(manifest, afterPresented, 'character:player', {
      actionType: 'accuse', parameters: { suspectId: 'character:alice', evidenceIds: [evidenceId] },
    })
    expect(forged).toMatchObject({
      status: 'accepted',
      events: expect.arrayContaining([expect.objectContaining({ data: expect.objectContaining({ outcome: 'incorrect' }) })]),
    })
    const correct = rulebook.resolve(manifest, afterPresented, 'character:player', {
      actionType: 'accuse', parameters: { suspectId: 'character:bob', evidenceIds: [evidenceId] },
    })
    expect(correct.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ eventType: 'investigation.case-closed' }),
    ]))
    const solved = [...afterPresented, ...correct.events]
    for (const actionType of ['inspect', 'ask', 'present_evidence', 'accuse']) {
      expect(rulebook.resolve(manifest, solved, 'character:player', { actionType, parameters: {} }))
        .toMatchObject({ status: 'rejected', reason: 'CASE_ALREADY_CLOSED' })
    }
    expect(() => rulebook.resolve(manifest, [
      ...afterPresented,
      { eventType: 'investigation.culprit-seeded', data: {} },
    ], 'character:player', {
      actionType: 'accuse', parameters: { suspectId: 'character:bob', evidenceIds: [evidenceId] },
    })).toThrow('culprit-seeded is malformed')
  })

  it('fails closed on divergent investigation event prefixes', () => {
    expect(currentInvestigationState([
      { eventType: 'entity.inspected', data: { evidenceId: 'evidence:z', entityId: 'entity:z', characterId: 'character:b' } },
      { eventType: 'entity.inspected', data: { evidenceId: 'evidence:a', entityId: 'entity:a', characterId: 'character:a' } },
    ]).evidence.map(value => value.evidenceId)).toEqual(['evidence:a', 'evidence:z'])
    expect(() => currentInvestigationState([
      { eventType: 'entity.inspected', data: { evidenceId: 'evidence:x' } },
    ])).toThrow('malformed')
    expect(() => currentInvestigationState([
      { eventType: 'evidence.presented', data: { evidenceId: 'evidence:x', characterId: 'character:a', targetCharacterId: 'character:b' } },
    ])).toThrow('no discovery')
    expect(() => currentInvestigationState([
      { eventType: 'entity.inspected', data: { evidenceId: 'evidence:x', entityId: 'entity:x', characterId: 'character:a' } },
      { eventType: 'evidence.presented', data: { evidenceId: 'evidence:x', characterId: 1, targetCharacterId: 'character:b' } },
    ])).toThrow('malformed')
    expect(() => currentInvestigationState([
      { eventType: 'investigation.case-closed', data: {} },
    ])).toThrow('malformed')
    expect(() => currentInvestigationState([
      { eventType: 'investigation.case-closed', data: { culpritId: 'character:a' } },
      { eventType: 'investigation.case-closed', data: { culpritId: 'character:b' } },
    ])).toThrow('diverges')
  })
})
