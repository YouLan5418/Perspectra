import { commissionSource, NoticeCommissions, type BoardOperation } from './notice-commission.ts'
import { localWitnesses, NoticeBoard } from './notice-board.ts'
import { firstPackTimeCrossing } from './pack-time.ts'
import { randomUUID } from 'node:crypto'
import { activityProgress, executeWorldRound, type WorldRoundEffects, type WorldRoundSnapshot } from '@perspectra/core'
import { currentCharacterLifecycle, currentEntityState } from '@perspectra/core/kernel'
import { WorldStore, WriterLeaseService, type NoticeReceipt } from '@perspectra/core/store'
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
import type { EventRuleCheck, InspectedEventRule } from './creator-inspection.ts'

const source = 'host.world-events/v1'
export const eventWakeupsPerWindow = 4
type WakeStatus = 'pending' | 'claimed' | 'completed'
interface EventWake {
  key: string
  recipient: string
  observationSeq: number
  status: WakeStatus
}
interface IndexedOccurrence extends Occurrence {
  seq: number
  witnesses: { id: string; seq: number; notice: string }[]
}
interface Occurrence extends WorldEventEnvelope, WorldJsonObject {
  ruleId: string
  cycle: string
  pacedRound?: number
  wakeRecipients?: string[]
  grants: string[]
}
const grantId = (g: EventGrant) =>
  JSON.stringify([g.plugin, g.type, g.mode, g.effect?.key ?? null, g.effect?.value ?? null])
const receiptId = (g: EventGrant, event: Occurrence) => JSON.stringify([g.plugin, g.mode, event.occurrenceId])
function witnesses(rule: EventRule, snapshot: WorldRoundSnapshot): string[] {
  const { events, manifest } = snapshot
  const sameScene = localWitnesses(snapshot.events, rule.location)
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
      for (const id of localWitnesses(snapshot.events, location))
        if (!result.has(id) && (!allowed || allowed.has(id))) result.set(id, group.text)
  }
  return result
}

/** One mounted branch. The local index can be rebuilt entirely from its effective committed prefix. */
export class WorldEventRuntime {
  private readonly board = new NoticeBoard()
  private readonly commissions = new NoticeCommissions(this.board)
  private readonly occurrences = new Map<string, IndexedOccurrence>()
  private readonly checks = new Map<string, EventRuleCheck>()
  private readonly wakes = new Map<string, EventWake>()
  private readonly configuredWakes: boolean
  get hasWakeRules(): boolean {
    return this.active && (this.configuredWakes || [...this.wakes.values()].some(wake => wake.status === 'pending'))
  }
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
    private readonly captureCognition = false,
  ) {
    this.configuredWakes = book.rules.some(rule => rule.wakeCharacters?.length)
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
    if ([...this.wakes.values()].some(w => w.status === 'claimed'))
      console.warn('[worldEvents] unconfirmed character decision; automatic retry withheld')
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
    let registrations: readonly NoticeReceipt[] | undefined
    for (const event of this.store.readEventsRange(this.address, this.indexed, through, ['world.tick-advanced'])) {
      const row = this.store.readRoundAuthority(this.address, event.transactionId)?.authority
      if (row?.packId !== this.packId) continue
      if (row.source === commissionSource) {
        this.commissions.index(row, event.seq)
        continue
      }
      if (row.source !== source) continue
      const occurrences = (row.occurrences ?? []) as Occurrence[]
      const observations =
        occurrences.length || row.noticePostings || row.noticeRead
          ? this.store.readEventsRange(this.address, event.seq - event.eventOrdinal - 1, event.seq, [
              'observation.upsert',
            ])
          : []
      if (row.noticePostings) registrations ??= this.store.pendingNoticeDefinitions(this.address)
      if (row.noticePostings || row.noticeRead) this.board.index(row, observations, event.seq, registrations)
      for (const raw of occurrences) {
        const witnesses = observations.flatMap(observation => {
          const data = observation.data as WorldJsonObject
          const value = data.value as WorldJsonObject
          const id = value.observerId
          const notice = (value.content as WorldJsonObject | undefined)?.eventNotice
          return observation.transactionId === event.transactionId &&
            typeof id === 'string' &&
            data.id === raw.occurrenceId + ':witness:' + id &&
            typeof notice === 'string'
            ? [{ id, notice, seq: observation.seq }]
            : []
        })
        this.occurrences.set(raw.ruleId, { ...raw, seq: event.seq, witnesses })
        for (const recipient of raw.wakeRecipients ?? []) {
          const key = raw.occurrenceId + ':witness:' + recipient
          const witness = witnesses.find(w => w.id === recipient)
          if (!witness) throw new Error('world-events: wake lacks its committed personal observation')
          this.wakes.set(key, { key, recipient, observationSeq: witness.seq, status: 'pending' })
        }
      }
      if (row.wakeKey !== undefined) {
        const wake = this.wakes.get(String(row.wakeKey))
        if (!wake || wake.status !== row.from || !['pending', 'claimed', 'completed'].includes(String(row.to)))
          throw new Error('world-events: inconsistent wake receipt')
        wake.status = row.to as WakeStatus
      }
      for (const id of (row.receipts ?? []) as string[]) this.receipts.add(id)
    }
    this.indexed = through
  }
  pendingWakes(): EventWake[] {
    if (!this.hasWakeRules) return []
    this.index(this.store.head(this.address).headSeq)
    return [...this.wakes.values()].filter(wake => wake.status === 'pending')
  }
  inspect(through: number): InspectedEventRule[] {
    this.index(through)
    return this.book.rules.map(rule => {
      const event = this.occurrences.get(rule.id)
      const check = this.checks.get(rule.id)
      return {
        rule: structuredClone(rule),
        lastCheck: check ? { ...check } : null,
        occurrence: event
          ? {
              id: event.occurrenceId,
              seq: event.seq,
              cycle: event.cycle,
              pacedRound: event.pacedRound ?? null,
              clockTransaction: typeof event.clockTransaction === 'string' ? event.clockTransaction : null,
              witnesses: event.witnesses.map(w => ({
                ...w,
                wake: this.wakes.get(event.occurrenceId + ':witness:' + w.id)?.status ?? null,
              })),
              deliveries: this.book.grants
                .filter(g => event.grants.includes(grantId(g)))
                .map(g => ({
                  plugin: g.plugin,
                  mode: g.mode,
                  receipt: this.receipts.has(receiptId(g, event)),
                })),
            }
          : null,
      }
    })
  }
  witnessedRules(actor: string, through: number): string[] {
    if (through > this.indexed) this.index(through)
    return [...this.occurrences.values()]
      .filter(e => e.seq <= through && e.witnesses.some(w => w.id === actor))
      .map(e => e.ruleId)
  }
  boardNotices(actor: string) {
    const head = this.store.head(this.address).headSeq
    this.index(head)
    return this.board.available(actor, this.store.readEvents(this.address, head))
  }
  knownNotices(actor: string, through = this.store.head(this.address).headSeq) {
    if (through > this.indexed) this.index(through)
    return this.board.known(actor, through)
  }
  boardChoices(actor: string, events: WorldRoundSnapshot['events'], through: number) {
    if (!this.store.noticeCommissionsEnabled()) return []
    if (through > this.indexed) this.index(through)
    return this.commissions.choices(actor, events, through)
  }
  async applyBoardAction(
    path: string,
    actorId: string,
    occurrenceId: string,
    operation: BoardOperation,
    beforeCommit?: () => void,
  ) {
    if (operation !== 'read' && !this.store.noticeCommissionsEnabled())
      throw new TypeError('当前无法办理这项告示操作。')
    const leases = new WriterLeaseService(path)
    try {
      await executeWorldRound(
        {
          store: this.store,
          leases,
          address: this.address,
          owner: 'notice-board:' + randomUUID(),
          actorId,
          captureCognition: this.captureCognition,
        },
        snapshot => {
          this.index(snapshot.head.headSeq)
          if (operation !== 'read') {
            const signup = this.commissions.adjudicate(actorId, occurrenceId, operation, snapshot)
            if (!signup) return
            beforeCommit?.()
            return { events: [], authority: { source: commissionSource, packId: this.packId, ...signup } }
          }
          if ([...activityProgress(snapshot.events).values()].some(activity => activity.game.active))
            throw new TypeError('当前无法查看这张告示。')
          const draft = this.board.read(actorId, occurrenceId, snapshot)
          if (!draft) return
          beforeCommit?.()
          return {
            events: [draft],
            authority: { source, packId: this.packId, actorId, noticeRead: { actorId, occurrenceId } },
          }
        },
      )
      this.index(this.store.head(this.address).headSeq)
    } finally {
      leases.close()
    }
  }
  async markWake(path: string, key: string, to: WakeStatus, signal: AbortSignal): Promise<boolean> {
    if (!this.active) return false
    const from = to === 'claimed' ? 'pending' : 'claimed'
    const leases = new WriterLeaseService(path)
    try {
      const committed = await executeWorldRound(
        { store: this.store, leases, address: this.address, owner: 'event-decision:' + randomUUID(), signal },
        snapshot => {
          this.index(snapshot.head.headSeq)
          const wake = this.wakes.get(key)
          if (!wake || wake.status !== from) return undefined
          if (
            to === 'claimed' &&
            (currentCharacterLifecycle(snapshot.events, wake.recipient) !== 'active' ||
              [...activityProgress(snapshot.events).values()].some(
                a => a.game.active && a.participants.some(id => id === wake.recipient),
              ))
          )
            return undefined
          return { events: [], authority: { source, packId: this.packId, wakeKey: key, from, to } }
        },
      )
      return committed !== undefined
    } finally {
      leases.close()
    }
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
  private eligiblePaced(snapshot: WorldRoundSnapshot, round: number, busy: boolean) {
    this.index(snapshot.head.headSeq)
    return this.book.rules.filter(rule => {
      if (rule.trigger !== 'paced' || rule.round === undefined || this.occurrences.has(rule.id)) return false
      const result = round < rule.round ? 'round' : busy && !rule.duringActivity ? 'activity' : 'ready'
      this.checks.set(rule.id, { seq: snapshot.head.headSeq, round, result })
      return result === 'ready'
    })
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
      const visible = notices(rule, snapshot, crossings?.get(rule.id))
      const wakeRecipients = rule.wakeCharacters?.filter(
        id =>
          visible.has(id) &&
          !snapshot.manifest.playerBindings.some(p => p.characterId === id) &&
          currentCharacterLifecycle(snapshot.events, id) === 'active',
      )
      events.push(
        this.statusEvent(snapshot, cycle, rule.set),
        // A world occurrence is nobody's accepted action. A personal observation remains readable
        // without nominating its observer for a turn in the normal action-reaction scheduler.
        ...[...visible].map(
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
        ...(wakeRecipients?.length ? { wakeRecipients } : {}),
        grants: this.book.grants.filter(g => g.type === rule.type).map(grantId),
      })
    }
    return { events, occurrences }
  }
  private effects(events: WorldEventDraft[], occurrences: Occurrence[], receipts: string[]) {
    return { events, authority: { source, packId: this.packId, occurrences, receipts } } satisfies WorldRoundEffects
  }
  settlePaced(snapshot: WorldRoundSnapshot, cycle: string, start: number, ruleId: string, busy: boolean) {
    const { round } = playerRoundNumber(snapshot.events, start, false)
    const rule = this.eligiblePaced(snapshot, round, busy).find(rule => rule.id === ruleId)
    if (!rule) throw new TypeError('节奏选择了条件未满足的世界事件')
    const { events, occurrences } = this.occurrenceEffects(snapshot, cycle, [rule], round)
    return this.effects(events, occurrences, [])
  }
  /** A soft stop may only settle a calendar crossing actually committed in this selected branch's window. */
  settleCurrentClock(snapshot: WorldRoundSnapshot, cycle: string, start: number) {
    return this.active ? this.settle(snapshot, cycle, start, true) : undefined
  }
  settle(
    snapshot: WorldRoundSnapshot,
    cycle: string,
    start: number,
    currentClockOnly = false,
  ): WorldRoundEffects | undefined {
    this.index(snapshot.head.headSeq)
    const { round } = playerRoundNumber(snapshot.events, start, false)
    const crossings = new Map<string, WorldRoundSnapshot['events']>()
    const hard = this.book.rules.filter(rule => {
      if (rule.trigger === 'paced' || this.occurrences.has(rule.id)) return false
      const checked = (result: EventRuleCheck['result']) => {
        this.checks.set(rule.id, { seq: snapshot.head.headSeq, round, result })
        return result === 'ready'
      }
      if (!rule.crossesPackTime) return !currentClockOnly && checked(round >= rule.round ? 'ready' : 'round')
      let invalid = false
      const crossing = firstPackTimeCrossing(snapshot.events, rule.crossesPackTime, () => {
        invalid = true
        if (!this.warnedClocks.has(rule.id)) console.warn('[worldEvents] invalid calendar day or slot for ' + rule.id)
        this.warnedClocks.add(rule.id)
      })
      if (!crossing) return checked(invalid ? 'clock-invalid' : 'clock')
      if (currentClockOnly && crossing.at(-1)!.seq <= start) return checked('clock-window')
      crossings.set(rule.id, crossing)
      return checked('ready')
    })
    const { events, occurrences } = this.occurrenceEffects(snapshot, cycle, hard, undefined, crossings)
    const receipts: string[] = []
    if (this.active && !currentClockOnly)
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
    const board = this.board.settle(this.store, this.address, this.book, snapshot, currentClockOnly ? start : undefined)
    if (!occurrences.length && !receipts.length && !board.postings.length) return undefined
    const result = this.effects([...events, ...board.events], occurrences, receipts)
    return board.postings.length
      ? { ...result, authority: { ...result.authority, noticePostings: board.postings } }
      : result
  }
}
