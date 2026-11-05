import { playerRoundNumber, type RoundCountEvent } from '@harness-world/contracts'
import type { PacingHistory } from '@harness-world/plugin-sdk'

const record = (value: unknown) => (value ?? {}) as Record<string, unknown>

/** What pacing may know of the past, from committed events only: a branch or a replay reads the same history. */
export function pacingHistory(
  events: readonly RoundCountEvent[],
  turnStartSeq: number,
  scope: {
    readonly managedActivities: readonly string[]
    readonly progress: { readonly statuses: readonly string[]; readonly activities: readonly string[] }
  },
): PacingHistory {
  const roundAt = (seq: number) =>
    playerRoundNumber(
      events.filter(event => event.seq <= seq),
      seq,
      false,
    ).round
  const fired: { kind: 'activity' | 'beat'; key: string; round: number }[] = []
  let lastProgressSeq: number | undefined
  for (const event of events) {
    const data = record(event.data)
    if (event.eventType === 'activity.updated') {
      const key = String(data.activityKey ?? 'default')
      if (data.operation === 'start' && scope.managedActivities.includes(key))
        fired.push({ kind: 'activity', key, round: roundAt(event.seq) })
      if (scope.progress.activities.includes(key) && record(record(data.state).game).active === false)
        lastProgressSeq = event.seq
    } else if (event.eventType === 'status.updated') {
      const source = record(data.source)
      if (source.kind === 'beat') fired.push({ kind: 'beat', key: String(source.beatId), round: roundAt(event.seq) })
      if (
        source.kind !== 'initial' &&
        (data.changes as readonly { key: string }[]).some(change => scope.progress.statuses.includes(change.key))
      )
        lastProgressSeq = event.seq
    }
  }
  return {
    round: playerRoundNumber(events, turnStartSeq, false).round,
    fired,
    lastProgressRound: lastProgressSeq === undefined ? 0 : roundAt(lastProgressSeq),
  }
}
