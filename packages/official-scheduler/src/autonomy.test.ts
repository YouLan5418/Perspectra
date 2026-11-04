import { expect, it, vi } from 'vitest'
import type { SchedulerRound } from '@harness-world/plugin-sdk'
import { runOfficialSchedule } from './index.ts'

it('uses the autonomous deadline for serial follow-up reactions when no shorter deadline was declared', async () => {
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => new AbortController().signal)
  try {
    const round: SchedulerRound = {
      phase: 'autonomy',
      characterIds: [],
      afterSeq: 0,
      signal: new AbortController().signal,
      world: {} as never,
      allowConcurrent: false,
      limits: { maximumWaves: 1, maximumNpcCalls: 4, maximumCallsPerCharacter: 2 },
      headSeq: () => 0,
      observationsSince: () => [],
      observationSeqs: () => [],
      presentCharacterIds: () => [],
      locationOf: () => null,
      turn: vi.fn(),
      autonomy: {
        roles: [],
        maximumNpcCalls: 3,
        deadlineSeconds: 60,
        reactionLimits: { maximumWaves: 1, maximumNpcCalls: 4, maximumCallsPerCharacter: 2 },
      },
    }
    await runOfficialSchedule(round)
    expect(timeout.mock.calls.map(([ms]) => ms)).toEqual([60_000, 60_000])
  } finally {
    timeout.mockRestore()
  }
})

it('allows an authorized follow-up reaction to finish after 35 seconds within the 60-second autonomous budget', async () => {
  vi.useFakeTimers()
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), ms)
    return controller.signal
  })
  try {
    let head = 0
    const a = 'character:a' as SchedulerRound['characterIds'][number]
    const b = 'character:b' as SchedulerRound['characterIds'][number]
    const result = runOfficialSchedule({
      phase: 'autonomy',
      characterIds: [b],
      afterSeq: 0,
      signal: new AbortController().signal,
      world: {} as never,
      allowConcurrent: false,
      limits: { maximumWaves: 1, maximumNpcCalls: 4, maximumCallsPerCharacter: 2 },
      headSeq: () => head,
      observationsSince: after => (head > after ? [{ seq: head, characterId: b, substantive: true }] : []),
      observationSeqs: () => [],
      presentCharacterIds: () => [b],
      locationOf: () => null,
      turn: async (id, options) => {
        if (id === a) {
          head = 1
          return { status: 'published', calls: 1 }
        }
        return new Promise(resolve => {
          const finish = (status: 'published' | 'interrupted') => resolve({ status, calls: 1 })
          setTimeout(() => finish('published'), 35_000)
          options.signal.addEventListener('abort', () => finish('interrupted'), { once: true })
        })
      },
      autonomy: {
        roles: [{ characterId: a, opportunities: 1 }],
        maximumNpcCalls: 3,
        deadlineSeconds: 60,
        reactionLimits: { maximumWaves: 1, maximumNpcCalls: 4, maximumCallsPerCharacter: 2 },
      },
    })
    await vi.advanceTimersByTimeAsync(35_000)
    const completed = await result
    expect(completed.terminalReason).toBe('quiescent')
    expect(completed.autonomy?.reactions?.activations[0]?.result.status).toBe('published')
  } finally {
    timeout.mockRestore()
    vi.clearAllTimers()
    vi.useRealTimers()
  }
})
