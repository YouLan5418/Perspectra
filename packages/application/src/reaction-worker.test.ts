import { describe, expect, it } from 'vitest'
import { brandId, type ReactionCycleTerminalReason } from '@harness-world/contracts'
import { ReactionCycleWorker, type ReactionWaveRunner } from './reaction-worker.ts'

function wave(number: number, terminalReason: ReactionCycleTerminalReason | null = null) {
  return {
    cycleId: 'reaction-cycle:test',
    wave: number,
    roundId: brandId(`round:reaction:${number}`, 'InteractionRoundId'),
    transactionId: brandId(`transaction:reaction:${number}`, 'TransactionId'),
    headSeq: number,
    tick: number,
    terminalReason,
    actionCount: 0,
  } as const
}

describe('ReactionCycleWorker', () => {
  it('reports an idle lane without inventing a Cycle identity', async () => {
    const worker = new ReactionCycleWorker(
      { enqueueRound: work => work() },
      { runCurrentWave: () => Promise.resolve(undefined) },
    )
    await expect(worker.drain()).resolves.toEqual({ cycleId: null, waves: [] })
  })

  it('stops on the first durable terminal Wave', async () => {
    const results = [wave(1), wave(2, 'quiescent'), wave(3)]
    const runner: ReactionWaveRunner = { runCurrentWave: () => Promise.resolve(results.shift()) }
    const worker = new ReactionCycleWorker({ enqueueRound: work => work() }, runner)
    await expect(worker.drain()).resolves.toEqual({
      cycleId: 'reaction-cycle:test',
      waves: [wave(1), wave(2, 'quiescent')],
    })
    expect(results).toHaveLength(1)
  })

  it('fails closed if a Runner returns the same non-terminal Wave twice', async () => {
    const runner: ReactionWaveRunner = { runCurrentWave: () => Promise.resolve(wave(1)) }
    const worker = new ReactionCycleWorker({ enqueueRound: work => work() }, runner)
    await expect(worker.drain()).rejects.toThrow('same Wave twice')
  })
})
