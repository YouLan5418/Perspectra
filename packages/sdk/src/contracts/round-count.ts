/** The committed facts round counting reads. */
export interface RoundCountEvent {
  readonly seq: number
  readonly transactionId: string
  readonly eventType: string
  readonly data: unknown
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('回合记录损坏')
  return value as Record<string, unknown>
}
function roundSource(event: RoundCountEvent): Record<string, unknown> | undefined {
  if (event.eventType !== 'status.updated') return undefined
  const data = record(event.data)
  if (!Array.isArray(data.changes) || !Array.isArray(data.reveals)) throw new TypeError('状态事件损坏')
  const source = record(data.source)
  return source.kind === 'round' ? source : undefined
}

/** Which round the player has reached, from committed events. Multiple player actions in one transaction are one
 * input; NPC actions and hook commits do not count, and a round whose hook returned nothing or failed still does. */
export function playerRoundNumber(
  events: readonly RoundCountEvent[],
  turnStartSeq: number,
  pause: boolean,
): { readonly round: number; readonly turnCommits: number } {
  // Counting starts from the latest recorded round, so a turn of several commits counted there stays one.
  const base = events.findLast(event => roundSource(event) !== undefined)
  const since = base === undefined ? 0 : base.seq
  const recorded = base === undefined ? 0 : (roundSource(base)!.round as number)
  const player = events.filter(
    e => e.seq > since && e.eventType === 'action.resolved' && record(e.data).sourceRole === 'player',
  )
  const playerRounds = new Set(player.filter(e => e.seq <= turnStartSeq).map(e => e.transactionId))
  // This turn is one round however many commits it took, such as a line said with an action.
  const thisTurn = new Set(player.filter(e => e.seq > turnStartSeq).map(e => e.transactionId))
  // A quick activity action starts and executes in two host commits for one player request.
  const starts = new Map<string, RoundCountEvent>()
  for (const event of events) {
    if (event.seq <= since || event.eventType !== 'activity.updated') continue
    const data = record(event.data)
    if (typeof data.requestId !== 'string') continue
    if (data.operation === 'start') starts.set(data.requestId, event)
    else {
      const start = starts.get(data.requestId + ':start')
      if (start && record(record(start.data).state).id === record(data.state).id) {
        playerRounds.delete(start.transactionId)
        thisTurn.delete(start.transactionId)
      }
    }
  }
  return {
    round: recorded + playerRounds.size + (pause ? 1 : Math.min(thisTurn.size, 1)),
    turnCommits: thisTurn.size,
  }
}
