import type { RulebookEvent } from '@perspectra/core/kernel'
import type { CommunicationRuntime } from './communication-runtime.ts'
import type { StatusRuntime } from './status-runtime.ts'

/**
 * A status value as the player reads it: pack ids (characters, places, items) become their names, a list reads
 * "a、b", a pair of two names reads "a → b", an object reads "key：value", and an empty list or object reads "无".
 * The value itself is unchanged; this is only the text a stage shows.
 */
export function statusValueText(value: unknown, names: ReadonlyMap<string, string>): string {
  if (value === true) return '是'
  if (value === false) return '否'
  if (value === null || value === undefined) return '空'
  if (typeof value === 'string') return names.get(value) ?? value
  if (typeof value === 'number') return String(value)
  if (Array.isArray(value)) {
    if (!value.length) return '无'
    const pair = (item: unknown) =>
      Array.isArray(item) && item.length === 2 && item.every(part => typeof part === 'string')
    return value
      .map(item =>
        pair(item) ? (item as string[]).map(part => names.get(part) ?? part).join(' → ') : statusValueText(item, names),
      )
      .join('、')
  }
  const entries = Object.entries(value as Record<string, unknown>)
  if (!entries.length) return '无'
  return entries.map(([key, item]) => `${names.get(key) ?? key}：${statusValueText(item, names)}`).join('；')
}

/** What the player sees of the pack's status: operations under the same rules as an NPC, the bar and the drawer. */
export function projectStatus<A>(
  status: StatusRuntime,
  availableActions: A,
  events: readonly RulebookEvent[],
  playerId: string,
  names: ReadonlyMap<string, string>,
  /** Names of every pack id a value may hold (characters, places, items), for `valueText`. */
  valueNames: ReadonlyMap<string, string> = names,
) {
  const named = <T extends { holderId: string | null }>(entry: T) =>
    entry.holderId === null
      ? entry
      : {
          ...entry,
          holderName: names.get(entry.holderId) ?? entry.holderId,
          ...(entry.holderId === playerId ? { self: true } : {}),
        }
  // The bar shows what the author pinned; the stage lists the rest in its status drawer.
  const pinned = new Set(status.statuses.filter(s => s.bar).map(s => s.key))
  return {
    // A running activity's policy filter applies to these operations as to any other interaction.
    availableActions: status.withOperations(
      availableActions as never,
      events as never,
      playerId as never,
      playerId as never,
    ) as unknown as A,
    statusBar: status
      .known(events as never, playerId)
      .map(named)
      // The stage reads ids as names; the value itself stays as committed.
      .map(entry => ({ ...entry, valueText: statusValueText(entry.value, valueNames) }))
      .map(entry => (pinned.has(entry.key) ? { ...entry, pinned: true as const } : entry)),
    // Author opt-in only: these never enter any character's context.
    statusTruth: status.playerTruth(events as never).map(named),
  }
}

/** The player writes the text in the form; the label names the contact, who may be anywhere. */
export function withMessageActions<A extends readonly unknown[]>(
  communication: CommunicationRuntime,
  availableActions: A,
  events: readonly RulebookEvent[],
  playerId: string,
  publicationCharacters: number,
  names: ReadonlyMap<string, string>,
): A {
  const messages = communication.options(events as never, playerId as never, publicationCharacters).map(option => ({
    ...option,
    arguments: {},
    label: '给 ' + (names.get(option.targetRef.id) ?? option.targetRef.id) + ' 发' + option.medium,
  }))
  return (messages.length
    ? [...availableActions, { actionType: 'interact', actionVersion: 2, interactions: messages }]
    : availableActions) as unknown as A
}
