import { describe, expect, it } from 'vitest'
import {
  brandId,
  failWorld,
  hashWorldJson,
  type CharacterContextBundle,
  type CognitiveMemoryEntry,
  type ContextSourceRef,
  type InteractionBlock,
} from '@harness-world/contracts'
import { CharacterContextBudgetPlanner } from './context-budget.ts'
import type { CharacterContextAssembly, CharacterContextRequest, ContextDigestEntry } from './context-v2.ts'
import type { RenderedProviderRequest } from './provider-request.ts'

function source(seq: number, id: string): ContextSourceRef {
  return { sourceKind: 'world_event', sourceId: id, sourceSeq: seq, sourceHash: hashWorldJson('source', { id }) }
}

function memory(index: number): CognitiveMemoryEntry {
  return {
    memoryId: `memory:${index}`, memoryKind: 'communication', epistemicKind: 'reported_speech',
    text: `memory ${index}`, metadata: {}, sourceRef: source(index + 1, `event:memory:${index}`),
    captureHash: hashWorldJson('capture', { index }),
  }
}

function block(index: number): InteractionBlock {
  const observationSource = source(index + 1, `event:tail:${index}`)
  const base = {
    schemaVersion: 'interaction-block/v1' as const,
    transactionId: brandId(`transaction:${index}`, 'TransactionId'),
    roundId: brandId(`round:${index}`, 'InteractionRoundId'),
    startSeq: observationSource.sourceSeq, endSeq: observationSource.sourceSeq, tick: index,
    observations: [{ observationId: `observation:${index}`, content: { text: `turn ${index}` }, sourceRef: observationSource }],
    authorityHash: null,
  }
  return { ...base, blockHash: hashWorldJson('interaction-block/v1', base) }
}

/**
 * The planner only reads the Context Profile, the Recall entries and the Tail blocks; assembly itself is
 * supplied by the caller, so the remaining request fields never reach this unit.
 */
function request(
  contextProfileId: 'compact' | 'standard' | 'deep',
  memoryCount: number,
  blockCount: number,
): CharacterContextRequest {
  return {
    contextProfileId,
    recall: { memories: Array.from({ length: memoryCount }, (_, index) => memory(index)) },
    tail: { blocks: Array.from({ length: blockCount }, (_, index) => block(index)) },
  } as unknown as CharacterContextRequest
}

function budgetRefusal(): never {
  return failWorld({
    errorCode: 'CONTEXT_WINDOW_EXCEEDED', category: 'provider',
    message: 'Exact Provider request exceeds the selected Context or Model Profile budget', retryable: false,
    correlationId: 'budget:test',
  })
}

/** A renderer that refuses the request until `fitsAfterDrops` items have been given up. */
function rendererFittingAt(fitsAfterDrops: number): {
  readonly assemble: (request: CharacterContextRequest) => CharacterContextAssembly
  readonly render: (bundle: CharacterContextBundle) => RenderedProviderRequest
  readonly assembled: readonly (CharacterContextRequest['budgetTrim'])[]
} {
  const assembled: (CharacterContextRequest['budgetTrim'])[] = []
  return {
    assembled,
    assemble: input => {
      assembled.push(input.budgetTrim)
      return { bundle: {} as CharacterContextBundle } as CharacterContextAssembly
    },
    render: () => {
      const dropped = assembled.length - 1
      if (dropped < fitsAfterDrops) budgetRefusal()
      return {} as RenderedProviderRequest
    },
  }
}

describe('CharacterContextBudgetPlanner', () => {
  it('renders the untrimmed request once when it already fits', () => {
    const fake = rendererFittingAt(0)
    const plan = new CharacterContextBudgetPlanner(fake.assemble, fake.render).plan(request('compact', 3, 3))
    expect(plan.rendered).toEqual({})
    expect(fake.assembled).toEqual([undefined])
  })

  it('gives up lowest-ranked Recall before whole Tail blocks', () => {
    const fake = rendererFittingAt(3)
    new CharacterContextBudgetPlanner(fake.assemble, fake.render).plan(request('standard', 4, 5))
    expect(fake.assembled).toEqual([
      undefined,
      { digestItems: 0, recallItems: 1, tailBlocks: 0 },
      { digestItems: 0, recallItems: 2, tailBlocks: 0 },
      { digestItems: 0, recallItems: 3, tailBlocks: 0 },
    ])
  })

  it('keeps dropping whole Tail blocks after Recall is exhausted', () => {
    const fake = rendererFittingAt(4)
    new CharacterContextBudgetPlanner(fake.assemble, fake.render).plan(request('standard', 2, 5))
    expect(fake.assembled).toEqual([
      undefined,
      { digestItems: 0, recallItems: 1, tailBlocks: 0 },
      { digestItems: 0, recallItems: 2, tailBlocks: 0 },
      { digestItems: 0, recallItems: 2, tailBlocks: 1 },
      { digestItems: 0, recallItems: 2, tailBlocks: 2 },
    ])
  })

  it('bounds the drops by the selected Context Profile, not by the raw request length', () => {
    const fake = rendererFittingAt(Number.MAX_SAFE_INTEGER)
    expect(() => new CharacterContextBudgetPlanner(fake.assemble, fake.render).plan(request('compact', 9, 7)))
      .toThrow('Exact Provider request exceeds')
    // compact keeps at most 6 Recall entries and 4 Tail blocks, and the final attempt rethrows.
    expect(fake.assembled).toHaveLength(11)
    expect(fake.assembled.at(-1)).toEqual({ digestItems: 0, recallItems: 6, tailBlocks: 4 })
  })

  it('gives up the earliest Rounds of the digest before any Recall entry', () => {
    const fake = rendererFittingAt(3)
    const base = request('standard', 4, 3)
    const digest: ContextDigestEntry[] = [1, 3, 5].map((seq, index) => ({
      summaryId: `memory-l1-summary/v1:${index}`, sourceStartSeq: seq, sourceEndSeq: seq + 1,
      summaryHash: hashWorldJson('digest-entry', index), text: `过去的第${index}段经历`, sourceRefs: [],
    }))
    new CharacterContextBudgetPlanner(fake.assemble, fake.render).plan({ ...base, digest })
    // The digest is the furthest-back content, so it is the first thing the frozen priority gives up.
    expect(fake.assembled).toEqual([
      undefined,
      { digestItems: 1, recallItems: 0, tailBlocks: 0 },
      { digestItems: 2, recallItems: 0, tailBlocks: 0 },
      { digestItems: 3, recallItems: 0, tailBlocks: 0 },
    ])
  })

  it('propagates a failure that no Tier 3/4 drop can resolve', () => {
    const unexpected = new TypeError('assembly is not available')
    const attempted: unknown[] = []
    const planner = new CharacterContextBudgetPlanner(
      input => {
        attempted.push(input)
        throw unexpected
      },
      () => ({} as RenderedProviderRequest),
    )
    expect(() => planner.plan(request('deep', 2, 2))).toThrow(unexpected)
    expect(attempted).toHaveLength(1)
  })

  it('does not retry a Provider refusal of another kind or from another category', () => {
    for (const failure of [
      () => failWorld({
        errorCode: 'MODEL_PROFILE_INCOMPATIBLE', category: 'provider',
        message: 'Model Profile cannot carry the Context Profile', retryable: false, correlationId: 'budget:other',
      }),
      () => failWorld({
        errorCode: 'MEMORY_CATCHUP_FAILED', category: 'runtime',
        message: 'Memory is behind the requested as-of', retryable: true, correlationId: 'budget:runtime',
      }),
    ]) {
      let renders = 0
      const planner = new CharacterContextBudgetPlanner(
        () => ({ bundle: {} as CharacterContextBundle } as CharacterContextAssembly),
        () => {
          renders += 1
          return failure()
        },
      )
      expect(() => planner.plan(request('deep', 2, 2))).toThrow()
      expect(renders).toBe(1)
    }
  })
})
