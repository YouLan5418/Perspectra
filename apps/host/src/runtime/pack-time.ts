import type { PackTimeThreshold } from '@perspectra/sdk'
import type { StoredWorldEvent, StatusEventData } from '@perspectra/sdk/contracts'

/** Replay only the public clock on this effective branch. Each comparison spans a whole committed
 * transaction, including when day and slot were changed in separate drafts. */
export function firstPackTimeCrossing(
  events: readonly StoredWorldEvent[],
  clock: PackTimeThreshold,
  invalid: () => void,
): readonly StoredWorldEvent[] | undefined {
  const target = clock.slots.indexOf(clock.at.slot)
  let day: unknown, slot: unknown, previous: boolean | undefined
  for (let start = 0; start < events.length; ) {
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
    if (touched) {
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
