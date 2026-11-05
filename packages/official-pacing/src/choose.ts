import type { PacingCandidate, PacingChoice, PacingHistory } from '@harness-world/plugin-sdk'
import type { PacingDefinition } from './definition.ts'

/** Replaced by the real selection in the next step. */
export function choosePaced(
  _definition: PacingDefinition,
  _input: {
    readonly candidates: readonly PacingCandidate[]
    readonly history: PacingHistory
    readonly random: () => number
  },
): PacingChoice {
  return { kind: 'none', reason: { why: 'no-candidates' } }
}
