import type { StoredWorldEvent, WorldAddress, WorldHash, WorldJsonObject } from '@harness-world/contracts'
import type { CompiledWorldPackV5 } from '@harness-world/world-pack'
import { WorldStore } from '@harness-world/store-sqlite'
import { createInstalledInteractionPackages } from '@harness-world/interactions-basic'
import {
  createCoreRulebookRegistry,
  RulebookRegistry,
  type RulebookEvent,
  type RulebookResolver,
} from '@harness-world/kernel'
import {
  PackActivity,
  activityProgress,
  readActivityWorld,
  type ActivityRequest,
  type ActivityState,
} from './pack-activity.ts'
import { characterExecutionResult } from '@harness-world/application'
import type { PackStatus } from './pack-status.ts'

/** One foreground activity, with independent progress in the existing world event log. */
export class PackActivities {
  readonly #entries = new Map<string, PackActivity>()
  #store: WorldStore | undefined
  #closed = false
  #snapshot: { headSeq: number; eventHash: WorldHash | 'genesis'; events: readonly StoredWorldEvent[] } | undefined
  #selection:
    | { events: readonly RulebookEvent[]; entry: PackActivity | undefined; states: ReadonlyMap<string, ActivityState> }
    | undefined
  private constructor(
    readonly worldPath: string,
    readonly address: WorldAddress,
    readonly playerId: string,
  ) {}
  static load(
    packPath: string,
    pack: CompiledWorldPackV5,
    worldPath: string,
    address: WorldAddress,
    playerId: string,
    status?: PackStatus,
  ): PackActivities | undefined {
    const catalog = new PackActivities(worldPath, address, playerId)
    for (const asset of pack.assets) {
      const match = /^scripts\/activities\/([a-z][a-z0-9-]{0,40})\.js$/u.exec(asset.path)
      if (asset.path !== 'scripts/activity.js' && !match) continue
      const key = match?.[1] ?? 'default'
      if (catalog.#entries.has(key)) throw new TypeError('重复的活动标识：' + key)
      const activity = PackActivity.load(packPath, pack, worldPath, address, playerId, asset.path, key, status)!
      activity.randomSource = () => catalog.#nextRandom()
      activity.readCurrent = () => catalog.#current(key)
      catalog.#entries.set(key, activity)
    }
    if (!catalog.#entries.size) return undefined
    try {
      catalog.#selected() // Validate stored activities and the single-foreground invariant on open.
      return catalog
    } catch (error) {
      catalog.close()
      throw error
    }
  }
  #readStore(): WorldStore {
    if (this.#closed) throw new Error('Activity catalog is closed')
    return (this.#store ??= new WorldStore(this.worldPath))
  }
  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.#store?.close()
    this.#store = undefined
    this.#snapshot = undefined
    this.#selection = undefined
  }
  #events(): readonly RulebookEvent[] {
    const store = this.#readStore(),
      { headSeq, eventHash } = store.head(this.address),
      previous = this.#snapshot
    if (previous?.headSeq === headSeq && previous.eventHash === eventHash) return previous.events
    // Each update contains a complete state. Keep the latest event per key, not the entire activity history.
    const afterSeq = previous && headSeq > previous.headSeq ? previous.headSeq : 0
    const latest = new Map<string, StoredWorldEvent>()
    for (const event of [
      ...(afterSeq > 0 ? previous!.events : []),
      ...store.readEventsRange(this.address, afterSeq, headSeq, ['activity.updated']),
    ]) {
      const key = (event.data as WorldJsonObject).activityKey ?? 'default'
      if (typeof key !== 'string') throw new TypeError('活动标识损坏')
      // Updating insertion order also preserves the latest activity when none occupies the foreground.
      latest.delete(key)
      latest.set(key, event)
    }
    const events = [...latest.values()]
    this.#snapshot = { headSeq, eventHash, events }
    return events
  }
  #selected(events = this.#events()): PackActivity | undefined {
    if (this.#selection?.events === events) return this.#selection.entry
    const progress = activityProgress(events)
    let foreground: PackActivity | undefined
    for (const [key, state] of progress) {
      const entry = this.#entries.get(key)
      if (!entry) throw new TypeError('存档活动未安装：' + key)
      entry.state(events)
      if (state.game.active) foreground = entry
    }
    const latest = events.findLast(event => event.eventType === 'activity.updated')
    const entry =
      foreground ??
      (latest
        ? this.#entries.get(String((latest.data as WorldJsonObject).activityKey ?? 'default'))
        : this.#entries.values().next().value)
    this.#selection = { events, entry, states: progress }
    return entry
  }
  #current(key: string): ActivityState | undefined {
    this.#selected()
    return this.#selection!.states.get(key)
  }
  current() {
    const entry = this.#selected()
    return structuredClone(entry ? this.#selection!.states.get(entry.key) : undefined)
  }
  setActionResolver(resolve: NonNullable<PackActivity['resolveAction']>): void {
    for (const activity of this.#entries.values()) activity.resolveAction = resolve
  }
  debugStates(events: readonly RulebookEvent[]): WorldJsonObject[] {
    return [...this.#entries.entries()].map(([activityKey, entry]) => ({
      activityKey,
      state: structuredClone(entry.state(events)) ?? null,
    }))
  }
  view(actorId: string) {
    const entry = this.#selected()
    return entry?.view(actorId, { state: structuredClone(this.#selection!.states.get(entry.key)) })
  }
  /**
   * Every activity's view from one committed prefix. While one runs in the foreground the others' start choices
   * are hidden everywhere, so their conditions are not evaluated; otherwise they share one world snapshot.
   */
  views(actorId: string): WorldJsonObject[] {
    const events = this.#events()
    const foreground = this.#selected(events)?.state(events)?.game.active === true
    let world: ReturnType<typeof readActivityWorld> | undefined
    return [...this.#entries.values()].map(entry =>
      entry.view(actorId, {
        // Hooks may touch what they are given; the cached prefix stays untouched.
        state: structuredClone(entry.state(events)),
        foreground,
        ...(foreground ? {} : { world: (world ??= readActivityWorld(this.worldPath, this.address)) }),
      }),
    )
  }
  // One recorded sequence per round, so regenerating replays both the tie-break and every initialize in order.
  #randomValues: number[] = []
  #randomReplay: readonly number[] | undefined
  #randomCursor = 0
  beginRoundRandom(values?: readonly number[]): void {
    this.#randomValues = []
    this.#randomReplay = values
    this.#randomCursor = 0
  }
  roundRandom(): number[] {
    return [...this.#randomValues]
  }
  #nextRandom(): number {
    const value = this.#randomReplay === undefined ? Math.random() : this.#randomReplay[this.#randomCursor]
    if (value === undefined) throw new TypeError('活动随机记录不足。')
    this.#randomCursor++
    this.#randomValues.push(value)
    return value
  }
  /** After a player round: start at most one activity whose author conditions all hold. The most conditions
   * win; a tie draws from the round random. Returns whether a start was committed. */
  async autoStart(): Promise<boolean> {
    if (this.current()?.game.active) return false
    const world = readActivityWorld(this.worldPath, this.address)
    const met = [...this.#entries].flatMap(([key, entry]) => {
      const candidate = entry.autoStartCandidate(world)
      return candidate?.met ? [{ key, entry, ...candidate }] : []
    })
    if (!met.length) return false
    const most = Math.max(...met.map(candidate => candidate.conditions)),
      tied = met.filter(candidate => candidate.conditions === most)
    const chosen =
      tied.length === 1 ? tied[0]! : tied[Math.min(tied.length - 1, Math.floor(this.#nextRandom() * tied.length))]!
    const store = new WorldStore(this.worldPath)
    let headSeq: number
    try {
      headSeq = store.head(this.address).headSeq
    } finally {
      store.close()
    }
    // Derived from the committed prefix, so a repeated check of the same round cannot start twice.
    return chosen.entry.apply(
      {
        activityKey: chosen.key,
        activityId: null,
        revision: 0,
        operation: 'start',
        parameters: chosen.parameters,
        requestId: 'auto-start:' + chosen.key + ':' + headSeq,
      },
      chosen.notice === undefined ? {} : { notice: chosen.notice },
    )
  }
  async apply(request: ActivityRequest): Promise<boolean> {
    const entry =
      request.activityKey !== undefined
        ? this.#entries.get(request.activityKey)
        : request.activityId !== null
          ? [...this.#entries.values()].find(value => value.current()?.id === request.activityId)
          : this.#entries.size === 1
            ? this.#entries.values().next().value
            : undefined
    if (!entry) throw new TypeError('请选择已声明的活动')
    return entry.apply(request)
  }
  async escape(): Promise<void> {
    await this.#selected()?.escape()
  }
  async speak(...args: Parameters<PackActivity['speak']>): Promise<void> {
    const entry = this.#selected()
    if (!entry) throw new TypeError('没有运行中的活动')
    await entry.speak(...args)
  }
  async worldAction(...args: Parameters<PackActivity['worldAction']>): Promise<void> {
    const entry = this.#selected()
    if (!entry) throw new TypeError('没有运行中的活动')
    await entry.worldAction(...args)
  }
  projectContext(...args: Parameters<PackActivity['projectContext']>) {
    return this.#selected()?.projectContext(...args) ?? args[0]
  }
  validateDecision(...args: Parameters<PackActivity['validateDecision']>): void {
    this.#selected()?.validateDecision(...args)
  }
  simulate(...args: Parameters<PackActivity['simulate']>) {
    return this.#selected()?.simulate(...args)
  }
  filterAffordances(...args: Parameters<PackActivity['filterAffordances']>) {
    return this.#selected()?.filterAffordances(...args) ?? [...args[0]]
  }
  schedule() {
    return this.#selected()?.schedule()
  }
  outcome(...args: Parameters<PackActivity['outcome']>) {
    return this.#selected()?.outcome(...args)
  }
  executionResult = (...args: Parameters<typeof characterExecutionResult>) =>
    this.#selected()?.executionResult(...args) ?? characterExecutionResult(...args)
  rulebooks(external?: RulebookResolver): RulebookRegistry {
    const base =
      external ??
      createCoreRulebookRegistry({ interactionPackages: createInstalledInteractionPackages() }).resolve(
        'builtin:speak-move',
        2,
        'activities',
        this.address,
      )
    const resolverFor = (events: readonly RulebookEvent[]) => {
      const entry = this.#selected(events)
      return entry?.state(events)?.game.active
        ? entry.rulebooks(external).resolve('builtin:speak-move', 2, 'activities', this.address)
        : base
    }
    const resolver: RulebookResolver = {
      affordances: context => resolverFor(context.events).affordances(context),
      resolve: context => {
        const parameters = context.action.parameters as WorldJsonObject
        const definition = parameters.definitionRef as WorldJsonObject | undefined
        if (
          typeof definition?.id === 'string' &&
          definition.id.startsWith('activity:') &&
          !this.#selected(context.events)?.state(context.events)?.game.active
        )
          throw new TypeError('没有运行中的活动，旧操作已失效')
        return resolverFor(context.events).resolve(context)
      },
    }
    const registry = new RulebookRegistry()
    registry.register('builtin:speak-move', 2, resolver)
    return registry
  }
}
