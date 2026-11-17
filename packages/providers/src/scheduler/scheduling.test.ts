import { afterEach, expect, it, vi } from 'vitest'
import { brandId } from '@perspectra/sdk/contracts'
import type { SchedulerRound, SchedulerTurnOptions } from '@perspectra/sdk'
import { runOfficialSchedule } from './index.ts'
import type { OpportunityRound } from './opportunity-round.ts'

const ids = ['A', 'B', 'C', 'D'].map(id => brandId(`character:${id}`, 'CharacterId'))
const [a, b, c, d] = ids as [(typeof ids)[number], (typeof ids)[number], (typeof ids)[number], (typeof ids)[number]]
const limits = { maximumWaves: 3, maximumNpcCalls: 8, maximumCallsPerCharacter: 2, reactionDeadlineSeconds: 30 }
const round = (overrides: Partial<OpportunityRound> = {}): SchedulerRound => ({
  phase: 'scene',
  characterIds: ids,
  afterSeq: 0,
  signal: new AbortController().signal,
  limits,
  allowConcurrent: true,
  world: {} as SchedulerRound['world'],
  headSeq: () => 1,
  observationsSince: after => (after < 1 ? ids.map(characterId => ({ seq: 1, characterId, substantive: true })) : []),
  observationSeqs: () => [1],
  presentCharacterIds: () => [a, c, d],
  locationOf: id => (id === b ? 'back' : 'front'),
  turn: async () => ({ status: 'published', calls: 1, asOfWorldSeq: 1 }),
  ...overrides,
  ...(overrides.autonomy
    ? {
        wakeups: () =>
          overrides.autonomy!.roles.map(role => ({
            ...role,
            sourceIds: ['test:wakeup'],
            stimulusSeqs: overrides.autonomy!.stimuli?.get(role.characterId) ?? [],
          })),
        opportunityLimits: overrides.autonomy,
      }
    : {}),
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

it('keeps explicit wakeup stimuli when their overlapping ordinary source expires', async () => {
  vi.useFakeTimers()
  vi.spyOn(AbortSignal, 'timeout').mockImplementation(milliseconds => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), milliseconds)
    return controller.signal
  })
  const seen: { id: string; seqs: readonly number[] }[] = []
  const run = runOfficialSchedule(
    round({
      characterIds: [a, b],
      initialCounts: new Map([[b, 1]]),
      headSeq: () => 2,
      presentCharacterIds: () => [a, b],
      locationOf: () => 'front',
      limits: { ...limits, reactionDeadlineSeconds: 1 },
      observationsSince: after =>
        after < 1
          ? [
              { seq: 1, characterId: a, substantive: true },
              { seq: 2, characterId: b, substantive: true },
            ]
          : [],
      wakeups: () => [{ characterId: b, opportunities: 1, sourceIds: ['script'], stimulusSeqs: [2] }],
      opportunityLimits: { maximumNpcCalls: 2, deadlineSeconds: 30, reactionLimits: limits },
      turn: async (id, options) => {
        seen.push({ id, seqs: options.stimulusSeqs })
        if (id === a) {
          await new Promise<void>(done => options.signal.addEventListener('abort', () => done(), { once: true }))
          return { status: 'interrupted', calls: 1, asOfWorldSeq: 2 }
        }
        return { status: 'published', calls: 1, asOfWorldSeq: 2 }
      },
    }),
  )
  await vi.advanceTimersByTimeAsync(1001)
  const result = await run
  expect(seen).toEqual([
    { id: a, seqs: [1] },
    { id: b, seqs: [2] },
  ])
  expect(result.calls).toBe(1)
  expect(result.autonomy?.autonomousCalls).toBe(1)
  expect(result.terminalReason).toBe('interrupted')
})

it.each([
  { allowConcurrent: true, staged: false },
  { allowConcurrent: false, staged: false },
  { allowConcurrent: true, staged: true },
])(
  'merges explicit wakeup stimuli without duplicate delivery ($allowConcurrent/$staged)',
  async ({ allowConcurrent, staged }) => {
    const offered: SchedulerTurnOptions[] = []
    const result = await runOfficialSchedule(
      round({
        characterIds: [a],
        headSeq: () => 2,
        allowConcurrent,
        observationsSince: after => (after < 1 ? [{ seq: 1, characterId: a, substantive: true }] : []),
        wakeups: () => [{ characterId: a, opportunities: 1, sourceIds: ['script'], stimulusSeqs: [1, 2] }],
        opportunityLimits: { maximumNpcCalls: 2, deadlineSeconds: 30, reactionLimits: limits, staged },
        turn: async (_id, options) => {
          offered.push(options)
          return { status: 'published', calls: 1, asOfWorldSeq: 2 }
        },
      }),
    )
    expect(offered).toHaveLength(1)
    expect(offered[0]?.stimulusSeqs).toEqual([1, 2])
    expect(result.calls).toBe(1)
    expect(result.autonomy?.autonomousCalls).toBe(0)
    expect(result.terminalReason).toBe('quiescent')
  },
)

it.each([1, 2])(
  'finishes a %s-call foreground reply before slow background work without extra calls',
  async finalCalls => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const finished: { id: string; at: number }[] = []
    const started = Date.now()
    const run = runOfficialSchedule(
      round({
        turn: async (id, options) => {
          const calls = id === b ? 1 : id === d ? finalCalls : 2
          expect(options.maxModelCalls).toBeGreaterThanOrEqual(calls)
          await new Promise(resolve => setTimeout(resolve, id === b ? 1000 : 10))
          finished.push({ id, at: Date.now() - started })
          return { status: 'published', calls, asOfWorldSeq: 1 }
        },
      }),
    )
    await vi.advanceTimersByTimeAsync(1100)
    const result = await run
    expect(finished.find(entry => entry.id === d)!.at).toBe(30)
    expect(finished.find(entry => entry.id === b)!.at).toBe(1000)
    expect(result.calls).toBe(5 + finalCalls)
    expect(result.terminalReason).toBe('quiescent')
  },
)

it.each([true, false])(
  'uses a final call for expression without an unfinishable action (concurrent=%s)',
  async allowConcurrent => {
    const offered: SchedulerTurnOptions[] = []
    const result = await runOfficialSchedule(
      round({
        characterIds: [a],
        allowConcurrent,
        observationsSince: () => [{ seq: 1, characterId: a, substantive: true }],
        limits: { ...limits, maximumNpcCalls: 1 },
        turn: async (_id, options) => {
          offered.push(options)
          return { status: 'published', calls: 1 }
        },
      }),
    )
    expect(offered).toHaveLength(1)
    expect(offered[0]).toMatchObject({ maxCalls: 1, maxModelCalls: 1 })
    expect(result.calls).toBe(1)
  },
)

it.each([true, false])(
  'keeps observed due roles responsive with an exhausted autonomy budget (concurrent=%s)',
  async allowConcurrent => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const handled: string[] = []
    const result = await runOfficialSchedule(
      round({
        characterIds: [a, b],
        allowConcurrent,
        observationsSince: after =>
          after < 1 ? [a, b].map(characterId => ({ seq: 1, characterId, substantive: true })) : [],
        presentCharacterIds: () => [a, b],
        locationOf: () => 'front',
        autonomy: {
          roles: [a, b].map(characterId => ({ characterId, opportunities: 1 })),
          maximumNpcCalls: 0,
          deadlineSeconds: 30,
          stimuli: new Map(),
          reactionLimits: { ...limits, maximumWaves: 1, maximumNpcCalls: 4 },
        },
        turn: async id => {
          handled.push(id)
          return { status: 'published', calls: 2, asOfWorldSeq: 1 }
        },
      }),
    )
    expect(handled.sort()).toEqual([a, b].sort())
    expect(result.calls).toBe(4)
    expect(result.autonomy?.autonomousCalls).toBe(0)
  },
)

it('keeps an unobserved autonomous role on its own budget and does not give it another actor stimulus', async () => {
  const seen: { id: string; seqs: readonly number[] }[] = []
  const result = await runOfficialSchedule(
    round({
      characterIds: [a, b],
      observationsSince: after => (after < 1 ? [{ seq: 1, characterId: a, substantive: true }] : []),
      autonomy: {
        roles: [{ characterId: b, opportunities: 1 }],
        maximumNpcCalls: 2,
        deadlineSeconds: 30,
        stimuli: new Map(),
        reactionLimits: { ...limits, maximumWaves: 0, maximumNpcCalls: 0 },
      },
      turn: async (id, options) => {
        seen.push({ id, seqs: options.stimulusSeqs })
        return { status: 'abstained', calls: 1, asOfWorldSeq: 1 }
      },
    }),
  )
  expect(seen).toContainEqual({ id: b, seqs: [] })
  expect(result.calls).toBe(1)
  expect(result.autonomy?.autonomousCalls).toBe(1)
})

it('can use an overlapping autonomous opportunity when the ordinary budget is exhausted', async () => {
  const handled: SchedulerTurnOptions[] = []
  const result = await runOfficialSchedule(
    round({
      characterIds: [a],
      limits: { ...limits, maximumNpcCalls: 0 },
      observationsSince: after => (after < 1 ? [{ seq: 1, characterId: a, substantive: true }] : []),
      autonomy: {
        roles: [{ characterId: a, opportunities: 1 }],
        maximumNpcCalls: 2,
        deadlineSeconds: 30,
        stimuli: new Map(),
        reactionLimits: { ...limits, maximumWaves: 0, maximumNpcCalls: 0 },
      },
      turn: async (_id, options) => {
        handled.push(options)
        return { status: 'published', calls: 1, asOfWorldSeq: 1 }
      },
    }),
  )
  expect(handled).toHaveLength(1)
  expect(result.autonomy?.autonomousCalls).toBe(1)
  expect(result.calls).toBe(0)
})

it('preserves the original budget and one opportunity across an autonomous stale retry', async () => {
  let head = 0
  const handled: SchedulerTurnOptions[] = []
  const result = await runOfficialSchedule(
    round({
      characterIds: [b],
      headSeq: () => head,
      observationsSince: after => (after < head ? [{ seq: head, characterId: b, substantive: true }] : []),
      autonomy: {
        roles: [{ characterId: b, opportunities: 1 }],
        maximumNpcCalls: 4,
        deadlineSeconds: 30,
        stimuli: new Map(),
        reactionLimits: { ...limits, maximumWaves: 1, maximumNpcCalls: 4 },
      },
      turn: async (_id, options) => {
        handled.push(options)
        if (handled.length === 1) {
          head = 1
          options.onCommitted?.(0, head)
          return { status: 'stale', calls: 1, asOfWorldSeq: 0 }
        }
        return { status: 'published', calls: 2, asOfWorldSeq: head }
      },
    }),
  )
  expect(handled).toHaveLength(2)
  expect(result.autonomy?.autonomousCalls).toBe(3)
  expect(result.calls).toBe(0)
})

it('allows later observations after a due role has consumed its autonomous opportunity', async () => {
  let head = 0
  let release!: () => void
  const barrier = new Promise<void>(resolve => {
    release = resolve
  })
  const handled: string[] = []
  const result = await runOfficialSchedule(
    round({
      characterIds: [a, b],
      headSeq: () => head,
      observationsSince: after => (after < head ? [{ seq: head, characterId: b, substantive: true }] : []),
      autonomy: {
        roles: [a, b].map(characterId => ({ characterId, opportunities: 1 })),
        maximumNpcCalls: 6,
        deadlineSeconds: 30,
        stimuli: new Map(),
        reactionLimits: { ...limits, maximumWaves: 1, maximumNpcCalls: 4 },
      },
      turn: async (id, options) => {
        handled.push(`${id}`)
        if (id === a) {
          await barrier
          await new Promise<void>(resolve => setImmediate(resolve))
          head = 1
          options.onCommitted?.(0, head)
        } else release()
        return { status: 'published', calls: 1, asOfWorldSeq: head }
      },
    }),
  )
  expect(handled.filter(entry => entry === b)).toHaveLength(2)
  expect(result.autonomy?.reactionCalls).toBe(1)
})

it('does not restart a serial stale action in autonomy while other autonomous roles can continue', async () => {
  const handled: string[] = []
  const result = await runOfficialSchedule(
    round({
      characterIds: [a, b],
      allowConcurrent: false,
      observationsSince: after => (after < 1 ? [{ seq: 1, characterId: a, substantive: true }] : []),
      observationSeqs: () => [],
      autonomy: {
        roles: [a, b].map(characterId => ({ characterId, opportunities: 2 })),
        maximumNpcCalls: 8,
        deadlineSeconds: 30,
        stimuli: new Map(),
        reactionLimits: { ...limits, maximumWaves: 0, maximumNpcCalls: 0 },
      },
      turn: async id => {
        handled.push(id)
        return id === a
          ? {
              status: 'stale',
              calls: 2,
              asOfWorldSeq: 1,
              performResult: {
                status: 'accepted',
                operationId: 'operation:moved',
                action: { actionType: 'move', parameters: { locationId: 'back' } },
              },
            }
          : { status: 'abstained', calls: 1, asOfWorldSeq: 1 }
      },
    }),
  )
  expect(handled.filter(id => id === a)).toHaveLength(1)
  expect(handled).toContain(b)
  expect(result.terminalReason).toBe('interrupted')
})
