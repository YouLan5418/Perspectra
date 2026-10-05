/** Conflicting inscriptions; neither is a host verdict about the registration office. */
import { brandId, hashWorldJson, type WorldJsonObject, type WorldEventDraft } from '@harness-world/contracts'
import { capabilityWorld, openCapabilityWorld } from './notice-board-fixture.ts'

export const secondBoardId = 'entity:distant-board'
export const secondBoardText = '登记处：一楼105'
export function conflictingBoardWorld() {
  const base = capabilityWorld()
  const manifest = { ...base.manifest, interactionCatalog: { ...base.manifest.interactionCatalog,
    bindings: base.manifest.interactionCatalog.bindings.map(b => b.targetRef.kind === 'entity'
      && b.targetRef.id === secondBoardId ? { ...b, config: { ...b.config, text: secondBoardText } } : b),
  } }
  const manifestHash = hashWorldJson('compiled-world-manifest', manifest)
  const genesisEvents = base.genesisEvents.map(e => e.eventType === 'world.manifest-locked'
    ? { ...e, data: { ...e.data as WorldJsonObject, manifestHash } } : e)
  return { manifest, manifestHash, genesisEvents, genesisHash: hashWorldJson('world-genesis-plan', genesisEvents) }
}
export function openConflictingBoardWorld(directory: string, reopen = false) {
  return openCapabilityWorld(directory, undefined, reopen, conflictingBoardWorld())
}
/** Authored experimental staging, not an NPC action or a verdict on either inscription. */
export async function bringSecondBoard(f: ReturnType<typeof openConflictingBoardWorld>) {
  const owner = 'conflict-staging', lease = f.leases.acquire(f.address, owner, 180000)
  try {
    const head = f.store.head(f.address), roundId = brandId(owner, 'InteractionRoundId')
    const events: WorldEventDraft[] = [
      { eventType: 'entity.upsert', eventVersion: 1,
        data: { entityId: secondBoardId, kind: 'notice-board', locationId: 'location:room' } },
      { eventType: 'world.tick-advanced', eventVersion: 1, data: { tick: head.tick + 1, roundId } },
    ]
    await f.store.commitRound({ address: f.address, expectedHeadSeq: head.headSeq, expectedTick: head.tick,
      nextTick: head.tick + 1, transactionId: brandId(owner + ':commit', 'TransactionId'),
      roundId, correlationId: owner, events, outbox: [], writerFencingToken: lease.fencingToken })
  } finally { f.leases.release(f.address, owner, lease.fencingToken) }
}
