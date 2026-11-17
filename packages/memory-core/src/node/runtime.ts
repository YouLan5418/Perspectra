import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Tokenizer } from '@huggingface/tokenizers'
import type { WorldJsonObject, WorldJsonValue } from '@perspectra/sdk/contracts'
import {
  atomText,
  checkScope,
  checkSources,
  episodeText,
  list,
  object,
  rows,
  same,
  segments,
  text,
  validateUnits,
} from './archive.ts'
import { admit } from './admission.ts'
import { consolidate, group } from './episodes.ts'
import { queryProjection } from './queries.ts'
import { bindActivity, retrievalProjection } from './projections.ts'
import { buildIndex, recallQuality, type Encode } from './retrieval.ts'
import { retainPrefix } from './retain-prefix.ts'
import { createUtility, type MemoryModel } from './utility.ts'
import { deliver } from './delivery.ts'
import { createE5Worker } from './e5-client.ts'
import { coreE5WorkerEntry } from '../node-paths.ts'

const OBSERVATIONS_MISSION =
  '只形成证据支持的可修正认识，不把主持人的裁决改成独立核实的数值事实；不从一次猜错推断性格、智力或动机。'

export interface CoreRuntimeConfig {
  readonly model: MemoryModel
  readonly assetDirectory: string
  readonly e5WorkerEntry?: string
  readonly utilityAttemptsFile?: string
}

export interface CoreRuntime {
  run(input: WorldJsonObject, signal: AbortSignal): Promise<WorldJsonObject>
  close(): Promise<void>
}

function countKnownTicks(doc: WorldJsonObject): void {
  const known = new Map(checkSources(doc).map(source => [text(source.sourceId), Number(source.knownTick)]))
  for (const key of ['facts', 'episodes', 'observations'])
    for (const unit of rows(doc[key] ?? [])) {
      const ticks = rows(unit.sourceRefs).map(ref => {
        const tick = known.get(text(ref.sourceId))
        if (tick === undefined || !Number.isSafeInteger(tick) || tick < 0)
          throw new Error('Unit references a Source without a valid knowledge tick')
        return tick
      })
      if (!ticks.length) throw new Error('Unit without source knowledge ticks')
      unit.knownTickStart = Math.min(...ticks)
      unit.knownTickEnd = Math.max(...ticks)
    }
}

export function reprojectArchive(archive: WorldJsonObject): WorldJsonObject {
  const data = structuredClone(archive),
    sources = new Map(checkSources(data).map(source => [text(source.sourceId), source]))
  for (const atom of rows(data.facts)) {
    const evidence = object(atom.evidence)
    if (evidence.channel !== 'action') continue
    const source = sources.get(text(evidence.sourceId))
    if (!source) throw new Error('Action evidence source is missing')
    const part = segments(source).find(candidate => candidate.id === evidence.id)
    if (!part) throw new Error('Frozen action segment missing')
    atom.evidence = { ...part, sourceId: source.sourceId!, quote: part.context! }
    atom.evidenceQuote = part.context!
    atom.text = atomText(atom)
  }
  const canonical = new Map(rows(data.facts).map(atom => [text(atom.id), atom]))
  for (const unit of [...rows(data.episodes ?? []), ...rows(data.observations ?? [])]) {
    unit.eventAtoms = rows(unit.eventAtoms ?? []).map(atom => {
      const current = canonical.get(text(atom.id))
      if (!current) throw new Error('Aggregate evidence atom is missing')
      return structuredClone(current)
    })
    if (unit.memoryLevel === 'episode') unit.text = episodeText(rows(unit.eventAtoms))
  }
  const projected = bindActivity(data)
  validateUnits(projected)
  return projected
}

export function createCoreRuntime(config: CoreRuntimeConfig): CoreRuntime {
  const e5Entry = config.e5WorkerEntry
    ? config.e5WorkerEntry.startsWith('file:')
      ? new URL(config.e5WorkerEntry)
      : pathToFileURL(config.e5WorkerEntry)
    : coreE5WorkerEntry()
  let encoder = createE5Worker(config.assetDirectory, e5Entry),
    tokenizer: Tokenizer | undefined,
    activeSignal: AbortSignal | undefined,
    closed = false,
    running = false
  const close = async () => encoder.close()
  const countTokens = (value: string, prefix: 'query' | 'passage'): number => {
      tokenizer ??= new Tokenizer(
        JSON.parse(readFileSync(join(config.assetDirectory, 'tokenizer.json'), 'utf8')),
        JSON.parse(readFileSync(join(config.assetDirectory, 'tokenizer_config.json'), 'utf8')),
      )
      return tokenizer.encode(prefix + ': ' + value).ids.length
    },
    encode: Encode = async (values, query) => {
      const signal = activeSignal
      if (!signal) throw new Error('Core E5 request has no active signal')
      const current = encoder
      try {
        return (await current.encode(values, query, signal)).vectors
      } catch (error) {
        try {
          await current.close()
        } catch {
          // Preserve the failed encode as the request's error.
        }
        if (!closed && encoder === current) encoder = createE5Worker(config.assetDirectory, e5Entry)
        throw error
      }
    }

  const utility = (stage: string, input: WorldJsonObject, signal: AbortSignal) => {
    const scope = object(input.scope),
      metadata: WorldJsonObject = {
        stage,
        actor: scope.characterId!,
        asOfWorldSeq: scope.asOfWorldSeq!,
        ...(typeof input.buildId === 'string' ? { buildId: input.buildId } : {}),
      }
    return createUtility(config.model, signal, fetch, {
      ...(config.utilityAttemptsFile ? { tracePath: config.utilityAttemptsFile } : {}),
      metadata,
    })
  }

  const build = async (input: WorldJsonObject, signal: AbortSignal): Promise<WorldJsonObject> => {
    const original = structuredClone(checkSources(input)),
      scope = checkScope(input),
      previous =
        input.retainedPrefix === undefined || input.retainedPrefix === null ? undefined : object(input.retainedPrefix),
      identical = Boolean(previous && same(previous.scope!, scope) && same(previous.sources!, original))
    signal.throwIfAborted()
    let data: WorldJsonObject,
      grouping: WorldJsonValue[] = [],
      consolidation: WorldJsonValue[] = []
    if (identical) {
      validateUnits(previous!)
      data = structuredClone(previous!)
    } else {
      const retained = await retainPrefix(input, utility('retain', input, signal))
      signal.throwIfAborted()
      data = { ...retained, memoryGrain: 'episode', episodes: [], observations: [] }
      const grouped = await group(data, utility('group', input, signal))
      grouping = rows(grouped.actions)
      data = { ...data, episodes: grouped.episodes! }
      signal.throwIfAborted()
      const integrated = await consolidate(
        { ...data, observationsMission: OBSERVATIONS_MISSION },
        utility('consolidate', input, signal),
      )
      consolidation = rows(integrated.actions)
      data = { ...data, observations: integrated.observations! }
    }
    countKnownTicks(data)
    data = bindActivity(data)
    validateUnits(data)
    if (!same(data.sources!, original)) throw new Error('Source evidence changed during Core build')
    signal.throwIfAborted()
    const projected = retrievalProjection(data, value => countTokens(value, 'passage'), rows(input.aliasHistory ?? []))
    const index = await buildIndex(projected, encode)
    signal.throwIfAborted()
    return {
      archive: data,
      index,
      grouping,
      consolidation,
      reusedIdenticalArchive: identical,
    }
  }

  const recall = async (input: WorldJsonObject, signal: AbortSignal): Promise<WorldJsonObject> => {
    if (input.deliveryMode !== 'minimal')
      throw new Error(`Unsupported Core delivery mode: ${String(input.deliveryMode ?? 'missing')}`)
    const data = object(input.archive),
      index = structuredClone(object(input.index)),
      request = object(input.request),
      scope = checkScope(data),
      context = object(request.context)
    validateUnits(data)
    if (!same(index.scope!, scope) || object(context.character).characterId !== scope.characterId)
      throw new Error('Core recall scope mismatch')
    const cognition = context.cognition === undefined || context.cognition === null ? {} : object(context.cognition)
    if ('address' in cognition && !same(cognition.address!, scope.worldAddress!))
      throw new Error('Core recall scope mismatch')
    if (input.observations !== true) {
      const units = rows(index.units),
        vectors = list(index.vectors).map(vector => list(vector))
      if (units.length !== vectors.length) throw new Error('Invalid Core index vector mapping')
      const pairs = units
        .map((unit, i) => ({ unit, vector: vectors[i]! }))
        .filter(p => p.unit.projectionLevel !== 'observation')
      Object.assign(index, { units: pairs.map(p => p.unit), vectors: pairs.map(p => p.vector) })
    }
    signal.throwIfAborted()
    const aliases =
        index.retrievalAliases === undefined || index.retrievalAliases === null
          ? undefined
          : object(index.retrievalAliases),
      query = queryProjection(request, aliases, value => countTokens(value, 'query')),
      baseline = await recallQuality(index, scope, query, encode)
    signal.throwIfAborted()
    const admitted = admit(data, index, baseline, request, query),
      budget = input.deliveryBudget === undefined ? { maxItems: 3, maxJsonChars: 4500 } : object(input.deliveryBudget)
    if (
      Object.keys(budget).sort().join(',') !== 'maxItems,maxJsonChars' ||
      !Number.isSafeInteger(budget.maxItems) ||
      !Number.isSafeInteger(budget.maxJsonChars)
    )
      throw new Error('Invalid Core delivery budget')
    const delivered = deliver(
      data,
      admitted.candidates,
      request,
      Number(input.tick),
      query,
      Number(budget.maxItems),
      Number(budget.maxJsonChars),
    )
    return {
      query,
      baselineRetrieval: baseline,
      retrieval: { ...baseline, results: admitted.candidates },
      admission: admitted.trace,
      delivery: delivered.memories!,
      deliveryTrace: delivered.trace!,
      gateMode: 'none',
      jevCalls: 0,
    }
  }

  return {
    async run(input, signal) {
      if (closed) throw new Error('Core runtime is closed')
      if (running) throw new Error('Core runtime already has an active request')
      running = true
      try {
        signal.throwIfAborted()
        if (input.operation === 'build') {
          activeSignal = signal
          return await build(input, signal)
        }
        if (input.operation === 'reproject') return { archive: reprojectArchive(object(input.archive)) }
        if (input.operation === 'recall') {
          activeSignal = signal
          return await recall(input, signal)
        }
        throw new Error('Unknown Core operation')
      } finally {
        activeSignal = undefined
        running = false
      }
    },
    async close() {
      if (closed) return
      closed = true
      await close()
    },
  }
}

export async function runCore(
  input: WorldJsonObject,
  signal: AbortSignal,
  config: CoreRuntimeConfig,
): Promise<WorldJsonObject> {
  const runtime = createCoreRuntime(config)
  try {
    return await runtime.run(input, signal)
  } finally {
    await runtime.close()
  }
}
