import { brandId, type StatusTruth, type WorldAddress, type WorldJsonObject } from '@harness-world/contracts'
import {
  currentLocation,
  currentEntityState,
  currentCharacterLifecycle,
  type CompiledWorldManifest,
  type RulebookEvent,
} from '@harness-world/kernel'
import { activityProgress } from './activity-state.ts'
import { itemIsReachable } from './item-effects.ts'
import { characterVisibleItems } from './character-visible-items.ts'
import { SceneDecisionService } from './scene-decision.ts'
import { WorldStore, CharacterRuntimeAvailabilityService } from '@harness-world/store-sqlite'

/** Anything that can fold status truth from a prefix. */
export interface StatusTruthReader {
  truth(events: readonly RulebookEvent[]): StatusTruth
}

/** Status policy sees only the actor's own or grounded reachable items, never another holder's inventory. */
export function statusPlaceView(
  events: readonly RulebookEvent[],
  actorId: string,
  entityIds: readonly string[],
): WorldJsonObject {
  return {
    locationId: currentLocation(events, actorId) ?? null,
    items: entityIds.flatMap(id => {
      const item = currentEntityState(events, id)
      return item !== undefined && itemIsReachable(events, actorId, id, [])
        ? [{ entityId: id, kind: item.kind, holderId: item.holderId, locationId: item.locationId }]
        : []
    }),
  }
}

/** Short-lived scene readers for one authorized projection; never held across asynchronous work. */
export function withSceneDecisions<T>(worldPath: string, work: (scene: SceneDecisionService) => T): T {
  const store = new WorldStore(worldPath),
    availability = new CharacterRuntimeAvailabilityService(worldPath)
  try {
    return work(new SceneDecisionService(store, availability))
  } finally {
    availability.close()
    store.close()
  }
}

/** Actor-scoped facts from the same candidate prefix; never a global inventory.
 * Shared by activity and status script hooks as their `world` argument. */
export function actorWorldView(
  worldPath: string,
  address: WorldAddress,
  manifest: CompiledWorldManifest,
  events: readonly RulebookEvent[],
  actorId: string,
  asOfWorldSeq: number | undefined,
): WorldJsonObject {
  if (asOfWorldSeq === undefined) throw new TypeError('活动世界视图缺少提交前缀')
  const actor = brandId(actorId, 'CharacterId')
  const scene = withSceneDecisions(worldPath, service => service.decideFromEvents(address, actor, events, asOfWorldSeq))
  return {
    locationId: currentLocation(events, actorId) ?? null,
    arrivedAtSeq: arrivedAtSeq(events, actorId),
    characterIds: [...scene.observerIds],
    items: characterVisibleItems(manifest, events, actor, scene.observerIds),
  }
}

/** Core physical input for trusted gameplay computation. Contains no cognition or private status values. */
export function gameplayWorldView(
  worldPath: string,
  address: WorldAddress,
  manifest: CompiledWorldManifest,
  events: readonly RulebookEvent[],
  actorId: string,
): WorldJsonObject {
  const head = events.reduce((max, event) => Math.max(max, Number((event as { seq?: number }).seq ?? 0)), 0)
  const world = actorWorldView(worldPath, address, manifest, events, actorId, head)
  const state = [...activityProgress(events).values()].find(
    value => value.game.active && value.participants.includes(actorId),
  )
  const present = world.characterIds as string[]
  return {
    ...world,
    characters: Object.fromEntries(
      manifest.characters.map(row => [
        row.characterId,
        {
          locationId: currentLocation(events, row.characterId) ?? null,
          lifecycle: currentCharacterLifecycle(events, row.characterId) ?? 'active',
        },
      ]),
    ),
    participantHeldItems: manifest.entities.flatMap(({ entityId }) => {
      const holderId = currentEntityState(events, entityId)?.holderId
      return holderId && state?.participants.includes(holderId) && (holderId === actorId || present.includes(holderId))
        ? [{ entityId, holderId }]
        : []
    }),
  }
}

/** Where in history the actor last moved: lets a hook tell a fresh arrival from staying put. 0 if she never moved.
 * Committed events carry their seq; an uncommitted draft counts by its position in the prefix. */
function arrivedAtSeq(events: readonly RulebookEvent[], actorId: string): number {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!
    const data = event.data as { characterId?: unknown } | null
    if (event.eventType === 'character.moved' && data?.characterId === actorId) {
      const seq = (event as { seq?: unknown }).seq
      return typeof seq === 'number' ? seq : i + 1
    }
  }
  return 0
}

/** One committed prefix read once and shared by every activity in a single views() or autoStart() pass.
 * Actor views and status truth are computed on first use, so activities that need neither pay nothing. */
export interface ActivityWorld {
  readonly headSeq: number
  readonly events: readonly RulebookEvent[]
  readonly manifest: CompiledWorldManifest
  worldView(actorId: string): WorldJsonObject
  truth(status: StatusTruthReader | undefined): StatusTruth | null
}
export function readActivityWorld(worldPath: string, address: WorldAddress): ActivityWorld {
  const store = new WorldStore(worldPath)
  let headSeq: number, events: readonly RulebookEvent[], manifest: CompiledWorldManifest
  try {
    headSeq = store.head(address).headSeq
    events = store.readEvents(address, headSeq)
    manifest = store.readManifest(address)!.manifest as CompiledWorldManifest
  } finally {
    store.close()
  }
  return activityWorldFromEvents(worldPath, address, headSeq, events, manifest)
}

/** Share only this presentation pass's committed history; authorized actor views remain separately projected. */
export function activityWorldFromEvents(
  worldPath: string,
  address: WorldAddress,
  headSeq: number,
  events: readonly RulebookEvent[],
  manifest: CompiledWorldManifest,
): ActivityWorld {
  const views = new Map<string, WorldJsonObject>()
  const truths = new Map<StatusTruthReader | undefined, StatusTruth | null>()
  return {
    headSeq,
    events,
    manifest,
    worldView(actorId) {
      if (!views.has(actorId))
        views.set(actorId, actorWorldView(worldPath, address, manifest, events, actorId, headSeq))
      // Script hooks receive their own copy, as with a fresh read.
      return structuredClone(views.get(actorId)!)
    },
    truth(status) {
      if (!truths.has(status)) truths.set(status, status?.truth(events) ?? null)
      return structuredClone(truths.get(status)!)
    },
  }
}
