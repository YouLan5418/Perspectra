import {
  brandId,
  type StoredRoundAuthority,
  type StoredWorldEvent,
  type WorldAddress,
  type WorldEventDraft,
  type WorldHash,
  type WorldJsonObject,
} from '@perspectra/sdk/contracts'
import { runtimeManifestFromStored, type CompiledWorldManifest } from '@perspectra/core/kernel'
import { type WorldStore, type WriterLeaseService } from '@perspectra/core/store'
import { assertPhysicalEffects } from './item-effects.ts'

/** A committed prefix supplied to host adjudication, with no database or write capability. */
export interface WorldRoundSnapshot {
  readonly head: Readonly<ReturnType<WorldStore['head']>>
  readonly manifest: CompiledWorldManifest
  readonly manifestHash: WorldHash
  readonly events: readonly StoredWorldEvent[]
  readonly prior: StoredRoundAuthority | undefined
}
export interface WorldRoundEffects {
  readonly events: readonly WorldEventDraft[]
  readonly authority: WorldJsonObject
  /** Characters besides the bound player these effects may move: the participants an activity result names. */
  readonly allowedMovers?: readonly string[]
}

/** Host-only execution for immediate rounds. Mechanisms return data; this is never a plugin service.
 * Business rules and audience construction remain in the calling host adapter, not in an arbitrary plugin callback.
 * Async preparation holds a fenced lease, but no SQLite transaction; commit rechecks both prefix and fencing. */
export async function executeWorldRound(
  input: {
    readonly store: WorldStore
    readonly leases: WriterLeaseService
    readonly address: WorldAddress
    readonly owner: string
    /** Omitted only for host system work such as the end-of-round hook. */
    readonly actorId?: string | undefined
    readonly signal?: AbortSignal | undefined
    readonly leaseTtlMs?: number
    readonly captureCognition?: boolean
    readonly tickRoundId?: boolean
  },
  adjudicate: (snapshot: WorldRoundSnapshot) => WorldRoundEffects | undefined | Promise<WorldRoundEffects | undefined>,
): Promise<{ readonly afterSeq: number } | undefined> {
  input.signal?.throwIfAborted()
  const { store, leases, address, owner } = input
  const lease = leases.acquire(address, owner, input.leaseTtlMs ?? 180_000)
  try {
    const head = store.head(address),
      record = store.readManifest(address)
    if (!record) throw new Error('world round requires an active manifest')
    const manifest = runtimeManifestFromStored(record.manifest)
    if (input.actorId !== undefined && !manifest.playerBindings.some(row => row.characterId === input.actorId))
      throw new TypeError('immediate player round requires a bound player')
    const snapshot: WorldRoundSnapshot = {
      head,
      manifest,
      manifestHash: record.manifestHash,
      events: store.readEvents(address, head.headSeq),
      prior: store.readRoundAuthority(address, brandId(owner, 'TransactionId')),
    }
    const effects = await adjudicate(snapshot)
    input.signal?.throwIfAborted()
    if (effects === undefined) return undefined
    validateWorldRoundEffects(snapshot, effects, input.actorId)
    const roundId = brandId(owner, 'InteractionRoundId')
    await store.commitRound({
      address,
      transactionId: brandId(owner, 'TransactionId'),
      roundId,
      expectedHeadSeq: head.headSeq,
      expectedTick: head.tick,
      nextTick: head.tick + 1,
      events: [
        ...effects.events,
        {
          eventType: 'world.tick-advanced',
          eventVersion: 1,
          data: { tick: head.tick + 1, ...(input.tickRoundId ? { roundId } : {}) },
        },
      ],
      outbox: [],
      ...(input.captureCognition
        ? {
            cognitiveJobs: [
              ...new Set(
                effects.events
                  .filter(event => event.eventType === 'observation.upsert')
                  .map(event => String(((event.data as WorldJsonObject).value as WorldJsonObject).observerId)),
              ),
            ].map(characterId => ({ characterId: brandId(characterId, 'CharacterId') })),
          }
        : {}),
      writerFencingToken: lease.fencingToken,
      correlationId: owner,
      authority: effects.authority,
    })
    return { afterSeq: head.headSeq }
  } finally {
    leases.release(address, owner, lease.fencingToken)
  }
}

/** Validates pure adjudication data before the commit boundary. */
export function validateWorldRoundEffects(
  snapshot: WorldRoundSnapshot,
  effects: WorldRoundEffects,
  actorId?: string,
): void {
  if (actorId !== undefined && effects.authority.actorId !== actorId)
    throw new TypeError('round authority actor does not match its bound player')
  if (
    !Array.isArray(effects.events) ||
    !effects.authority ||
    typeof effects.authority !== 'object' ||
    Array.isArray(effects.authority)
  )
    throw new TypeError('round effects require events and an authority object')
  const allowed = new Set(snapshot.manifest.registries.events.definitions.map(row => `${row.name}@${row.version}`))
  for (const event of effects.events)
    if (!allowed.has(`${event.eventType}@${event.eventVersion}`))
      throw new TypeError('event is not declared by the world')
  const characters = new Set(snapshot.manifest.characters.map(row => String(row.characterId)))
  assertPhysicalEffects({
    manifest: snapshot.manifest,
    events: snapshot.events,
    drafts: effects.events,
    actorId: actorId,
    allowedMovers: effects.allowedMovers,
  })
  for (const event of effects.events) {
    if (event.eventType === 'world.tick-advanced') throw new TypeError('round tick is owned by the core')
    if (
      event.eventType === 'action.resolved' &&
      actorId !== undefined &&
      (event.data as WorldJsonObject).actorId !== actorId
    )
      throw new TypeError('resolved action actor does not match its bound player')
    if (event.eventType === 'observation.upsert') {
      const observer = ((event.data as WorldJsonObject).value as WorldJsonObject | undefined)?.observerId
      if (typeof observer !== 'string' || !characters.has(observer))
        throw new TypeError('observation recipient is not a declared character')
    }
  }
}
