import type { CognitiveMemoryEntry } from '@harness-world/contracts'

/** How many committed Rounds one L1 Summary covers. */
const SUMMARY_ROUNDS_PER_GROUP = 4

/** The sequence that closes one committed Round, together with the Tick it advanced to. */
export interface SummaryRound {
  readonly endSeq: number
  readonly tick: number
}

/** Reduce a captured Memory to one Summary line: the speech marker becomes a plain separator. */
function digestText(text: string): string {
  return text.replace(' said: ', '：')
}

/**
 * The ordinal of the Round a sequence belongs to, as an index into `rounds`.
 *
 * The result is the first boundary at or after the sequence. When the sequence closes no Round — a
 * catch-up that stops mid-Round, or a World whose log carries no Tick event — the ordinal clamps to the
 * last known Round, so those Memories still form a Summary instead of none.
 */
function roundOrdinal(rounds: readonly SummaryRound[], sourceSeq: number): number {
  let low = 0
  let high = rounds.length
  while (low < high) {
    const middle = (low + high) >> 1
    if (rounds[middle]!.endSeq >= sourceSeq) high = middle
    else low = middle + 1
  }
  return Math.min(low, rounds.length - 1)
}

/**
 * Group Memories, which arrive ordered by source sequence, into whole-Round Summaries.
 *
 * A group is a run of entries whose Round ordinals land in the same bucket of `SUMMARY_ROUNDS_PER_GROUP`.
 * A trailing bucket that is not full still becomes a Summary: discarding it is why the newest Memories
 * used to have no Summary at all, and why the Continuity baseline reached further than the Summaries did.
 */
export function groupMemoriesByRounds(
  entries: readonly CognitiveMemoryEntry[],
  rounds: readonly SummaryRound[],
): CognitiveMemoryEntry[][] {
  const groups: CognitiveMemoryEntry[][] = []
  let current: CognitiveMemoryEntry[] = []
  let currentBucket = Number.NaN
  for (const entry of entries) {
    const bucket = Math.floor(roundOrdinal(rounds, entry.sourceRef.sourceSeq) / SUMMARY_ROUNDS_PER_GROUP)
    if (current.length > 0 && bucket !== currentBucket) {
      groups.push(current)
      current = []
    }
    currentBucket = bucket
    current.push(entry)
  }
  if (current.length > 0) groups.push(current)
  return groups
}

/** One line per Round the group covers, in time order, so the reader gets the episode rather than a record dump. */
export function digestExtracts(group: readonly CognitiveMemoryEntry[], rounds: readonly SummaryRound[]): string[] {
  const byRound = new Map<number, string[]>()
  for (const entry of group) {
    const ordinal = roundOrdinal(rounds, entry.sourceRef.sourceSeq)
    byRound.set(ordinal, [...byRound.get(ordinal) ?? [], digestText(entry.text)])
  }
  return [...byRound].map(([ordinal, lines]) => {
    const round = rounds[ordinal]
    return round === undefined ? lines.join(' ｜ ') : `第 ${round.tick} 轮 ｜ ${lines.join(' ｜ ')}`
  })
}
