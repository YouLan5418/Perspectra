import type { WorldEventDraft } from '@harness-world/contracts'
import type { RuleContext, RulesInstance, SeamProvider } from '@harness-world/plugin-sdk'
import type { RpgConfig, RpgExit } from './config.ts'
import { OFFICIAL_RPG_ID, OFFICIAL_RPG_VERSION } from './plugin.ts'
import { PARTY_STATUS, UNLOCKED_STATUS } from './state.ts'

/** The rules layer's own provider id, distinct from the plugin id rpg.json names. */
export const OFFICIAL_RPG_RULES_ID = `${OFFICIAL_RPG_ID}-rules`

export { PARTY_STATUS }
const LOCKED = '这条路现在走不通。'
type Events = RuleContext['events']
type Row = Record<string, unknown>

// Official mechanisms read committed facts from the events their context hands them; these three readers follow
// the trunk's own event shapes for the few facts this layer needs.
const rows = (events: Events) => events.map(e => [e.eventType, (e.data ?? {}) as Row] as const)
export function locationOf(events: Events, characterId: string): string | undefined {
  let at: string | undefined
  for (const [type, data] of rows(events)) {
    if (data.characterId !== characterId) continue
    if ((type === 'character.upsert' || type === 'character.created') && typeof data.locationId === 'string')
      at = data.locationId
    if (type === 'character.moved' && typeof data.toLocationId === 'string') at = data.toLocationId
  }
  return at
}
function canWalk(events: Events, characterId: string): boolean {
  let state = 'active'
  for (const [type, data] of rows(events))
    if (type === 'character.lifecycle-changed' && data.characterId === characterId) state = String(data.lifecycleState)
  return state === 'active'
}

/** A public list status as of this prefix; the rules only read it, the status module writes it. */
function publicList(events: Events, key: string): unknown[] {
  let list: unknown[] = []
  for (const event of events) {
    if (event.eventType !== 'status.updated') continue
    const changes = (event.data as { changes?: { holderId: unknown; key: unknown; value: unknown }[] }).changes ?? []
    for (const change of changes)
      if (change.holderId === null && change.key === key && Array.isArray(change.value)) list = change.value
  }
  return list
}
/** The names listed in `rpg-party` as of this prefix. */
export const partyList = (events: Events): string[] =>
  publicList(events, PARTY_STATUS).filter((id): id is string => typeof id === 'string')
/** The doors someone has unlocked, each `[from, to]`, as of this prefix. */
export const unlockedDoors = (events: Events): [string, string][] =>
  publicList(events, UNLOCKED_STATUS).filter(
    (pair): pair is [string, string] =>
      Array.isArray(pair) && pair.length === 2 && pair.every(part => typeof part === 'string'),
  )

/** In the party: listed in `rpg-party` and at the leader's location. Someone listed but elsewhere does not count. */
export function partyMembers(events: Events, leaderId: string): string[] {
  const here = locationOf(events, leaderId)
  return here === undefined ? [] : partyList(events).filter(id => id !== leaderId && locationOf(events, id) === here)
}

/** The exit that governs a move to `to`: the one out of where the mover stands, else any declared exit to it. */
function exitTo(config: RpgConfig, from: string | undefined, to: string): { from: string; exit: RpgExit }[] {
  const all = config.maps.flatMap(map => (map.exits ?? []).map(exit => ({ from: map.locationId, exit })))
  const leading = all.filter(row => row.exit.to === to)
  const local = leading.filter(row => row.from === from)
  return local.length ? local : leading
}

/** A keyed exit opens once someone has unlocked its door, for anyone; holding the key alone does not open it. */
const opens = (row: { from: string; exit: RpgExit }, events: Events) =>
  !row.exit.requires || unlockedDoors(events).some(([from, to]) => from === row.from && to === row.exit.to)

/**
 * Locked exits and party follow, as one rules layer. A move to a locked exit is refused with the author's reason and
 * nothing commits; the destination stays on the list so the player sees the door. Once the leader's move is accepted,
 * every party member standing with her walks along in the same resolution, in the base move rule's shape.
 */
export function createRpgRules(config: RpgConfig): SeamProvider<RulesInstance> {
  const leader = config.party?.leader
  // The vault only stores loot until a victory drops it; nobody walks in, or the drops could be taken before any fight.
  const vault = config.vault
  const instance: RulesInstance = {
    affordances: (context, next) =>
      vault === undefined
        ? next(context)
        : next(context).map(affordance =>
            affordance.actionType === 'move' && affordance.destinations
              ? { ...affordance, destinations: affordance.destinations.filter(d => d.locationId !== vault) }
              : affordance,
          ),
    resolve: (context, next) => {
      const { action, events } = context
      const moverId = String(context.characterId)
      if (action.actionType !== 'move') return next(context)
      const to = (action.parameters as { locationId?: unknown } | null)?.locationId
      if (to === vault) return { status: 'rejected', events: [], reason: 'plugin:' + LOCKED }
      if (typeof to === 'string') {
        const exits = exitTo(config, locationOf(events, moverId), to)
        if (exits.length && !exits.some(row => opens(row, events)))
          return { status: 'rejected', events: [], reason: 'plugin:' + (exits[0]!.exit.lockedReason ?? LOCKED) }
      }
      const result = next(context)
      if (result.status !== 'accepted' || leader === undefined || moverId !== leader) return result
      const moved = result.events.find(
        e => e.eventType === 'character.moved' && (e.data as { characterId?: unknown }).characterId === leader,
      )
      if (!moved) return result
      const { fromLocationId, toLocationId } = moved.data as { fromLocationId: string | null; toLocationId: string }
      const follows: WorldEventDraft[] = partyMembers(events, leader)
        .filter(id => canWalk(events, id))
        .map(characterId => ({
          eventType: 'character.moved',
          eventVersion: 1,
          data: { characterId, fromLocationId, toLocationId },
        }))
      return follows.length ? { ...result, events: [...result.events, ...follows] } : result
    },
  }
  return { id: OFFICIAL_RPG_RULES_ID, version: OFFICIAL_RPG_VERSION, open: async () => instance }
}
