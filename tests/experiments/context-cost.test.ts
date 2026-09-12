import { describe, expect, it } from 'vitest'
import {
  ContextCostTracker,
  cacheBreakpointIndex,
  estimateCostCny,
  estimateTokens,
  segmentNameOf,
  summarizeContextCost,
  type ProviderMessageLike,
} from './context-cost.ts'

function message(segmentKind: string, content: string): ProviderMessageLike {
  return { role: 'user', content: JSON.stringify({ segmentKind, content }) }
}

function context(digest: string, tail: string, checkpoint: number): ProviderMessageLike[] {
  return [
    { role: 'system', content: '{"schemaVersion":"host-protocol/v1"}' },
    { role: 'developer', content: '{"schemaVersion":"character-controller-contract/v2"}' },
    message('world_public_anchor', '{"title":"Station"}'),
    message('character_anchor', '{"name":"Alice"}'),
    { role: 'user', content: JSON.stringify({ segmentKind: 'continuity_checkpoint', content: { checkpoint: { asOfWorldSeq: checkpoint }, digest } }) },
    message('recent_interaction_tail', tail),
  ]
}

describe('estimateTokens', () => {
  it('counts CJK and other characters at their own rates', () => {
    // Six CJK characters are about four tokens; six ASCII characters are under two.
    expect(estimateTokens('雨天路上的人')).toBe(4)
    expect(estimateTokens('abcdef')).toBe(2)
    expect(estimateTokens('a雨')).toBe(1)
    expect(estimateTokens('')).toBe(0)
  })
})

describe('segmentNameOf', () => {
  it('names the two fixed contracts and parses the rest', () => {
    expect(segmentNameOf({ role: 'system', content: '{}' }, 0)).toBe('host_protocol')
    expect(segmentNameOf({ role: 'developer', content: '{}' }, 1)).toBe('controller_contract')
    expect(segmentNameOf(message('verified_recall', '[]'), 8)).toBe('verified_recall')
  })

  it('falls back to the index for content that does not parse', () => {
    expect(segmentNameOf({ role: 'user', content: 'not json' }, 6)).toBe('message:6')
    expect(segmentNameOf({ role: 'user', content: '{"content":1}' }, 7)).toBe('message:7')
  })
})

describe('cacheBreakpointIndex', () => {
  it('stops at the first message that changed', () => {
    const previous = context('a', 'b', 10)
    expect(cacheBreakpointIndex(previous, previous)).toBe(6)
    // The fifth message is where the Continuity baseline differs.
    expect(cacheBreakpointIndex(previous, context('z', 'b', 10))).toBe(4)
    expect(cacheBreakpointIndex([], previous)).toBe(0)
    expect(cacheBreakpointIndex(previous, previous.slice(0, 3))).toBe(3)
  })
})

describe('ContextCostTracker', () => {
  it('reports no reusable prefix on a character\u2019s first call', () => {
    const tracker = new ContextCostTracker()
    const cost = tracker.record({ roundId: 'round:1', participantId: 'agent:alice', tick: 1, messages: context('a', 'b', 10) })
    expect(cost).toMatchObject({
      cachedTokens: 0, hitRate: 0, breakpointMessageIndex: 0, breakpointSegment: 'host_protocol',
      checkpointAsOfWorldSeq: 10, checkpointAdvanced: false,
    })
    expect(cost.missedTokens).toBe(cost.totalTokens)
    expect(cost.newTokens).toBe(cost.totalTokens)
  })

  it('reuses everything when nothing changed, and reports from the breakpoint when something did', () => {
    const tracker = new ContextCostTracker()
    const first = context('a', 'b', 10)
    tracker.record({ roundId: 'round:1', participantId: 'agent:alice', tick: 1, messages: first })
    const identical = tracker.record({ roundId: 'round:1b', participantId: 'agent:alice', tick: 1, messages: first })
    expect(identical.hitRate).toBe(1)
    expect(identical.newTokens).toBe(0)

    const moved = tracker.record({
      roundId: 'round:2', participantId: 'agent:alice', tick: 2, messages: context('a2', 'b2', 20),
    })
    expect(moved.breakpointMessageIndex).toBe(4)
    expect(moved.breakpointSegment).toBe('continuity_checkpoint')
    // The four messages before the continuity segment are the reusable prefix.
    expect(moved.cachedTokens).toBe(first.slice(0, 4).reduce((sum, value) => sum + estimateTokens(value.content), 0))
    expect(moved.checkpointAsOfWorldSeq).toBe(20)
    expect(moved.checkpointAdvanced).toBe(true)
  })

  it('tracks characters apart and forgets on reset', () => {
    const tracker = new ContextCostTracker()
    const alice = context('a', 'b', 10)
    tracker.record({ roundId: 'round:1', participantId: 'agent:alice', tick: 1, messages: alice })
    // Bob has no previous call of his own, so nothing is reusable for him.
    const bob = tracker.record({ roundId: 'round:1', participantId: 'agent:bob', tick: 1, messages: alice })
    expect(bob.cachedTokens).toBe(0)
    tracker.reset()
    const afterReset = tracker.record({ roundId: 'round:2', participantId: 'agent:alice', tick: 2, messages: alice })
    expect(afterReset.cachedTokens).toBe(0)
  })
})

describe('summarizeContextCost', () => {
  it('rolls calls into one picture', () => {
    const tracker = new ContextCostTracker()
    const costs = [
      tracker.record({ roundId: 'round:1', participantId: 'agent:alice', tick: 1, messages: context('a', 'b', 10) }),
      tracker.record({ roundId: 'round:2', participantId: 'agent:alice', tick: 2, messages: context('a', 'b', 10) }),
      tracker.record({ roundId: 'round:3', participantId: 'agent:alice', tick: 3, messages: context('a', 'b', 30) }),
    ]
    const summary = summarizeContextCost(costs)
    // The second call is byte-identical, so it has no breakpoint at all.
    expect(summary).toMatchObject({
      calls: 3, checkpointRebuilds: 1, breakpointSegments: ['continuity_checkpoint', 'host_protocol', 'none'],
    })
    expect(summary.hitRate).toBeGreaterThan(0.5)
    expect(summary.totalTokens).toBe(summary.cachedTokens + summary.missedTokens)
    expect(summarizeContextCost([])).toMatchObject({ calls: 0, hitRate: 0, medianNewTokens: 0 })
  })
})

describe('estimateCostCny', () => {
  it('prices a DeepSeek Flash call, with the off-peak half applied to everything', () => {
    // One million missed input tokens at 2 CNY, one million cached at 0.04, one million output at 8.
    expect(estimateCostCny({ missedTokens: 1_000_000, cachedTokens: 1_000_000, outputTokens: 1_000_000 }))
      .toBeCloseTo(10.04, 5)
    expect(estimateCostCny({ missedTokens: 1_000_000, cachedTokens: 1_000_000, outputTokens: 1_000_000, offPeak: true }))
      .toBeCloseTo(5.02, 5)
    expect(estimateCostCny({ missedTokens: 0, cachedTokens: 0, outputTokens: 0 })).toBe(0)
  })
})
