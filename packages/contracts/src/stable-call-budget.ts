import { assertProtocolString, type CharacterId } from './ids.ts'
import type { ReactionRoleClass } from './reaction-cycle.ts'
import { compareWorldText, hashWorldJson, type WorldHash, type WorldJsonObject } from './world-json.ts'

export interface StableCallBudgetCandidate extends WorldJsonObject {
  readonly wave: number
  readonly characterId: CharacterId
  readonly stimulusHash: WorldHash
  readonly jobId: string
  readonly estimatedTokens: number
  /**
   * What the character was to the action that reached them, under responsive/v2. Absent under v1, and
   * absent is what keeps v1's reservation order - and therefore its budget hash - exactly as it was.
   */
  readonly roleClass?: ReactionRoleClass
}

/**
 * The frozen class order. The planner owns the whole ordering, so it owns the rank too: a caller
 * supplies what the observer was, not a number that could drift from the class it stands for.
 */
const ROLE_CLASS_RANK: { readonly [key in ReactionRoleClass]: number } = { direct: 0, addressee: 1, witness: 2, self: 3 }

export interface StableCallBudgetUsage extends WorldJsonObject {
  readonly characterId: CharacterId
  readonly calls: number
}

export interface StableCallBudgetLimits extends WorldJsonObject {
  readonly remainingCalls: number
  readonly remainingTokens: number
  readonly maxCallsPerCharacter: number
  readonly usedCallsByCharacter: readonly StableCallBudgetUsage[]
}

export type StableCallBudgetExclusion = 'character_limit' | 'call_limit' | 'token_budget_exhausted'

export interface StableCallBudgetDecision extends WorldJsonObject {
  readonly candidate: StableCallBudgetCandidate
  readonly status: 'reserved' | 'skipped'
  readonly exclusion: StableCallBudgetExclusion | null
  readonly reservationOrdinal: number | null
}

export interface StableCallBudgetPlan extends WorldJsonObject {
  readonly limits: StableCallBudgetLimits
  readonly decisions: readonly StableCallBudgetDecision[]
  readonly reservedJobIds: readonly string[]
  readonly reservedCalls: number
  readonly reservedTokens: number
  readonly planHash: WorldHash
}

function nonNegative(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative safe integer`)
  return value
}

function positive(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive safe integer`)
  return value
}

function worldHash(value: string, name: string): WorldHash {
  if (!/^sha256:[0-9a-f]{64}$/u.test(value)) throw new TypeError(`${name} must be a lowercase SHA-256 WorldHash`)
  return value as WorldHash
}

function normalizeCandidate(candidate: StableCallBudgetCandidate): StableCallBudgetCandidate {
  const roleClass = candidate.roleClass
  if (roleClass !== undefined && !Object.hasOwn(ROLE_CLASS_RANK, roleClass)) {
    throw new TypeError('candidate.roleClass is not one of the frozen classes')
  }
  return {
    wave: positive(candidate.wave, 'candidate.wave'),
    characterId: assertProtocolString(candidate.characterId, 'candidate.characterId') as CharacterId,
    stimulusHash: worldHash(candidate.stimulusHash, 'candidate.stimulusHash'),
    jobId: assertProtocolString(candidate.jobId, 'candidate.jobId'),
    estimatedTokens: positive(candidate.estimatedTokens, 'candidate.estimatedTokens'),
    ...(roleClass === undefined ? {} : { roleClass }),
  }
}

/** What an observer was, before who they are. A v1 candidate carries no class and sorts as it did. */
function classRank(candidate: StableCallBudgetCandidate): number {
  return candidate.roleClass === undefined ? 0 : ROLE_CLASS_RANK[candidate.roleClass]
}

function compareCandidate(left: StableCallBudgetCandidate, right: StableCallBudgetCandidate): number {
  return left.wave - right.wave
    || classRank(left) - classRank(right)
    || compareWorldText(left.characterId, right.characterId)
    || compareWorldText(left.stimulusHash, right.stimulusHash)
    || compareWorldText(left.jobId, right.jobId)
}

/** Freeze one deterministic reservation set before any Provider dispatch. */
export function planStableCallBudget(
  candidates: readonly StableCallBudgetCandidate[],
  inputLimits: StableCallBudgetLimits,
): StableCallBudgetPlan {
  const limits: StableCallBudgetLimits = {
    remainingCalls: nonNegative(inputLimits.remainingCalls, 'limits.remainingCalls'),
    remainingTokens: nonNegative(inputLimits.remainingTokens, 'limits.remainingTokens'),
    maxCallsPerCharacter: positive(inputLimits.maxCallsPerCharacter, 'limits.maxCallsPerCharacter'),
    usedCallsByCharacter: inputLimits.usedCallsByCharacter.map(value => ({
      characterId: assertProtocolString(value.characterId, 'usage.characterId') as CharacterId,
      calls: nonNegative(value.calls, 'usage.calls'),
    })).sort((left, right) => compareWorldText(left.characterId, right.characterId)),
  }
  const usedCalls = new Map<CharacterId, number>()
  for (const usage of limits.usedCallsByCharacter) {
    if (usedCalls.has(usage.characterId)) throw new TypeError('usedCallsByCharacter contains duplicate characterId values')
    if (usage.calls > limits.maxCallsPerCharacter) throw new RangeError('usage.calls exceeds maxCallsPerCharacter')
    usedCalls.set(usage.characterId, usage.calls)
  }
  const ordered = candidates.map(normalizeCandidate).sort(compareCandidate)
  const jobIds = new Set<string>()
  const waveCharacters = new Set<string>()
  for (const candidate of ordered) {
    if (jobIds.has(candidate.jobId)) throw new TypeError('budget candidates contain duplicate jobId values')
    jobIds.add(candidate.jobId)
    const waveCharacter = `${candidate.wave}\u001f${candidate.characterId}`
    if (waveCharacters.has(waveCharacter)) throw new TypeError('budget candidates contain multiple Jobs for one character and wave')
    waveCharacters.add(waveCharacter)
  }
  let remainingCalls = limits.remainingCalls
  let remainingTokens = limits.remainingTokens
  let reservedTokens = 0
  const decisions: StableCallBudgetDecision[] = []
  const reservedJobIds: string[] = []
  for (const candidate of ordered) {
    const characterCalls = usedCalls.get(candidate.characterId) ?? 0
    let exclusion: StableCallBudgetExclusion | null = null
    if (characterCalls >= limits.maxCallsPerCharacter) exclusion = 'character_limit'
    else if (remainingCalls === 0) exclusion = 'call_limit'
    else if (candidate.estimatedTokens > remainingTokens) exclusion = 'token_budget_exhausted'
    if (exclusion !== null) {
      decisions.push({ candidate, status: 'skipped', exclusion, reservationOrdinal: null })
      continue
    }
    const reservationOrdinal = reservedJobIds.length
    reservedJobIds.push(candidate.jobId)
    decisions.push({ candidate, status: 'reserved', exclusion: null, reservationOrdinal })
    usedCalls.set(candidate.characterId, characterCalls + 1)
    remainingCalls -= 1
    remainingTokens -= candidate.estimatedTokens
    reservedTokens += candidate.estimatedTokens
  }
  const planInput = {
    limits,
    decisions,
    reservedJobIds,
    reservedCalls: reservedJobIds.length,
    reservedTokens,
  }
  return { ...planInput, planHash: hashWorldJson('stable-call-budget-plan/v1', planInput) }
}
