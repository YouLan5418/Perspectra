import { describe, expect, it } from 'vitest'
import {
  exampleActorId,
  inspectOperation,
  searchOperation,
  type InvestigationState,
} from '../../../sdk/src/gameplay.example.ts'
import { compileOperationContract, GameplayContractError } from './gameplay-contract.ts'

const state: InvestigationState = { energy: 2, clues: ['clue:archive-letter'] }

function errorCode(run: () => unknown): string | undefined {
  try {
    run()
  } catch (error) {
    expect(error).toBeInstanceOf(GameplayContractError)
    return error instanceof GameplayContractError ? error.code : undefined
  }
}

describe('the gameplay contract boundary', () => {
  it('validates and copies parameters from both authored operations', () => {
    const search = compileOperationContract(searchOperation)
    const inspect = compileOperationContract(inspectOperation)
    const searchParameters = { locationId: 'location:archive', effort: 1 }
    const inspectParameters = { clueId: 'clue:archive-letter' }

    const parsedSearch = search.parseParameters(searchParameters)
    const parsedInspect = inspect.parseParameters(inspectParameters)
    searchParameters.locationId = 'location:changed'

    expect(parsedSearch).toEqual({ locationId: 'location:archive', effort: 1 })
    expect(parsedInspect).toEqual(inspectParameters)
    expect(parsedSearch).not.toBe(searchParameters)
  })

  it.each([
    ['missing field', { effort: 1 }],
    ['wrong type', { locationId: 'location:archive', effort: 'one' }],
    ['extra field', { locationId: 'location:archive', effort: 1, targetId: 'character:other' }],
  ])('rejects search parameters with %s', (_label, value) => {
    const contract = compileOperationContract(searchOperation)
    expect(errorCode(() => contract.parseParameters(value))).toBe('GAMEPLAY_ARGUMENTS_INVALID')
  })

  it('resolves accepted search and validates and copies its outcome', () => {
    const result = searchOperation.resolve({
      compute: () => {
        throw new Error('no method in a schema-only test')
      },
      actorId: exampleActorId,
      parameters: { locationId: 'location:archive', effort: 1 },
      state,
    })
    expect(result.status).toBe('accepted')
    if (result.status !== 'accepted') throw new Error('expected accepted search')

    const contract = compileOperationContract(searchOperation)
    const parsed = contract.parseOutcome(result.outcome)
    expect(parsed).toEqual({ found: true, clueId: 'clue:archive-letter', remainingEnergy: 1 })
    expect(parsed).not.toBe(result.outcome)
    expect(result.effects).toEqual([
      expect.objectContaining({
        kind: 'status',
        changes: expect.arrayContaining([{ holderId: exampleActorId, key: 'energy', value: 1 }]),
      }),
    ])
  })

  it('keeps a business refusal structured without treating it as a contract fault', () => {
    const result = searchOperation.resolve({
      compute: () => {
        throw new Error('no method in a schema-only test')
      },
      actorId: exampleActorId,
      parameters: { locationId: 'location:archive', effort: 3 },
      state: { ...state, energy: 1 },
    })

    expect(result).toEqual({
      status: 'rejected',
      rejection: { code: 'INSUFFICIENT_ENERGY', message: '精力不足。' },
    })
  })

  it('validates the second operation independently and rejects malformed results', () => {
    const contract = compileOperationContract(inspectOperation)
    expect(contract.parseParameters({ clueId: 'clue:archive-letter' })).toEqual({
      clueId: 'clue:archive-letter',
    })
    expect(errorCode(() => contract.parseParameters({ clueId: 1 }))).toBe('GAMEPLAY_ARGUMENTS_INVALID')
    expect(errorCode(() => contract.parseParameters({ clueId: 'clue:archive-letter', extra: true }))).toBe(
      'GAMEPLAY_ARGUMENTS_INVALID',
    )
    expect(errorCode(() => contract.parseOutcome({ description: null }))).toBe('GAMEPLAY_OUTCOME_INVALID')
    expect(errorCode(() => contract.parseOutcome({ description: 'valid', extra: true }))).toBe(
      'GAMEPLAY_OUTCOME_INVALID',
    )
  })
})

it('B8 accepts partial offers for schemas with identity and whole-object constraints', () => {
  const contract = compileOperationContract({
    ...searchOperation,
    argumentSchema: {
      ...searchOperation.argumentSchema,
      $id: 'urn:b8:search',
      minProperties: 2,
    },
  })
  expect(contract.parseOfferParameters({ locationId: 'location:archive' })).toEqual({ locationId: 'location:archive' })
  expect(contract.parseOfferParameters({})).toEqual({})
  expect(() => contract.parseOfferParameters({ effort: 'invalid' })).toThrow()
  expect(() => contract.parseOfferParameters({ unknown: true })).toThrow()
  expect(() => contract.parseParameters({ locationId: 'location:archive' })).toThrow()
  expect(contract.parseParameters({ locationId: 'location:archive', effort: 1 })).toHaveProperty('effort', 1)
})
