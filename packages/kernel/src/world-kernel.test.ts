import { describe, expect, it } from 'vitest'
import { parsePlayerRoundResult } from './world-kernel.ts'

describe('WorldKernel', () => {
  it('strictly parses durable completed Round results', () => {
    const valid = {
      status: 'accepted',
      reason: null,
      headSeq: 1,
      tick: 1,
      bundleHash: `sha256:${'a'.repeat(64)}`,
    } as const
    expect(parsePlayerRoundResult(valid)).toEqual(valid)
    for (const invalid of [
      null,
      [],
      'result',
      { ...valid, extra: true },
      { ...valid, status: 'committed' },
      { ...valid, reason: 1 },
      { ...valid, headSeq: 1.5 },
      { ...valid, headSeq: -1 },
      { ...valid, tick: 1.5 },
      { ...valid, tick: -1 },
      { ...valid, bundleHash: null },
      { ...valid, bundleHash: 'sha256:short' },
    ]) expect(() => parsePlayerRoundResult(invalid as never)).toThrow(TypeError)
  })
})
