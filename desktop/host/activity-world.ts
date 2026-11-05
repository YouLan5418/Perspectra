import { brandId, type WorldAddress, type WorldJsonObject } from '@harness-world/contracts'
import { currentLocation, type CompiledWorldManifest, type RulebookEvent } from '@harness-world/kernel'
import { SceneDecisionService, characterVisibleItems } from '@harness-world/application'
import { WorldStore, CharacterRuntimeAvailabilityService } from '@harness-world/store-sqlite'
import type { StatusRuntime } from './status-runtime.ts'
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
  const store = new WorldStore(worldPath),
    availability = new CharacterRuntimeAvailabilityService(worldPath)
  try {
    const actor = brandId(actorId, 'CharacterId')
    const scene = new SceneDecisionService(store, availability).decideFromEvents(address, actor, events, asOfWorldSeq)
    return {
      locationId: currentLocation(events, actorId) ?? null,
      characterIds: [...scene.observerIds],
      items: characterVisibleItems(manifest, events, actor, scene.observerIds),
    }
  } finally {
    availability.close()
    store.close()
  }
}

/** One committed prefix read once and shared by every activity in a single views() or autoStart() pass.
 * Actor views and status truth are computed on first use, so activities that need neither pay nothing. */
export interface ActivityWorld {
  readonly headSeq: number
  readonly events: readonly RulebookEvent[]
  readonly manifest: CompiledWorldManifest
  worldView(actorId: string): WorldJsonObject
  truth(status: StatusRuntime | undefined): import('@harness-world/contracts').StatusTruth | null
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
  const truths = new Map<StatusRuntime | undefined, import('@harness-world/contracts').StatusTruth | null>()
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
