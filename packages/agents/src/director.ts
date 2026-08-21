export interface DirectorCandidate {
  readonly participantId: string
  readonly priority: number
  readonly enabled: boolean
  readonly authorizedActionTypes: readonly string[]
}

/** Pure deterministic scheduler; Provider selection and invocation remain replaceable. */
export class DirectorScheduler {
  schedule(candidates: readonly DirectorCandidate[], maxParticipants: number): DirectorCandidate[] {
    if (!Number.isSafeInteger(maxParticipants) || maxParticipants < 0) throw new RangeError('maxParticipants must be a non-negative safe integer')
    const ids = candidates.map(candidate => candidate.participantId)
    if (new Set(ids).size !== ids.length) throw new TypeError('Director participantId values must be unique')
    return candidates
      .filter(candidate => candidate.enabled && candidate.authorizedActionTypes.length > 0)
      .sort((left, right) => right.priority - left.priority || left.participantId.localeCompare(right.participantId))
      .slice(0, maxParticipants)
  }
}
