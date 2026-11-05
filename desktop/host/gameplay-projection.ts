import type { RulebookEvent } from '@harness-world/kernel'
import type { CrossSceneCommunication } from './pack-communication.ts'
import type { StatusRuntime } from './status-runtime.ts'

/** What the player sees of the pack's status: operations under the same rules as an NPC, the bar and the drawer. */
export function projectStatus<A>(
  status: StatusRuntime,
  availableActions: A,
  events: readonly RulebookEvent[],
  playerId: string,
  names: ReadonlyMap<string, string>,
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
      .map(entry => (pinned.has(entry.key) ? { ...entry, pinned: true as const } : entry)),
    // Author opt-in only: these never enter any character's context.
    statusTruth: status.playerTruth(events as never).map(named),
  }
}

/** The player writes the text in the form; the label names the contact, who may be anywhere. */
export function withMessageActions<A extends readonly unknown[]>(
  communication: CrossSceneCommunication,
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
