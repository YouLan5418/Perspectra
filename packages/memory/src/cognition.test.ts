import { describe, expect, it } from 'vitest'
import { brandId, hashWorldJson, type CharacterView, type ProjectionRecord } from '@harness-world/contracts'
import { CharacterReflectRule, KnowledgeRule } from './cognition.ts'

const characterId = brandId('character:cognition', 'CharacterId')

function projection(kind: 'observation' | 'claim', id: string, value: ProjectionRecord['value']): ProjectionRecord {
  return { kind, id, value, sourceSeq: 1 }
}

function view(observations: ProjectionRecord[], claims: ProjectionRecord[] = []): CharacterView {
  const base = {
    address: {
      tenantId: brandId('tenant:cognition', 'TenantId'),
      worldId: brandId('world:cognition', 'WorldId'),
      branchId: brandId('branch:main', 'BranchId'),
    },
    characterId,
    asOfWorldSeq: 1,
    locationId: 'location:room',
    scenes: [], observations, selfObservations: [], claims, goals: [], visibility: [],
  }
  return { ...base, bundleHash: hashWorldJson('world-character-view', base) }
}

describe('KnowledgeRule', () => {
  it('derives observed and reported-speech Claims without promoting speech to truth', () => {
    const observations = [
      projection('observation', 'observation:seen', {
        observerId: characterId,
        knowledgeCandidate: { claimId: 'claim:seen', proposition: 'the apple is red' },
      }),
      projection('observation', 'observation:said', {
        observerId: characterId,
        utterance: { speakerId: 'character:other', text: 'the moon is cheese' },
      }),
      projection('observation', 'observation:ignored', { observerId: characterId }),
      projection('observation', 'observation:primitive', 'visible but unstructured'),
    ]
    const events = new KnowledgeRule().derive(view(observations))
    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({ data: { id: 'claim:seen', value: { epistemicStatus: 'observed' } } })
    expect(events[1]).toMatchObject({
      data: { id: 'claim:said:observation:said', value: { proposition: 'character:other said: the moon is cheese', epistemicStatus: 'reported-speech' } },
    })
  })

  it('fails closed on malformed cognitive candidates', () => {
    expect(() => new KnowledgeRule().derive(view([
      projection('observation', 'bad-candidate', { knowledgeCandidate: { claimId: 1 } }),
    ]))).toThrow('knowledgeCandidate')
    expect(() => new KnowledgeRule().derive(view([
      projection('observation', 'bad-utterance', { utterance: { speakerId: 'speaker', text: 1 } }),
    ]))).toThrow('utterance')
  })
})

describe('CharacterReflectRule', () => {
  it('permits a possibly false reflected belief only from current cognitive records', () => {
    const characterView = view(
      [projection('observation', 'observation:1', { observerId: characterId, content: 'ambiguous' })],
      [projection('claim', 'claim:old', { characterId, proposition: 'old belief' })],
    )
    const request = {
      claimId: 'claim:reflected',
      proposition: 'a possibly false belief',
      sourceRefs: [
        { kind: 'observation' as const, id: 'observation:1' },
        { kind: 'claim' as const, id: 'claim:old' },
      ],
      correlationId: 'reflect',
    }
    expect(new CharacterReflectRule().resolve(characterView, request)).toMatchObject({
      eventType: 'claim.upsert',
      data: { id: 'claim:reflected', value: { characterId, epistemicStatus: 'reflected' } },
    })
    const invalid = [
      { ...request, claimId: '' },
      { ...request, proposition: '' },
      { ...request, sourceRefs: [] },
      { ...request, sourceRefs: [{ kind: 'summary' as const, id: 'summary:1' }] },
      { ...request, sourceRefs: [{ kind: 'observation' as const, id: 'observation:hidden' }] },
      { ...request, sourceRefs: [{ kind: 'claim' as const, id: 'claim:hidden' }] },
      { ...request, sourceRefs: [{ kind: 'claim' as const, id: 'claim:old' }, { kind: 'claim' as const, id: 'claim:old' }] },
    ]
    for (const value of invalid) {
      expect(() => new CharacterReflectRule().resolve(characterView, value)).toThrowError(expect.objectContaining({
        envelope: expect.objectContaining({ errorCode: 'ACTION_REJECTED' }),
      }))
    }
  })
})
