import { brandId, type WorldAddress } from '@harness-world/contracts'
import { expect, it } from 'vitest'
import { createSchedulerRound } from '../../packages/application/src/scheduler-round.ts'

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
const events = [spoken, silent, addressed, plain, rejected, own].map((data, index) => ({
  seq: index + 1,
  eventType: 'observation.upsert',
  data,
}))

function speech(text: string) {
  return { segments: [{ type: 'speech', text }] }
}

function setup() {
  const calls: Record<string, unknown>[] = [],
    autonomyCalls: unknown[] = []
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
    autonomy: {
      turn: {
        run: async (_id: unknown, options: unknown) => {
          autonomyCalls.push(options)
          return { status: 'published', calls: 1 }
        },
      } as never,
      roles: [],
      maximumNpcCalls: 2,
      deadlineSeconds: 5,
      reactionLimits: { maximumWaves: 1, maximumNpcCalls: 2, maximumCallsPerCharacter: 1 },
    },
  })
  return { round, calls, autonomyCalls, signal: new AbortController().signal }
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

it("refuses another character's observation before any model work", async () => {
  const { round, calls, signal } = setup()
  await expect(round.turn(a, { signal, stimulusSeqs: [2], maxCalls: 2 })).rejects.toThrow(TypeError)
  expect(calls).toEqual([])
})

it('uses the autonomy turn for autonomous opportunities', async () => {
  const { round, calls, autonomyCalls, signal } = setup()
  await round.turn(a, { kind: 'autonomous', signal, stimulusSeqs: [], maxCalls: 2 })
  expect(autonomyCalls).toHaveLength(1)
  expect(calls).toEqual([])
})
