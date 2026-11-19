import { firstPackTimeCrossing } from './pack-time.ts'
import { randomUUID } from 'node:crypto'
import type { WorldRoundEffects, WorldRoundSnapshot } from '@perspectra/core'
import {
  currentCharacterLifecycle,
  currentEntityState,
  currentSceneDecisionStates,
  sceneObserverIds,
} from '@perspectra/core/kernel'
import { WorldStore } from '@perspectra/core/store'
import type { BooleanWrite, EventBook, EventGrant, EventRule, WorldEventEnvelope } from '@perspectra/sdk'
import {
  playerRoundNumber,
  type WorldAddress,
  type WorldEventDraft,
  type WorldJsonObject,
  type StatusEventData,
} from '@perspectra/sdk/contracts'
import type { WorldEventConsumer } from '../world-event-registry.ts'
import type { StatusRuntime } from './status-runtime.ts'

const source = 'host.world-events/v1'
interface IndexedOccurrence extends Occurrence {
  seq: number
}
interface Occurrence extends WorldEventEnvelope, WorldJsonObject {
  ruleId: string
  cycle: string
  pacedRound?: number
  grants: string[]
}
const grantId = (g: EventGrant) =>
  JSON.stringify([g.plugin, g.type, g.mode, g.effect?.key ?? null, g.effect?.value ?? null])
const receiptId = (g: EventGrant, event: Occurrence) => JSON.stringify([g.plugin, g.mode, event.occurrenceId])
function localWitnesses(snapshot: WorldRoundSnapshot, location: string) {
  const scenes = currentSceneDecisionStates(snapshot.events).filter(
    scene => scene.lifecycle === 'active' && scene.locationId === location,
  )
  // A physical place alone does not authorize a union of separate private scenes.
  return new Set(scenes.length === 1 ? sceneObserverIds(snapshot.events, scenes[0]!) : [])
}
function witnesses(rule: EventRule, snapshot: WorldRoundSnapshot): string[] {
  const { events, manifest } = snapshot
  const sameScene = localWitnesses(snapshot, rule.location)
  return manifest.characters
    .filter(
      ({ characterId }) =>
        currentCharacterLifecycle(events, characterId) === 'active' &&
        rule.witnesses.some(
          w =>
            w === 'global' ||
            (w === 'scene'
              ? sameScene.has(characterId)
              : currentEntityState(events, w.holds)?.holderId === characterId),
        ),
    )
    .map(c => c.characterId)
}

// Keep the intersection of the action's committed full-content recipients at A and scene visibility at B.
function sourceReaders(rule: EventRule, rows: WorldRoundSnapshot['events'], operation: string): Set<string> {
  const clock = rule.crossesPackTime!
  const writers = rows
    .filter(row => row.eventType === 'status.updated')
    .map(row => row.data as unknown as StatusEventData)
    .filter(data => data.changes.some(c => c.holderId === null && (c.key === clock.dayKey || c.key === clock.slotKey)))
  const origin = writers[0]?.source
  if (writers.length !== 1 || origin?.kind !== 'operation' || origin.operation !== operation) return new Set()
  const actions = rows
    .filter(row => row.eventType === 'action.resolved')
    .map(row => row.data as WorldJsonObject)
    .filter(a => a.actorId === origin.actorId && a.actionType === 'interact' && a.accepted === true)
  const actionId = actions[0]?.actionId
  if (actions.length !== 1 || typeof actionId !== 'string') return new Set()
  const readers = new Set<string>()
  for (const row of rows) {
    if (row.eventType !== 'observation.upsert') continue
    const value = (row.data as WorldJsonObject).value as WorldJsonObject
    const content = value.content as WorldJsonObject | undefined
    if (
      value.actionId === actionId &&
      typeof value.observerId === 'string' &&
      content?.actorId === origin.actorId &&
      content.actionType === 'interact' &&
      content.status === 'accepted' &&
      content.contentVisibility !== 'occurrence_only'
    )
      readers.add(value.observerId)
  }
  return readers
}
function notices(rule: EventRule, snapshot: WorldRoundSnapshot, crossing?: WorldRoundSnapshot['events']) {
  const result = new Map(witnesses(rule, snapshot).map(id => [id, rule.observation]))
  for (const group of rule.sceneNotices ?? []) {
    const allowed = group.fromOperation ? sourceReaders(rule, crossing ?? [], group.fromOperation) : undefined
    for (const location of group.locations)
      for (const id of localWitnesses(snapshot, location))
        if (!result.has(id) && (!allowed || allowed.has(id))) result.set(id, group.text)
  }
  return result
}

/** One mounted branch. The local index can be rebuilt entirely from its effective committed prefix. */
export class WorldEventRuntime {
  private readonly occurrences = new Map<string, IndexedOccurrence>()
  private readonly receipts = new Set<string>()
  private readonly handlers = new Map<WorldEventConsumer, ReturnType<WorldEventConsumer['subscription']['open']>>()
  private readonly lifetime = new AbortController()
  private readonly warnedClocks = new Set<string>()
  private indexed = 0
  private active = false
  private liveThrough = 0
  constructor(
    private readonly store: WorldStore,
    private readonly address: WorldAddress,
    private readonly packId: string,
    private readonly book: EventBook,
    private readonly consumers: readonly WorldEventConsumer[],
    private readonly status: StatusRuntime | undefined,
    forbiddenKeys: ReadonlySet<string>,
  ) {
    for (const { crossesPackTime: clock, sceneNotices } of book.rules) {
      for (const group of sceneNotices ?? []) {
        if (group.fromOperation && !status?.operations.some(op => op.id === group.fromOperation))
          throw new TypeError('world-events: unknown notice source operation: ' + group.fromOperation)
      }
      if (!clock) continue
      for (const [key, type] of [
        [clock.dayKey, 'number'],
        [clock.slotKey, 'string'],
      ] as const) {
        const def = status?.statuses.find(row => row.key === key)
        if (!def || def.type !== type || def.owner !== 'public' || def.activities || forbiddenKeys.has(key))
          throw new TypeError('world-events: expected pack-owned public calendar ' + type + ': ' + key)
      }
    }
    for (const write of [...book.rules.map(r => r.set), ...book.grants.flatMap(g => (g.effect ? [g.effect] : []))]) {
      const definition = status?.statuses.find(s => s.key === write.key)
      if (
        !definition ||
        definition.owner !== 'public' ||
        definition.type !== 'boolean' ||
        definition.activities ||
        forbiddenKeys.has(write.key)
      )
        throw new TypeError('world-events: expected pack-owned public boolean state: ' + write.key)
    }
  }
  select(): void {
    if (this.active) return
    this.liveThrough = this.store.head(this.address).headSeq
    this.index(this.liveThrough)
    this.active = true
  }
  close(): void {
    this.active = false
    this.lifetime.abort()
    this.handlers.clear()
    this.store.close()
  }
  private index(through: number): void {
    if (through === this.indexed) return
    if (through < this.indexed) throw new Error('world event instance requires remount after rewind')
    for (const event of this.store.readEventsRange(this.address, this.indexed, through, ['world.tick-advanced'])) {
      const row = this.store.readRoundAuthority(this.address, event.transactionId)?.authority
      if (row?.source !== source || row.packId !== this.packId) continue
      for (const raw of (row.occurrences ?? []) as Occurrence[]) {
        this.occurrences.set(raw.ruleId, { ...raw, seq: event.seq })
      }
      for (const id of (row.receipts ?? []) as string[]) this.receipts.add(id)
    }
    this.indexed = through
  }
  private invoke(consumer: WorldEventConsumer, event: Occurrence): unknown {
    consumer.signal.throwIfAborted()
    this.lifetime.signal.throwIfAborted()
    let handler = this.handlers.get(consumer)
    if (!handler) {
      const signal = AbortSignal.any([this.lifetime.signal, consumer.signal])
      handler = consumer.subscription.open({ signal })
      signal.throwIfAborted()
      this.handlers.set(consumer, handler)
      signal.addEventListener('abort', () => this.handlers.delete(consumer), { once: true })
    }
    return handler(Object.freeze({ type: event.type, occurrenceId: event.occurrenceId }))
  }
  private subscribers(event: Occurrence, mode: EventGrant['mode']) {
    return this.book.grants
      .filter(g => g.type === event.type && g.mode === mode && event.grants.includes(grantId(g)))
      .flatMap(grant =>
        this.consumers
          .filter(
            c =>
              c.active() &&
              c.plugin === grant.plugin &&
              c.subscription.type === event.type &&
              c.subscription.mode === mode,
          )
          .map(consumer => ({ grant, consumer })),
      )
  }
  /** Advance before callbacks. A live callback failure never changes a committed result or causes replay. */
  flushLive(): void {
    if (!this.active) return
    const start = this.liveThrough,
      end = this.store.head(this.address).headSeq
    this.index(end)
    this.liveThrough = end
    for (const event of this.occurrences.values()) {
      if (event.seq <= start) continue
      for (const { consumer } of this.subscribers(event, 'live')) {
        try {
          void Promise.resolve(this.invoke(consumer, event)).catch(() =>
            console.warn('[worldEvents] live handler failed'),
          )
        } catch {
          console.warn('[worldEvents] live handler failed')
        }
      }
    }
  }
  private statusEvent(snapshot: WorldRoundSnapshot, cycle: string, write: BooleanWrite): WorldEventDraft {
    const data: StatusEventData = {
      source: { kind: 'cycle', cycleId: cycle },
      changes: [{ holderId: null, key: write.key, value: write.value }],
      reveals: [],
    }
    this.status!.validate(snapshot.events, data, [])
    return { eventType: 'status.updated', eventVersion: 1, data: data as unknown as WorldJsonObject }
  }
  private eligible(snapshot: WorldRoundSnapshot, round: number): EventRule[] {
    this.index(snapshot.head.headSeq)
    return this.book.rules.filter(
      rule => rule.round !== undefined && round >= rule.round && !this.occurrences.has(rule.id),
    )
  }
  private eligiblePaced(snapshot: WorldRoundSnapshot, round: number, busy: boolean) {
    return this.eligible(snapshot, round).filter(rule => rule.trigger === 'paced' && (!busy || rule.duringActivity))
  }
  pacedRuleIds(snapshot: WorldRoundSnapshot, round: number, busy: boolean) {
    return this.eligiblePaced(snapshot, round, busy).map(rule => rule.id)
  }
  pacedHistory(through: number) {
    this.index(through)
    return [...this.occurrences.values()].flatMap(event =>
      event.pacedRound === undefined ? [] : [{ key: event.ruleId, round: event.pacedRound, seq: event.seq }],
    )
  }
  private occurrenceEffects(
    snapshot: WorldRoundSnapshot,
    cycle: string,
    rules: EventRule[],
    pacedRound?: number,
    crossings?: ReadonlyMap<string, WorldRoundSnapshot['events']>,
  ) {
    const events: WorldEventDraft[] = [],
      occurrences: Occurrence[] = []
    for (const rule of rules) {
      const occurrenceId = randomUUID()
      events.push(
        this.statusEvent(snapshot, cycle, rule.set),
        // A world occurrence is nobody's accepted action. A personal observation remains readable
        // without nominating its observer for a turn in the normal action-reaction scheduler.
        ...[...notices(rule, snapshot, crossings?.get(rule.id))].map(
          ([observerId, text]): WorldEventDraft => ({
            eventType: 'observation.upsert',
            eventVersion: 1,
            data: {
              id: occurrenceId + ':witness:' + observerId,
              value: { observerId, content: { eventNotice: text } },
            },
          }),
        ),
      )
      occurrences.push({
        ruleId: rule.id,
        type: rule.type,
        occurrenceId,
        cycle,
        ...(crossings?.has(rule.id) ? { clockTransaction: crossings.get(rule.id)![0]!.transactionId } : {}),
        ...(pacedRound === undefined ? {} : { pacedRound }),
        grants: this.book.grants.filter(g => g.type === rule.type).map(grantId),
      })
    }
    return { events, occurrences }
  }
  private effects(events: WorldEventDraft[], occurrences: Occurrence[], receipts: string[]): WorldRoundEffects {
    return { events, authority: { source, packId: this.packId, occurrences, receipts } }
  }
  settlePaced(
    snapshot: WorldRoundSnapshot,
    cycle: string,
    start: number,
    ruleId: string,
    busy: boolean,
  ): WorldRoundEffects {
    const { round } = playerRoundNumber(snapshot.events, start, false)
    const rule = this.eligiblePaced(snapshot, round, busy).find(rule => rule.id === ruleId)
    if (!rule) throw new TypeError('节奏选择了条件未满足的世界事件')
    const { events, occurrences } = this.occurrenceEffects(snapshot, cycle, [rule], round)
    return this.effects(events, occurrences, [])
  }
  settle(
    snapshot: WorldRoundSnapshot,
    cycle: string,
    start: number,
    retryClockOnly = false,
  ): WorldRoundEffects | undefined {
    this.index(snapshot.head.headSeq)
    const { round } = playerRoundNumber(snapshot.events, start, false)
    const crossings = new Map<string, WorldRoundSnapshot['events']>()
    const hard = this.book.rules.filter(rule => {
      if (rule.trigger === 'paced' || this.occurrences.has(rule.id)) return false
      if (!rule.crossesPackTime) return !retryClockOnly && round >= rule.round
      const crossing = firstPackTimeCrossing(snapshot.events, rule.crossesPackTime, () => {
        if (!this.warnedClocks.has(rule.id)) console.warn('[worldEvents] invalid calendar day or slot for ' + rule.id)
        this.warnedClocks.add(rule.id)
      })
      if (!crossing || (retryClockOnly && crossing.at(-1)!.seq <= start)) return false
      crossings.set(rule.id, crossing)
      return true
    })
    const { events, occurrences } = this.occurrenceEffects(snapshot, cycle, hard, undefined, crossings)
    const receipts: string[] = []
    if (this.active && !retryClockOnly)
      for (const event of this.occurrences.values()) {
        if (event.cycle === cycle) continue
        for (const { consumer, grant } of this.subscribers(event, 'durable')) {
          const id = receiptId(grant, event)
          if (this.receipts.has(id)) continue
          try {
            const result = this.invoke(consumer, event)
            if (result === 'apply' && grant.effect) events.push(this.statusEvent(snapshot, cycle, grant.effect))
            else if (result !== 'ack') {
              void Promise.resolve(result).catch(() => {})
              throw new TypeError('unapproved world event effect')
            }
            receipts.push(id)
          } catch {
            console.warn('[worldEvents] durable handler deferred')
          }
        }
      }
    if (!occurrences.length && !receipts.length) return undefined
    return this.effects(events, occurrences, receipts)
  }
}
