import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
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

/** Host adapter only. Python never receives a world path, pack variables or other roles' views. */
export class PlaytestMemoryCore {
  readonly #directory: string
  readonly #aliases = new Map<string, WorldJsonObject[]>()
  constructor(readonly dataDirectory: string, readonly address: WorldAddress, readonly run: CoreRunner) {
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
    const entries = (cached?.aliasHistory ?? []) as WorldJsonObject[]
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
        request: queryRequest, tick: snapshot.tick, observations: true, deliveryMode: 'minimal' }, signal)
      memories = result.delivery as WorldJsonObject[]
      if (!Array.isArray(memories) || memories.length > 3 || JSON.stringify(memories).length > 4500)
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
  async refresh(actors: readonly string[], signal: AbortSignal, progress: (index: number, total: number) => void): Promise<void> {
    for (const [i, actor] of actors.entries()) {
      signal.throwIfAborted(); progress(i + 1, actors.length)
      const snapshot = this.#snapshot(actor), cached = this.#load(actor)
      if (cached) this.#validate(cached, snapshot)
      const aliasHistory = this.#restoreAliases(actor, snapshot.scope, cached)
      const result = await this.run({ operation: 'build', ...snapshot, aliasHistory,
        ...(cached === undefined ? {} : { retainedPrefix: cached.archive! }) }, signal)
      this.#validate(result, snapshot)
      signal.throwIfAborted()
      const path = this.#path(actor)
      writeFileSync(path + '.tmp', JSON.stringify({ archive: result.archive, index: result.index, aliasHistory }))
      renameSync(path + '.tmp', path)
    }
  }
}
