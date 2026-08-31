import { describe, expect, it } from 'vitest'
import { brandId, hashWorldJson, type WorldHash } from '@harness-world/contracts'
import {
  planStableCallBudget,
  type StableCallBudgetCandidate,
  type StableCallBudgetLimits,
} from './stable-call-budget.ts'

const supplementary = brandId('character:\u{10000}', 'CharacterId')
const privateUse = brandId('character:\uE000', 'CharacterId')

function candidate(
  jobId: string,
  characterId = supplementary,
  estimatedTokens = 2,
  wave = 1,
  stimulus = jobId,
): StableCallBudgetCandidate {
  return {
    wave,
    characterId,
    stimulusHash: hashWorldJson('stable-budget-stimulus', stimulus),
    jobId,
    estimatedTokens,
  }
}

function limits(overrides: Partial<StableCallBudgetLimits> = {}): StableCallBudgetLimits {
  return {
    remainingCalls: 8,
    remainingTokens: 8,
    maxCallsPerCharacter: 2,
    usedCallsByCharacter: [],
    ...overrides,
  }
}

describe('planStableCallBudget', () => {
  it('freezes UTF-16 Job order and all three exclusion reasons before dispatch', () => {
    const plan = planStableCallBudget([
      candidate('job:later-wave', privateUse, 1, 2),
      candidate('job:private', privateUse, 2),
      candidate('job:supplementary', supplementary, 3),
      candidate('job:token', brandId('character:z', 'CharacterId'), 9),
    ], limits({
      remainingCalls: 2,
      remainingTokens: 5,
      maxCallsPerCharacter: 1,
      usedCallsByCharacter: [{ characterId: privateUse, calls: 1 }],
    }))
    expect(plan.decisions.map(value => [value.candidate.jobId, value.status, value.exclusion])).toEqual([
      ['job:token', 'skipped', 'token_budget_exhausted'],
      ['job:supplementary', 'reserved', null],
      ['job:private', 'skipped', 'character_limit'],
      ['job:later-wave', 'skipped', 'character_limit'],
    ])
    expect(plan).toMatchObject({
      reservedJobIds: ['job:supplementary'], reservedCalls: 1, reservedTokens: 3,
    })
    expect(plan.decisions.map(value => value.reservationOrdinal)).toEqual([null, 0, null, null])
    expect(plan.planHash).toBe(hashWorldJson('stable-call-budget-plan/v1', {
      limits: plan.limits,
      decisions: plan.decisions,
      reservedJobIds: plan.reservedJobIds,
      reservedCalls: plan.reservedCalls,
      reservedTokens: plan.reservedTokens,
    }))

    const callLimited = planStableCallBudget([
      candidate('job:a', brandId('character:a', 'CharacterId'), 1),
      candidate('job:b', brandId('character:b', 'CharacterId'), 1),
    ], limits({ remainingCalls: 1 }))
    expect(callLimited.decisions.map(value => value.exclusion)).toEqual([null, 'call_limit'])
  })

  it('rejects malformed limits, usage, identity, hash, and duplicate candidates', () => {
    for (const invalid of [
      limits({ remainingCalls: -1 }),
      limits({ remainingTokens: 0.5 }),
      limits({ maxCallsPerCharacter: 0 }),
      limits({ usedCallsByCharacter: [{ characterId: supplementary, calls: -1 }] }),
      limits({ maxCallsPerCharacter: 1, usedCallsByCharacter: [{ characterId: supplementary, calls: 2 }] }),
      limits({ usedCallsByCharacter: [
        { characterId: supplementary, calls: 0 }, { characterId: supplementary, calls: 0 },
      ] }),
      limits({ usedCallsByCharacter: [{ characterId: '' as typeof supplementary, calls: 0 }] }),
    ]) expect(() => planStableCallBudget([], invalid)).toThrow()

    for (const invalid of [
      { ...candidate('job:wave'), wave: 0 },
      { ...candidate('job:tokens'), estimatedTokens: 0 },
      { ...candidate('job:character'), characterId: '' as typeof supplementary },
      { ...candidate('job:hash'), stimulusHash: 'sha256:bad' as WorldHash },
      { ...candidate('job:id'), jobId: '' },
    ]) expect(() => planStableCallBudget([invalid], limits())).toThrow()

    expect(() => planStableCallBudget([
      candidate('job:same', supplementary), candidate('job:same', privateUse),
    ], limits())).toThrow('duplicate jobId')
    expect(() => planStableCallBudget([
      candidate('job:one', supplementary, 1, 1, 'same'),
      candidate('job:two', supplementary, 1, 1, 'same'),
    ], limits())).toThrow('one character and wave')
  })
})
