import { describe, expect, it } from 'vitest'
import { hashWorldJson } from '@harness-world/contracts'
import {
  WorldPackContractError,
  parseWorldPackCognitionSourceV2,
} from './index.ts'

function minimalCognition() {
  return {
    schemaVersion: 'worldpack-cognition/v2',
    characters: [{
      characterId: 'character:alice',
      claims: [{ key: 'claim:late', proposition: { predicate: 'bob_late' }, stance: 'believed', confidencePermille: 800 }],
      goals: [{ key: 'goal:continue', objective: { kind: 'narrative', value: 'Continue the journey' } }],
      relationships: [{ key: 'relationship:bob-honesty', target: 'character:bob', type: 'distrust', facet: 'honesty', intensityPermille: 650 }],
      affects: [{ key: 'affect:anxiety', type: 'anxiety', intensityPermille: 600, cause: { key: 'claim:late' } }],
      innerTensions: [{
        key: 'tension:question-or-cooperate', title: 'Question Bob or preserve cooperation', pressurePermille: 700,
        poles: [
          { key: 'pole:question', tendency: 'express', impulseText: 'Ask for an explanation', strengthPermille: 650, awareness: 'conscious' },
          { key: 'pole:cooperate', tendency: 'preserve', impulseText: 'Keep the group moving', strengthPermille: 700, awareness: 'partially_conscious' },
        ],
      }],
      commitments: [{ key: 'commitment:travel', content: 'Travel together', origin: 'agreement' }],
      openLoops: [{ key: 'loop:late', kind: 'question', summary: 'Why was Bob late?' }],
    }],
  }
}

function explicitCognition() {
  const value = minimalCognition()
  return {
    ...value,
    characters: [{
      ...value.characters[0],
      claims: [{ ...value.characters[0]!.claims[0], saliencePermille: 900, awareness: 'partially_conscious', status: 'active', basisKeys: ['observation:arrival'] }],
      goals: [{
        ...value.characters[0]!.goals[0], priorityPermille: 750, awareness: 'unrecognized', status: 'blocked',
        parentGoalKey: 'goal:journey', targetKeys: ['character:bob'], blockerKeys: ['claim:road'], basisKeys: ['claim:late'],
      }],
      relationships: [{
        ...value.characters[0]!.relationships[0], confidencePermille: 850, awareness: 'partially_conscious',
        status: 'resolved', basisKeys: ['observation:arrival'],
      }],
      affects: [{
        ...value.characters[0]!.affects[0], targetKey: 'character:bob', awareness: 'unrecognized', expressionMode: 'leaking',
        duration: 'sustained', status: 'resolved', basisKeys: ['claim:late'],
      }],
      innerTensions: [{
        ...value.characters[0]!.innerTensions[0], awareness: 'partially_conscious', status: 'resolved', basisKeys: ['goal:continue'],
        poles: value.characters[0]!.innerTensions[0]!.poles.map(pole => ({ ...pole, basisKeys: ['goal:continue'] })),
      }],
      commitments: [{
        ...value.characters[0]!.commitments[0], saliencePermille: 850, awareness: 'partially_conscious',
        status: 'fulfilled', basisKeys: ['observation:promise'],
      }],
      openLoops: [{
        ...value.characters[0]!.openLoops[0], saliencePermille: 700, status: 'answered', basisKeys: ['observation:question'],
      }],
    }],
  }
}

function errorOf(value: unknown): WorldPackContractError {
  try {
    parseWorldPackCognitionSourceV2(value)
  } catch (error) {
    expect(error).toBeInstanceOf(WorldPackContractError)
    return error as WorldPackContractError
  }
  throw new Error('expected WorldPackContractError')
}

function mutate(change: (character: Record<string, any>) => void): unknown {
  const value = structuredClone(minimalCognition())
  change(value.characters[0] as Record<string, any>)
  return value
}

describe('World Pack v2 cognition source', () => {
  it('materializes every safe default without inventing omitted cognition', () => {
    const parsed = parseWorldPackCognitionSourceV2(minimalCognition())
    expect(parsed.characters[0]).toMatchObject({
      claims: [{ saliencePermille: 500, awareness: 'conscious', status: 'active', basisKeys: [] }],
      goals: [{ priorityPermille: 500, awareness: 'conscious', status: 'active', parentGoalKey: null, targetKeys: [], blockerKeys: [], basisKeys: [] }],
      relationships: [{ confidencePermille: 500, awareness: 'conscious', status: 'active', basisKeys: [] }],
      affects: [{ targetKey: null, awareness: 'conscious', expressionMode: 'restrained', duration: 'short_lived', status: 'active', basisKeys: [] }],
      innerTensions: [{ awareness: 'conscious', status: 'active', basisKeys: [], poles: [{ basisKeys: [] }, { basisKeys: [] }] }],
      commitments: [{ saliencePermille: 500, awareness: 'conscious', status: 'active', basisKeys: [] }],
      openLoops: [{ saliencePermille: 500, status: 'open', basisKeys: [] }],
    })
    expect(parseWorldPackCognitionSourceV2({ schemaVersion: 'worldpack-cognition/v2', characters: [{ characterId: 'character:empty' }] }))
      .toEqual({
        schemaVersion: 'worldpack-cognition/v2',
        characters: [{
          characterId: 'character:empty', claims: [], goals: [], relationships: [], affects: [], innerTensions: [], commitments: [], openLoops: [],
        }],
      })
    expect(hashWorldJson('world-pack-cognition-source/v2', parsed)).toBe(
      'sha256:52511c8c4b6f9ff613cd4d118e9425a23ed12739ec14316d576cb1c0481f76d6',
    )
  })

  it('preserves explicit registered vocabulary and materialized optional values', () => {
    const parsed = parseWorldPackCognitionSourceV2(explicitCognition())
    expect(parsed.characters[0]).toEqual(explicitCognition().characters[0])
    const withNulls = structuredClone(explicitCognition())
    withNulls.characters[0]!.goals[0]!.parentGoalKey = null as unknown as string
    withNulls.characters[0]!.affects[0]!.targetKey = null as unknown as string
    expect(parseWorldPackCognitionSourceV2(withNulls).characters[0]?.goals[0]?.parentGoalKey).toBeNull()
  })

  it.each([
    [null, 'PACK_SOURCE_INVALID'],
    [{ ...minimalCognition(), extra: true }, 'PACK_UNKNOWN_FIELD'],
    [{ ...minimalCognition(), schemaVersion: 'worldpack-cognition/v1' }, 'PACK_SOURCE_INVALID'],
    [{ ...minimalCognition(), characters: {} }, 'PACK_SOURCE_INVALID'],
    [{ ...minimalCognition(), characters: Array.from({ length: 257 }, (_, index) => ({ characterId: `character:${index}` })) }, 'PACK_LIMIT_EXCEEDED'],
    [{ ...minimalCognition(), characters: [minimalCognition().characters[0], minimalCognition().characters[0]] }, 'PACK_DUPLICATE_ID'],
    [mutate(character => { character.claims = {} }), 'PACK_SOURCE_INVALID'],
    [mutate(character => { character.claims = Array.from({ length: 513 }, (_, index) => ({ key: `claim:${index}` })) }), 'PACK_LIMIT_EXCEEDED'],
    [mutate(character => { character.goals[0].key = 'claim:late' }), 'PACK_DUPLICATE_ID'],
  ])('rejects invalid document, limits, and ambiguous local keys %#', (value, code) => {
    expect(errorOf(value).diagnostics[0].code).toBe(code)
  })

  it.each([
    [mutate(character => { delete character.claims[0].stance }), 'PACK_SOURCE_INVALID'],
    [mutate(character => { character.claims[0].extra = true }), 'PACK_UNKNOWN_FIELD'],
    [mutate(character => { character.claims[0].stance = 'certain' }), 'PACK_SOURCE_INVALID'],
    [mutate(character => { character.claims[0].confidencePermille = 1001 }), 'PACK_SOURCE_INVALID'],
    [mutate(character => { character.claims[0].saliencePermille = -1 }), 'PACK_SOURCE_INVALID'],
    [mutate(character => { character.claims[0].awareness = 'hidden' }), 'PACK_SOURCE_INVALID'],
    [mutate(character => { character.claims[0].status = 'resolved' }), 'PACK_SOURCE_INVALID'],
    [mutate(character => { character.claims[0].basisKeys = {} }), 'PACK_SOURCE_INVALID'],
    [mutate(character => { character.claims[0].basisKeys = ['same', 'same'] }), 'PACK_DUPLICATE_ID'],
  ])('rejects invalid Claim sources %#', (value, code) => {
    expect(errorOf(value).diagnostics[0].code).toBe(code)
  })

  it.each([
    [mutate(character => { character.goals[0].objective = null }), 'PACK_SOURCE_INVALID'],
    [mutate(character => { character.goals[0].objective.extra = true }), 'PACK_UNKNOWN_FIELD'],
    [mutate(character => { character.goals[0].objective.kind = 'percent' }), 'PACK_SOURCE_INVALID'],
    [mutate(character => { character.goals[0].priorityPermille = -1 }), 'PACK_SOURCE_INVALID'],
    [mutate(character => { character.goals[0].status = 'paused' }), 'PACK_SOURCE_INVALID'],
    [mutate(character => { character.goals[0].parentGoalKey = 1 }), 'PACK_SOURCE_INVALID'],
    [mutate(character => { character.goals[0].targetKeys = ['same', 'same'] }), 'PACK_DUPLICATE_ID'],
    [mutate(character => { character.goals[0].blockerKeys = {} }), 'PACK_SOURCE_INVALID'],
  ])('rejects invalid Goal sources %#', (value, code) => {
    expect(errorOf(value).diagnostics[0].code).toBe(code)
  })

  it.each([
    [mutate(character => { character.relationships[0].target = ' ' }), 'PACK_SOURCE_INVALID'],
    [mutate(character => { character.relationships[0].type = 'friendship' }), 'PACK_SOURCE_INVALID'],
    [mutate(character => { character.relationships[0].facet = '' }), 'PACK_SOURCE_INVALID'],
    [mutate(character => { character.relationships[0].intensityPermille = 1001 }), 'PACK_SOURCE_INVALID'],
    [mutate(character => { character.relationships[0].confidencePermille = -1 }), 'PACK_SOURCE_INVALID'],
    [mutate(character => { character.relationships[0].status = 'forgotten' }), 'PACK_SOURCE_INVALID'],
    [mutate(character => { character.affects[0].type = 'resentment' }), 'PACK_SOURCE_INVALID'],
    [mutate(character => { character.affects[0].intensityPermille = -1 }), 'PACK_SOURCE_INVALID'],
    [mutate(character => { character.affects[0].targetKey = 1 }), 'PACK_SOURCE_INVALID'],
    [mutate(character => { character.affects[0].expressionMode = 'explosive' }), 'PACK_SOURCE_INVALID'],
    [mutate(character => { character.affects[0].duration = 'forever' }), 'PACK_SOURCE_INVALID'],
    [mutate(character => { character.affects[0].status = 'forgotten' }), 'PACK_SOURCE_INVALID'],
  ])('rejects invalid Relationship and Affect sources %#', (value, code) => {
    expect(errorOf(value).diagnostics[0].code).toBe(code)
  })

  it.each([
    [mutate(character => { character.innerTensions[0].poles = [character.innerTensions[0].poles[0]] }), 'PACK_SOURCE_INVALID'],
    [mutate(character => { character.innerTensions[0].poles = Array.from({ length: 5 }, (_, index) => ({ key: `pole:${index}`, tendency: 'pursue', impulseText: 'Act', strengthPermille: 1, awareness: 'conscious' })) }), 'PACK_SOURCE_INVALID'],
    [mutate(character => { character.innerTensions[0].poles[1].key = 'pole:question' }), 'PACK_DUPLICATE_ID'],
    [mutate(character => { character.innerTensions[0].poles[0].extra = true }), 'PACK_UNKNOWN_FIELD'],
    [mutate(character => { character.innerTensions[0].poles[0].tendency = 'wait' }), 'PACK_SOURCE_INVALID'],
    [mutate(character => { character.innerTensions[0].poles[0].impulseText = '' }), 'PACK_SOURCE_INVALID'],
    [mutate(character => { character.innerTensions[0].poles[0].strengthPermille = 1001 }), 'PACK_SOURCE_INVALID'],
    [mutate(character => { character.innerTensions[0].poles[0].awareness = 'hidden' }), 'PACK_SOURCE_INVALID'],
    [mutate(character => { character.innerTensions[0].pressurePermille = -1 }), 'PACK_SOURCE_INVALID'],
    [mutate(character => { character.innerTensions[0].status = 'paused' }), 'PACK_SOURCE_INVALID'],
  ])('rejects invalid InnerTension sources %#', (value, code) => {
    expect(errorOf(value).diagnostics[0].code).toBe(code)
  })

  it.each([
    [mutate(character => { character.commitments[0].origin = 'coercion' }), 'PACK_SOURCE_INVALID'],
    [mutate(character => { character.commitments[0].saliencePermille = 1001 }), 'PACK_SOURCE_INVALID'],
    [mutate(character => { character.commitments[0].awareness = 'unrecognized' }), 'PACK_SOURCE_INVALID'],
    [mutate(character => { character.commitments[0].status = 'forgotten' }), 'PACK_SOURCE_INVALID'],
    [mutate(character => { character.openLoops[0].kind = 'mystery' }), 'PACK_SOURCE_INVALID'],
    [mutate(character => { character.openLoops[0].summary = '' }), 'PACK_SOURCE_INVALID'],
    [mutate(character => { character.openLoops[0].saliencePermille = -1 }), 'PACK_SOURCE_INVALID'],
    [mutate(character => { character.openLoops[0].status = 'paused' }), 'PACK_SOURCE_INVALID'],
  ])('rejects invalid Commitment and OpenLoop sources %#', (value, code) => {
    expect(errorOf(value).diagnostics[0].code).toBe(code)
  })
})
