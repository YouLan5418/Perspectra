import type { PackTimeThreshold } from '@perspectra/sdk'
import type { StoredWorldEvent, StatusEventData } from '@perspectra/sdk/contracts'

/** Replay only the public clock on this effective branch. Each comparison spans a whole committed
 * transaction, including when day and slot were changed in separate drafts. */
export function firstPackTimeCrossing(
  events: readonly StoredWorldEvent[],
  clock: PackTimeThreshold,
  invalid: () => void,
  activation?: {
    afterWorldSeq: number
    day: number
    slot: string
    complete: (first: StoredWorldEvent, last: StoredWorldEvent) => boolean
  },
): readonly StoredWorldEvent[] | undefined {
  const target = clock.slots.indexOf(clock.at.slot)
  let day: unknown = activation?.day,
    slot: unknown = activation?.slot
  let previous =
    activation &&
    (activation.day > clock.at.day ||
      (activation.day === clock.at.day && clock.slots.indexOf(activation.slot) >= target))
  // WorldRoundSnapshot contains the complete effective prefix starting at seq 1.
  for (let start = activation?.afterWorldSeq ?? 0; start < events.length; ) {
    const tx = events[start]!.transactionId
    let end = start,
      touched = false,
      initial = false
    while (end < events.length && events[end]!.transactionId === tx) {
      const row = events[end++]!
      if (row.eventType !== 'status.updated') continue
      const data = row.data as unknown as StatusEventData
      for (const change of data.changes) {
        if (change.holderId !== null) continue
        if (change.key === clock.dayKey) day = change.value
        else if (change.key === clock.slotKey) slot = change.value
        else continue
        initial ||= data.source.kind === 'initial'
        touched = true
      }
    }
    if (touched && activation && !activation.complete(events[start]!, events[end - 1]!)) {
      // A logical fork can end partway through its parent's transaction.
      day = slot = previous = undefined
      invalid()
    } else if (touched) {
      const index = typeof slot === 'string' ? clock.slots.indexOf(slot) : -1
      if (typeof day !== 'number' || !Number.isSafeInteger(day) || day < 0 || index < 0) {
        invalid()
        previous = undefined
      } else {
        const reached = day > clock.at.day || (day === clock.at.day && index >= target)
        if (!initial && previous === false && reached) return events.slice(start, end)
        previous = reached
      }
    }
    start = end
  }
  if (day === undefined && slot === undefined) invalid()
}
