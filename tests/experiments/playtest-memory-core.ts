import { unlinkSync, appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { brandId, canonicalizeWorldJson, RECALL_KEYWORD_TOKENIZER_ID, worldAddressKey,
  type WorldAddress, type WorldJsonObject, type WorldJsonValue } from '@harness-world/contracts'
import { CognitiveMemoryService } from '@harness-world/memory'
import { WorldStore } from '@harness-world/store-sqlite'
import type { PrototypeTurnRequest } from '../../packages/application/src/prototype-character-turn.ts'
import { identityEntry } from '../../experiments/hindsight-core/alias-history.ts'
import type { CoreRunner } from './hindsight-python.ts'

function object(value: WorldJsonValue | undefined): WorldJsonObject {
  if (value === null || value === undefined || Array.isArray(value) || typeof value !== 'object') throw new TypeError('invalid memory object')
  return value as WorldJsonObject
}
const same = (left: WorldJsonValue, right: WorldJsonValue) =>
  JSON.stringify(canonicalizeWorldJson(left)) === JSON.stringify(canonicalizeWorldJson(right))

export interface MemoryContextBudget {
  readonly triggerTokens: number
  readonly compactTokens: number
  readonly minimumRecentTokens?: number
}
export const DEFAULT_MEMORY_CONTEXT_BUDGET: MemoryContextBudget = { triggerTokens: 170_000, compactTokens: 120_000, minimumRecentTokens: 16_000 }
export const MEMORY_DELIVERY_BUDGET = { maxItems: 6, maxJsonChars: 12_000 } as const

/** Conservative local estimate, not the gateway's tokenizer: ASCII / 3, other code points / 1. */
export function estimateContextTokens(text: string): number {
  let ascii = 0, other = 0
  for (const char of text) { if (char.codePointAt(0)! < 128) ascii++; else other++ }
  return Math.ceil(ascii / 3 + other)
}

type Snapshot = { scope: WorldJsonObject; sources: WorldJsonObject[]; tick: number }
export interface MemoryBuildOptions {
  readonly run?: CoreRunner
  readonly roleConcurrency?: number
  readonly retainConcurrency?: number
  readonly worldVersion?: string
  readonly versionValid?: () => boolean
}
interface BuildJob {
  readonly id: string; readonly actor: string; readonly prefix: number; readonly snapshot: Snapshot
  readonly worldVersion: string
  readonly input: WorldJsonObject; readonly controller: AbortController; readonly frozenAt: number
  readonly done: Promise<void>; readonly finish: () => void
  started: boolean; failure?: unknown
}

/** Host adapter only. Python never receives a world path, pack variables or other roles' views. */
export class PlaytestMemoryCore {
  readonly #directory: string
  readonly #aliases = new Map<string, WorldJsonObject[]>()
  readonly #pending = new Map<string, number>()
  readonly #jobs = new Map<string, BuildJob>()
  readonly #buildRun: CoreRunner
  readonly #roleConcurrency: number
  readonly #retainConcurrency: number
  readonly #worldVersion: string
  readonly #versionValid: () => boolean
  #installationGate: Promise<void> | undefined
  #releaseInstallation: (() => void) | undefined
  holdInstallation(): void {
    if (!this.#installationGate) this.#installationGate = new Promise<void>(done => { this.#releaseInstallation = done })
  }
  releaseInstallation(): void { this.#releaseInstallation?.(); this.#releaseInstallation = undefined; this.#installationGate = undefined }
  #active = 0
  #closed = false
  #counts = { completed: 0, failed: 0, discarded: 0, cancelled: 0 }
  #startedAt: number | null = null
  #finishedAt: number | null = null
  constructor(readonly dataDirectory: string, readonly address: WorldAddress, readonly run: CoreRunner,
    readonly budget: MemoryContextBudget = DEFAULT_MEMORY_CONTEXT_BUDGET, build: MemoryBuildOptions = {}, readonly deliveryBudget: {maxItems:number;maxJsonChars:number} = MEMORY_DELIVERY_BUDGET) {
    if(!Number.isSafeInteger(deliveryBudget.maxItems)||deliveryBudget.maxItems<1||deliveryBudget.maxItems>30||!Number.isSafeInteger(deliveryBudget.maxJsonChars)||deliveryBudget.maxJsonChars<1000||deliveryBudget.maxJsonChars>64000)throw new TypeError('invalid memory delivery budget')
    if (!Number.isSafeInteger(budget.triggerTokens) || !Number.isSafeInteger(budget.compactTokens)
      || budget.compactTokens <= 0 || budget.triggerTokens <= budget.compactTokens)
      throw new TypeError('invalid memory context budget')
    this.#worldVersion = build.worldVersion ?? randomUUID()
    this.#versionValid = build.versionValid ?? (() => !this.#closed)
    this.#buildRun = build.run ?? run
    this.#roleConcurrency = build.roleConcurrency ?? 2
    this.#retainConcurrency = build.retainConcurrency ?? 2
    if (![this.#roleConcurrency, this.#retainConcurrency].every(n => Number.isInteger(n) && n >= 1 && n <= 4)
      || !Number.isSafeInteger(budget.minimumRecentTokens ?? 16_000) || (budget.minimumRecentTokens ?? 16_000) < 0)
      throw new TypeError('invalid memory build limits')
    this.#directory = resolve(dataDirectory, 'memory-core')
    mkdirSync(this.#directory, { recursive: true })
  }
  #path(actor: string): string { return resolve(this.#directory, Buffer.from(actor).toString('base64url') + '.json') }
  #load(actor: string): WorldJsonObject | undefined {
    const path = this.#path(actor)
    if (!existsSync(path)) return undefined
    const cached = JSON.parse(readFileSync(path, 'utf8')) as WorldJsonObject
    return cached
  }
  #restoreAliases(actor: string, scope: WorldJsonObject, cached: WorldJsonObject | undefined): WorldJsonObject[] {
    const prior = this.#aliases.get(actor)
    if (prior) return prior
    const seedPath = resolve(this.dataDirectory, 'memory-aliases.json')
    const seed = existsSync(seedPath) ? object(JSON.parse(readFileSync(seedPath, 'utf8'))) : {}
    const entries = [...(cached?.aliasHistory ?? []) as WorldJsonObject[], ...(seed[actor] ?? []) as WorldJsonObject[]]
    for (const entry of entries) {
      const own = object(entry.scope)
      if (own.characterId !== actor || !same(own.worldAddress!, scope.worldAddress!)
        || !Number.isSafeInteger(entry.worldSeq) || Number(entry.worldSeq) > Number(scope.asOfWorldSeq)
        || !Number.isSafeInteger(own.asOfWorldSeq) || Number(own.asOfWorldSeq) > Number(scope.asOfWorldSeq))
        throw new Error('identity history crosses authorized world or prefix')
    }
    const path = resolve(this.#directory, 'recall-trace.jsonl')
    if (existsSync(path)) for (const line of readFileSync(path, 'utf8').split('\n').filter(Boolean)) {
      const row = JSON.parse(line) as WorldJsonObject
      if (row.actor !== actor) continue
      const own = object(row.scope)
      if (own.characterId !== actor || !same(own.worldAddress!, scope.worldAddress!)
        || !Number.isSafeInteger(own.asOfWorldSeq) || Number(own.asOfWorldSeq) > Number(scope.asOfWorldSeq))
        throw new Error('identity trace crosses authorized world or prefix')
      const entry = identityEntry(object(object(row.request).context), own, Number(own.asOfWorldSeq))
      if (!entries.some(e => same(e.people!, entry.people!))) entries.push(entry)
    }
    this.#aliases.set(actor, entries)
    return entries
  }
  #snapshot(actor: string): { scope: WorldJsonObject; sources: WorldJsonObject[]; tick: number } {
    const store = new WorldStore(resolve(this.dataDirectory, 'world.sqlite'))
    const memory = new CognitiveMemoryService(resolve(this.dataDirectory, 'memory.sqlite'), store,
      undefined, 2, RECALL_KEYWORD_TOKENIZER_ID)
    try {
      const head = store.head(this.address)
      memory.catchUp(this.address, brandId(actor, 'CharacterId'), head.headSeq, 'web-core-memory')
      // The host supplies timestamps only for the character's already authorized source rows.
      const ticks = new Map(store.readEvents(this.address).map(e => [e.seq, e.tick]))
      const db = new DatabaseSync(resolve(this.dataDirectory, 'memory.sqlite'), { readOnly: true })
      type Row = { source_id: string; source_hash: string; epistemic_kind: string; source_seq: number; text_value: string }
      let rows: Row[]
      try {
        rows = db.prepare('SELECT source_id,source_hash,epistemic_kind,source_seq,text_value FROM cognitive_memory_v2_sources WHERE namespace_key=? AND source_seq<=? ORDER BY source_seq,source_id')
          .all(worldAddressKey(this.address) + '\u001f' + actor, head.headSeq) as Row[]
      } finally { db.close() }
      return { scope: { worldAddress: { ...this.address }, characterId: actor, asOfWorldSeq: head.headSeq }, tick: head.tick,
        sources: rows.map(r => {
          const tick = ticks.get(r.source_seq)
          if (tick === undefined) throw new Error('authorized source timestamp is missing')
          return { sourceId: r.source_id, sourceHash: r.source_hash, epistemicKind: r.epistemic_kind,
            worldSeq: r.source_seq, characterId: actor, worldAddress: { ...this.address }, text: r.text_value, knownTick: tick }
        }) }
    } finally { memory.close(); store.close() }
  }
  #validate(cached: WorldJsonObject, snapshot: { scope: WorldJsonObject; sources: WorldJsonObject[]; tick: number }): void {
    const archive = object(cached.archive), scope = object(archive.scope), index = object(cached.index)
    if (!same(scope.worldAddress!, snapshot.scope.worldAddress!) || scope.characterId !== snapshot.scope.characterId
      || !Number.isSafeInteger(scope.asOfWorldSeq) || Number(scope.asOfWorldSeq) > Number(snapshot.scope.asOfWorldSeq)
      || !same(index.scope!, scope)) throw new Error('memory archive belongs to another role, world or future prefix')
    const expected = snapshot.sources.filter(s => Number(s.worldSeq) <= Number(scope.asOfWorldSeq))
    if (!same(archive.sources!, expected)) throw new Error('memory source prefix changed')
  }
  archivePrefix(actor: string): number {
    const cached = this.#load(actor)
    if (!cached) return 0
    const scope = object(object(cached.archive).scope)
    if (scope.characterId !== actor || !same(scope.worldAddress!, { ...this.address })
      || !Number.isSafeInteger(scope.asOfWorldSeq) || Number(scope.asOfWorldSeq) < 0)
      throw new Error('memory archive belongs to another role or world')
    return Number(scope.asOfWorldSeq)
  }
  shortTermAfterSeq(actor: string): number {
    const prefix = this.archivePrefix(actor), cached = this.#load(actor)
    if (!cached) return 0
    // A small overlapping raw tail prevents a manual refresh from clearing all recent experience.
    let tokens = 0, afterSeq = prefix
    for (const source of (object(cached.archive).sources as WorldJsonObject[]).toReversed()) {
      if (tokens >= (this.budget.minimumRecentTokens ?? 16_000)) break
      tokens += estimateContextTokens(JSON.stringify(source))
      afterSeq = Math.min(afterSeq, Number(source.worldSeq) - 1)
    }
    return Math.max(0, afterSeq)
  }
  backgroundState(): WorldJsonObject {
    return { running: this.#active, queued: this.#jobs.size - this.#active, ...this.#counts,
      startedAt: this.#startedAt, finishedAt: this.#finishedAt,
      roleConcurrency: this.#roleConcurrency, retainConcurrency: this.#retainConcurrency }
  }
  get hasPendingCompaction(): boolean { return this.#pending.size > 0 }

  /** Count the rendered system/user context plus tool schema; queue only complete, chronological source groups. */
  observeContext(request: PrototypeTurnRequest, promptText: string): void {
    if (this.#closed) return
    const actor = String(object(request.context.character).characterId)
    const tokens = estimateContextTokens(promptText) + 512 // provider framing margin
    if (tokens < this.budget.triggerTokens || this.#pending.has(actor)
      || [...this.#jobs.values()].some(job => job.actor === actor)) return
    const afterSeq = this.archivePrefix(actor), groups = new Map<number, number>()
    for (const record of [...(request.context.observations ?? []) as WorldJsonObject[],
      ...(request.context.selfObservations ?? []) as WorldJsonObject[]]) {
      const seq = Number(record.sourceSeq)
      if (!Number.isSafeInteger(seq) || seq < 0) throw new Error('invalid short-term source sequence')
      if (seq <= afterSeq) continue // An archive may have advanced while foreground recall was awaiting its worker.
      groups.set(seq, (groups.get(seq) ?? 0) + estimateContextTokens(JSON.stringify(record)))
    }
    const ordered = [...groups.entries()].sort(([a], [b]) => a - b)
    let selectedTokens = 0, cutoff = afterSeq
    // Always retain the latest source group, even when a single large observation exceeds the target.
    for (const [seq, size] of ordered.slice(0, -1)) {
      if (selectedTokens > 0 && selectedTokens + size > this.budget.compactTokens) break
      selectedTokens += size; cutoff = seq
      if (selectedTokens >= this.budget.compactTokens) break
    }
    if (cutoff === afterSeq) return
    this.#pending.set(actor, cutoff)
    appendFileSync(resolve(this.#directory, 'compaction-trace.jsonl'), JSON.stringify({ actor,
      estimatedPromptTokens: tokens, selectedHistoryTokens: selectedTokens, afterSeq, cutoff,
      triggerTokens: this.budget.triggerTokens, compactTokens: this.budget.compactTokens, status: 'queued' }) + '\n')
  }
  startPending(): void {
    const entries = [...this.#pending.entries()]
    this.#pending.clear()
    this.#startJobs(entries)
  }
  async compactPending(signal: AbortSignal, progress: (index: number, total: number) => void): Promise<void> {
    this.startPending()
    await this.#waitJobs([...this.#jobs.values()], signal, progress)
  }
  async project(request: PrototypeTurnRequest, signal: AbortSignal): Promise<PrototypeTurnRequest> {
    const actor = String(object(request.context.character).characterId)
    const snapshot = this.#snapshot(actor), cached = this.#load(actor)
    if (cached) this.#validate(cached, snapshot)
    const aliases = this.#restoreAliases(actor, snapshot.scope, cached)
    const identity = identityEntry(request.context, snapshot.scope, Number(snapshot.scope.asOfWorldSeq))
    if (!aliases.some(a => same(a.people!, identity.people!))) aliases.push(identity)
    this.#aliases.set(actor, aliases)
    let memories: WorldJsonObject[] = [], result: WorldJsonObject | undefined
    if (cached !== undefined) {
      const context = request.context
      const queryRequest: WorldJsonObject = { context: { character: context.character!, scene: context.scene!,
        items: context.items ?? [], stimulus: context.stimulus ?? [], observations: context.observations ?? [],
        selfObservations: context.selfObservations ?? [] },
        ...(request.recallEvidence === undefined ? {} : { recallEvidence: { query: request.recallEvidence.query! } }) }
      result = await this.run({ operation: 'recall', archive: cached.archive!, index: cached.index!,
        request: queryRequest, tick: snapshot.tick, observations: true, deliveryMode: 'minimal',
        deliveryBudget: this.deliveryBudget }, signal)
      memories = result.delivery as WorldJsonObject[]
      if (!Array.isArray(memories) || memories.length > this.deliveryBudget.maxItems || JSON.stringify(memories).length > this.deliveryBudget.maxJsonChars)
        throw new Error('memory delivery budget exceeded')
      const sources = new Map(snapshot.sources.map(s => [String(s.sourceId), s]))
      const trace = object(result.deliveryTrace)
      const references = [...(trace.delivered as WorldJsonObject[]).flatMap(t =>
        [...t.sourceRefs as WorldJsonObject[], ...(t.relationSourceRefs ?? []) as WorldJsonObject[]]),
        ...((trace.activityCoverage ?? []) as WorldJsonObject[]).flatMap(t => t.endingSourceRefs as WorldJsonObject[])]
      for (const ref of references) {
        const source = sources.get(String(ref.sourceId))
        const expected = source && Object.fromEntries(['sourceId','sourceHash','epistemicKind','worldSeq','characterId','worldAddress']
          .map(k => [k, source[k]!]))
        if (!expected || !same(ref, expected)) throw new Error('memory delivery crosses authorized evidence')
      }
      for (const m of memories) if (!(m.sourceIds as string[]).every(id => sources.has(id)))
        throw new Error('memory delivery source is unauthorized')
      for (const m of memories) for (const excerpt of (m.keyEvidence ?? []) as WorldJsonObject[])
        if (!(m.sourceIds as string[]).includes(String(excerpt.sourceId)) || !sources.has(String(excerpt.sourceId)))
          throw new Error('memory excerpt source is unauthorized')
    }
    appendFileSync(resolve(this.#directory, 'recall-trace.jsonl'), JSON.stringify({ actor, scope: snapshot.scope, tick: snapshot.tick,
      headSeq: snapshot.scope.asOfWorldSeq, memoryPrefix: cached ? object(object(cached.archive).scope).asOfWorldSeq : null,
      request, result: result ?? null, status: cached ? 'core' : 'not-yet-consolidated' }) + '\n')
    return { ...request, context: { ...request.context, memories },
      ...(request.recallEvidence === undefined ? {} : { recallEvidence: { ...request.recallEvidence, memories } }) }
  }
  recordDecision(request: PrototypeTurnRequest, response: unknown): void {
    appendFileSync(resolve(this.#directory, 'model-trace.jsonl'), JSON.stringify({ request, response, status: 'returned' }) + '\n')
  }
  startRefresh(actors: readonly string[], asOfWorldSeq?: number): void {
    // Freeze every role now, including roles waiting for a free slot. No Python gets a world path.
    this.#startJobs(actors.map(actor => [actor, asOfWorldSeq]))
  }
  async refresh(actors: readonly string[], signal: AbortSignal, progress: (index: number, total: number) => void): Promise<void> {
    this.startRefresh(actors)
    await this.#waitJobs([...this.#jobs.values()], signal, progress)
  }
  async #waitJobs(jobs: readonly BuildJob[], signal: AbortSignal, progress: (index: number, total: number) => void): Promise<void> {
    const abort = () => { for (const job of jobs) job.controller.abort(signal.reason); this.#pump() }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    try {
      let completed = 0
      await Promise.all(jobs.map(async job => { await job.done; progress(++completed, jobs.length) }))
      signal.throwIfAborted()
      const failed = jobs.find(job => job.failure !== undefined)
      if (failed) throw failed.failure
    } finally { signal.removeEventListener('abort', abort) }
  }
  /** Names only, from this role's authorized views; no provider requests or future archive is copied. */
  snapshotAliases(actors: readonly string[]): WorldJsonObject {
    const store = new WorldStore(resolve(this.dataDirectory, 'world.sqlite'))
    try {
      const head = store.head(this.address)
      return Object.fromEntries(actors.map(actor => {
        const scope = { worldAddress: { ...this.address }, characterId: actor, asOfWorldSeq: head.headSeq }
        const cached = this.#load(actor)
        // Installed archives still require source-prefix validation. Names without an archive
        // only need their role/world/prefix checks, not a rebuild of every authorized source.
        if (cached) this.#validate(cached, this.#snapshot(actor))
        return [actor, structuredClone(this.#restoreAliases(actor, scope, cached))]
      }))
    } finally { store.close() }
  }
  /** Copy only installed, authorized archives. Node creation never builds new memories. */
  snapshotArchives(actors: readonly string[]): WorldJsonObject {
    return Object.fromEntries(actors.flatMap(actor => {
      const cached = this.#load(actor)
      if (!cached) return []
      this.#validate(cached, this.#snapshot(actor))
      return [[actor, cached]]
    }))
  }
  /** Restore the node's actual memory boundary, including an explicitly empty archive set. */
  restoreArchives(archives: WorldJsonObject, actors: readonly string[]): void {
    if (Object.keys(archives).some(actor => !actors.includes(actor))) throw new Error('node memory contains an unknown role')
    for (const actor of actors) {
      const cached = archives[actor]
      if (cached !== undefined) {
        this.#validate(object(cached), this.#snapshot(actor))
        this.#restoreAliases(actor, this.#snapshot(actor).scope, object(cached))
      }
    }
    for (const actor of actors) {
      const cached = archives[actor], path = this.#path(actor)
      if (cached === undefined) {
        if (existsSync(path)) unlinkSync(path)
      } else {
        writeFileSync(path + '.tmp', JSON.stringify(cached))
        renameSync(path + '.tmp', path)
      }
    }
  }
  async waitForBackground(): Promise<void> {
    while (this.#jobs.size) await Promise.all([...this.#jobs.values()].map(job => job.done))
  }
  cancelBackground(): void {
    this.#pending.clear()
    for (const job of this.#jobs.values()) job.controller.abort()
    this.releaseInstallation()
    this.#pump()
  }
  async close(): Promise<void> {
    this.#closed = true; this.cancelBackground(); this.releaseInstallation(); await this.waitForBackground()
  }
  #trace(row: WorldJsonObject): void {
    appendFileSync(resolve(this.#directory, 'background-builds.jsonl'), JSON.stringify({ ...row, worldVersion: this.#worldVersion }) + '\n')
  }
  #startJobs(entries: readonly (readonly [string, number | undefined])[]): void {
    if (entries.length === 0 || this.#closed) return
    if (this.#jobs.size === 0) {
      this.#startedAt = Date.now(); this.#finishedAt = null
      this.#counts = { completed: 0, failed: 0, discarded: 0, cancelled: 0 }
    }
    for (const [actor, cutoff] of entries) {
      try { this.#enqueue(actor, cutoff) }
      catch (error: unknown) {
        // Report this role's failed snapshot without suppressing validation in foreground reads.
        this.#counts.failed++
        this.#trace({ event: 'freeze-failed', actor, atMs: Date.now(),
          errorType: error instanceof Error ? error.name : 'unknown' })
      }
    }
    this.#pump()
  }
  #enqueue(actor: string, cutoff?: number): void {
    if (this.#closed) throw new Error('memory background session is closed')
    const current = this.#snapshot(actor), cached = this.#load(actor)
    if (cached) this.#validate(cached, current)
    const prefix = cutoff ?? Number(current.scope.asOfWorldSeq)
    if (prefix <= this.archivePrefix(actor)) return
    if (!Number.isSafeInteger(prefix) || prefix > Number(current.scope.asOfWorldSeq)) throw new Error('invalid compaction prefix')
    const key = actor + ':' + prefix
    if (this.#jobs.has(key)) return
    const snapshot: Snapshot = { ...current, scope: { ...current.scope, asOfWorldSeq: prefix },
      sources: current.sources.filter(source => Number(source.worldSeq) <= prefix) }
    const aliasHistory = this.#restoreAliases(actor, current.scope, cached)
      .filter(entry => Number(entry.worldSeq) <= prefix)
    let finish!: () => void
    const id = randomUUID(), frozenAt = Date.now()
    const input: WorldJsonObject = structuredClone({ operation: 'build', ...snapshot, aliasHistory,
      retainConcurrency: this.#retainConcurrency, buildId: id,
      ...(cached === undefined ? {} : { retainedPrefix: cached.archive! }) })
    const job: BuildJob = { id, actor, prefix, snapshot, input, worldVersion: this.#worldVersion, frozenAt, started: false,
      controller: new AbortController(), done: new Promise<void>(done => { finish = done }), finish: () => finish() }
    this.#jobs.set(key, job)
    this.#trace({ event: 'frozen', buildId: id, actor, prefix, atMs: frozenAt,
      sourceCount: snapshot.sources.length, priorPrefix: cached ? object(object(cached.archive).scope).asOfWorldSeq! : 0 })
  }
  #pump(): void {
    for (const [key, job] of this.#jobs) {
      if (job.started) continue
      if (job.controller.signal.aborted) {
        this.#jobs.delete(key); this.#counts.cancelled++; job.finish()
        this.#trace({ event: 'cancelled', buildId: job.id, actor: job.actor, prefix: job.prefix, atMs: Date.now() })
        continue
      }
      if (this.#active >= this.#roleConcurrency) continue
      job.started = true; this.#active++
      const startedAt = Date.now(), start = performance.now()
      this.#trace({ event: 'started', buildId: job.id, actor: job.actor, prefix: job.prefix,
        atMs: startedAt, queueMs: startedAt - job.frozenAt, activeBuilds: this.#active })
      const signal = AbortSignal.any([job.controller.signal, AbortSignal.timeout(600_000)])
      void Promise.resolve().then(() => this.#buildRun(job.input, signal)).then(async result => {
        if (this.#installationGate) await this.#installationGate
        signal.throwIfAborted()
        if (this.#closed || !this.#versionValid() || job.worldVersion !== this.#worldVersion) throw new Error('memory task world version expired')
        this.#validate(result, job.snapshot)
        if (!same(object(result.archive).scope!, job.snapshot.scope)) throw new Error('memory build did not cover the requested prefix')
        signal.throwIfAborted()
        const installed = this.#load(job.actor), installedPrefix = this.archivePrefix(job.actor)
        if (installedPrefix >= job.prefix) {
          this.#counts.discarded++
          return 'discarded'
        }
        if (installed) this.#validate(installed, job.snapshot)
        const path = this.#path(job.actor)
        // Comparison and rename contain no await: a late result cannot replace a newer prefix.
        writeFileSync(path + '.tmp', JSON.stringify({ archive: result.archive, index: result.index, aliasHistory: job.input.aliasHistory }))
        renameSync(path + '.tmp', path)
        this.#counts.completed++
        return 'installed'
      }).then(event => {
        this.#trace({ event, buildId: job.id, actor: job.actor, prefix: job.prefix,
          atMs: Date.now(), buildWallMs: performance.now() - start, frozenWallMs: Date.now() - job.frozenAt })
      }).catch((error: unknown) => {
        job.failure = error
        const cancelled = signal.aborted
        if (cancelled) this.#counts.cancelled++; else this.#counts.failed++
        this.#trace({ event: cancelled ? 'cancelled' : 'failed', buildId: job.id, actor: job.actor, prefix: job.prefix,
          atMs: Date.now(), buildWallMs: performance.now() - start,
          errorType: error instanceof Error ? error.name : 'unknown' })
      }).finally(() => {
        this.#jobs.delete(key); this.#active--; job.finish(); this.#pump()
      })
    }
    if (this.#jobs.size === 0 && this.#startedAt !== null && this.#finishedAt === null) {
      this.#finishedAt = Date.now()
      this.#trace({ event: 'idle', atMs: this.#finishedAt, wallMs: this.#finishedAt - this.#startedAt, ...this.#counts })
    }
  }
}
