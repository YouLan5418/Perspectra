import { brandId, type WorldAddress } from '@perspectra/sdk/contracts'
import { expect, it, vi } from 'vitest'
import type { WakeupSource } from '@perspectra/sdk'
import { createSchedulerRound } from '../../packages/core/src/application/scheduler-round.ts'

const a = brandId('character:a', 'CharacterId'),
  b = brandId('character:b', 'CharacterId')
const spoken = {
  value: { observerId: a, content: { status: 'accepted', actorId: 'character:p', speech: speech('你好') } },
}
const silent = {
  value: { observerId: b, content: { status: 'accepted', actorId: 'character:p', speech: speech(' ') } },
}
const addressed = {
  value: {
    observerId: b,
    content: { status: 'accepted', actorId: 'character:p', speech: { ...speech(' '), addresseeIds: [b] } },
  },
}
const plain = { value: { observerId: a, content: { status: 'accepted', actorId: 'character:p' } } }
const rejected = { value: { observerId: a, content: { status: 'rejected', actorId: 'character:p' } } }
const own = { value: { observerId: a, content: { status: 'accepted', actorId: a } } }
const passive = { ...plain, sceneReaction: false }
const events = [spoken, silent, addressed, plain, rejected, own, passive].map((data, index) => ({
  seq: index + 1,
  eventType: 'observation.upsert',
  data,
}))

function speech(text: string) {
  return { segments: [{ type: 'speech', text }] }
}

function setup(wakeupSources: readonly WakeupSource[] = [], onWakeupWarning = vi.fn()) {
  const calls: Record<string, unknown>[] = []
  const store = {
    head: () => ({ headSeq: events.length }),
    readEventsRange: (_address: unknown, after: number, through: number) =>
      events.filter(event => event.seq > after && event.seq <= through),
  }
  const round = createSchedulerRound({
    store: store as never,
    address: {} as WorldAddress,
    turn: {
      run: async (_id: unknown, options: Record<string, unknown>) => {
        calls.push(options)
        return { status: 'published', calls: 1 }
      },
    } as never,
    afterSeq: 0,
    characterIds: [a, b],
    signal: new AbortController().signal,
    limits: { maximumWaves: 3, maximumNpcCalls: 8, maximumCallsPerCharacter: 2 },
    allowConcurrent: true,
    world: {} as never,
    wakeupSources,
    onWakeupWarning,
    opportunityLimits: {
      maximumNpcCalls: 2,
      deadlineSeconds: 5,
      reactionLimits: { maximumWaves: 1, maximumNpcCalls: 2, maximumCallsPerCharacter: 1 },
    },
  })
  return { round, calls, onWakeupWarning, signal: new AbortController().signal }
}

it('reports accepted observations from others and marks silent ones', () => {
  const { round } = setup()
  expect(round.observationsSince(0, round.headSeq())).toEqual([
    { seq: 1, characterId: a, substantive: true },
    { seq: 2, characterId: b, substantive: false },
    { seq: 3, characterId: b, substantive: true },
    { seq: 4, characterId: a, substantive: true },
  ])
})

it('passes the exact observation values to the turn, even for a sequence not listed yet', async () => {
  const { round, calls, signal } = setup()
  await round.turn(a, { signal, stimulusSeqs: [1, 4], maxCalls: 2 })
  expect(calls[0]!.stimulus).toEqual([spoken.value, plain.value])
})

it('keeps a passive observation available to a separate authorized wakeup source', async () => {
  const { round, calls, signal } = setup([{ id: 'explicit', nominate: () => [{ characterId: a, stimulusSeqs: [7] }] }])
  expect(round.observationsSince(6, 7)).toEqual([])
  expect(round.wakeups!()).toEqual([{ characterId: a, stimulusSeqs: [7], opportunities: 1, sourceIds: ['explicit'] }])
  await round.turn(a, { signal, stimulusSeqs: [7], maxCalls: 2 })
  expect(calls[0]!.stimulus).toEqual([passive.value])
})

it("refuses another character's observation before any model work", async () => {
  const { round, calls, signal } = setup()
  await expect(round.turn(a, { signal, stimulusSeqs: [2], maxCalls: 2 })).rejects.toThrow(TypeError)
  expect(calls).toEqual([])
})

it('uses the same controlled turn for an observation and an empty-stimulus opportunity', async () => {
  const { round, calls, signal } = setup()
  await round.turn(a, { signal, stimulusSeqs: [], maxCalls: 2 })
  await round.turn(a, { signal, stimulusSeqs: [1], maxCalls: 2 })
  expect(calls).toHaveLength(2)
  expect(calls.map(call => call.stimulus)).toEqual([[], [spoken.value]])
})

it('merges sources once without multiplying the same character opportunity and removes them after settlement', () => {
  const first = vi.fn(() => [{ characterId: a, stimulusSeqs: [1], opportunities: 1 }])
  const second = vi.fn(() => [{ characterId: a, stimulusSeqs: [1, 4], opportunities: 2 }])
  const { round } = setup([
    { id: 'source:first', nominate: first },
    { id: 'source:second', nominate: second },
  ])
  expect(round.wakeups!()).toEqual([
    { characterId: a, stimulusSeqs: [1, 4], opportunities: 2, sourceIds: ['source:first', 'source:second'] },
  ])
  expect(round.wakeups!()).toHaveLength(1)
  expect(first).toHaveBeenCalledOnce()
  expect(second).toHaveBeenCalledOnce()
  expect(round.forReactions(6).wakeups!()).toEqual([])
  expect(first).toHaveBeenCalledOnce()
})

it('drops a faulty optional source completely and warns without accepting another characters stimulus', () => {
  const { round, onWakeupWarning } = setup([
    {
      id: 'source:invalid',
      nominate: () => [
        { characterId: a, stimulusSeqs: [1] },
        { characterId: a, stimulusSeqs: [2] },
      ],
    },
    {
      id: 'source:throws',
      nominate: () => {
        throw new Error('PRIVATE_PLUGIN_TEXT')
      },
    },
    { id: 'source:valid', nominate: () => [{ characterId: b, stimulusSeqs: [2] }] },
  ])
  expect(round.wakeups!()).toEqual([
    { characterId: b, stimulusSeqs: [2], opportunities: 1, sourceIds: ['source:valid'] },
  ])
  expect(onWakeupWarning).toHaveBeenCalledTimes(2)
  expect(JSON.stringify(onWakeupWarning.mock.calls)).not.toContain('PRIVATE_PLUGIN_TEXT')
})
