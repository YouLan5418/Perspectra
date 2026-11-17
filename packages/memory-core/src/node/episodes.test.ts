import { expect, it, vi } from 'vitest'
import type { WorldJsonObject } from '@perspectra/sdk/contracts'
import { object, rows, validateUnits } from './archive.ts'
import { consolidate, group, retain, type MemoryUtility } from './episodes.ts'
import { retainPrefix } from './retain-prefix.ts'

const scope = {
  worldAddress: { tenantId: 't', worldId: 'w', branchId: 'b' },
  characterId: 'character:friend',
  asOfWorldSeq: 20,
}
function source(seq: number, content: string, kind = 'reported_speech'): WorldJsonObject {
  return {
    sourceId: 'event:' + seq,
    sourceHash: 'hash:' + seq,
    worldSeq: seq,
    knownTick: seq,
    characterId: scope.characterId,
    worldAddress: scope.worldAddress,
    epistemicKind: kind,
    text: content,
  }
}
const noSelections: MemoryUtility = async () => ({ atoms: [] })

it('preserves a complete first sentence and its entity when evidence starts with whitespace', async () => {
  const data = await retain(
    { scope, sources: [source(1, 'character:player said: \n我把药留在 location:tea_room。明天再来喝茶。')] },
    async () => ({
      atoms: [
        { segment_id: 'event:1/part:0', quote: '我把药留在 location:tea_room。' },
        { segment_id: 'event:1/part:0', quote: '明天再来喝茶。' },
      ],
    }),
  )
  expect(rows(data.facts).map(a => a.evidenceQuote)).toEqual(['我把药留在 location:tea_room。', '明天再来喝茶。'])
  expect(rows(data.facts)[0]!.entities).toEqual(['location:tea_room'])
  expect(data.stats).toMatchObject({ rejectedSelections: 0, wholeSegmentFallbacks: 0 })
})

it('retains the entire negative sentence when a model selects a misleading fragment', async () => {
  const model = vi.fn(async () => ({ atoms: [{ segment_id: 'event:1/part:0', quote: '他来了。' }] }))
  const data = await retain({ scope, sources: [source(1, 'character:player said: 我不确定他来了。')] }, model)
  const atom = rows(data.facts)[0]!
  expect(atom.text).toContain('我不确定他来了。')
  expect(object(atom.evidence).channel).toBe('speech')
  expect(data.stats).toMatchObject({ rejectedSelections: 1, wholeSegmentFallbacks: 1 })
})
it('keeps adjudicated action status and public activity metadata apart from interpretation and private activity data', async () => {
  const model = vi.fn(noSelections)
  const content = JSON.stringify({
    actorId: 'character:player',
    actionType: 'interact',
    status: 'accepted',
    resultDescription: '活动结束。',
    resultMetadata: {
      activity: {
        id: 'activity:first',
        revision: 2,
        phase: 'ended',
        round: 1,
        active: false,
        lifecycle: 'ended',
        private: { answer: 73 },
      },
    },
    playerInput: { sourceText: '我已经拿走奖励。' },
    reason: '我赢了',
  })
  const data = await retain({ scope, sources: [source(1, content, 'observed_action')] }, model)
  expect(model).not.toHaveBeenCalled()
  const atom = rows(data.facts)[0]!
  expect(object(atom.evidence).executionStatus).toBe('accepted')
  expect(atom.text).toContain('活动结束。')
  expect(atom.text).not.toMatch(/answer|奖励|我赢了/)
  expect(rows(data.sources)[0]!.text).toBe(content)
})
it('rejects foreign or future evidence before calling a utility model', async () => {
  const model = vi.fn(noSelections),
    original = source(1, '本角色的经历')
  for (const changed of [
    { ...original, characterId: 'character:other' },
    { ...original, worldAddress: { ...scope.worldAddress, branchId: 'other' } },
    { ...original, worldSeq: 21 },
  ])
    await expect(retain({ scope, sources: [changed] }, model)).rejects.toThrow()
  expect(model).not.toHaveBeenCalled()
})
it('revises subjective understanding with the original counter-evidence and refuses rewritten aggregate evidence', async () => {
  const data = await retain(
    {
      scope,
      sources: [
        source(1, 'character:player said: 我泡了茶。'),
        source(2, 'character:player said: 刚才说错了，我没泡茶。'),
      ],
    },
    noSelections,
  )
  const ids = rows(data.facts).map(a => a.id!)
  const grouped = await group({ ...data, episodes: [], observations: [] }, async () => ({
    groups: [{ episode_id: null, label: '喝茶', atom_ids: ids }],
  }))
  const archived = { ...data, episodes: grouped.episodes!, observations: [] }
  const old = await consolidate(archived, async () => ({
    observations: [{ observation_id: null, text: '旅人声称泡茶。', supporting_atom_ids: [ids[0]!] }],
  }))
  const model = vi.fn<MemoryUtility>(async () => ({
    observations: [
      {
        observation_id: 'obs:1',
        text: '旅人否认原先说法，尚不能确认。',
        supporting_atom_ids: [ids[1]!],
        contradicting_atom_ids: [ids[0]!],
      },
    ],
  }))
  const result = await consolidate({ ...archived, observations: old.observations! }, model)
  expect(rows(result.observations)[0]).toMatchObject({
    epistemicKind: 'subjective_inference',
    contradictingAtomIds: [ids[0]],
  })
  const supplied = JSON.parse(model.mock.calls[0]![1]!) as {
    existingObservationsWithEvidence: { eventAtoms: { evidence: { context: string } }[] }[]
  }
  expect(supplied.existingObservationsWithEvidence[0]!.eventAtoms[0]!.evidence.context).toBe('我泡了茶。')
  const changed = structuredClone({ ...archived, observations: result.observations! })
  object(rows(rows(changed.episodes)[0]!.eventAtoms)[0]!.evidence).context = '我确实完成泡茶。'
  expect(() => validateUnits(changed)).toThrow('evidence context')
})
it('reuses an exact source prefix without new utility calls or changed Atom IDs', async () => {
  const sources = [source(1, 'character:player said: 我明天来。')],
    model = vi.fn(noSelections)
  const first = await retainPrefix({ scope, sources }, model)
  const again = await retainPrefix({ scope, sources, retainedPrefix: first }, model)
  expect(again.facts).toEqual(first.facts)
  expect(model).toHaveBeenCalledTimes(1)
  const next = await retainPrefix(
    { scope, sources: [...sources, source(2, 'character:friend said: 好的。')], retainedPrefix: first },
    model,
  )
  expect(rows(next.facts)[0]).toEqual(rows(first.facts)[0])
  expect(next.stats).toMatchObject({ reusedSources: 1, reusedAtoms: 1 })
  await expect(
    retainPrefix({ scope, sources: [{ ...sources[0]!, text: '新原文' }], retainedPrefix: first }, model),
  ).rejects.toThrow('prefix changed')
  expect(model).toHaveBeenCalledTimes(2)
})
it('keeps parallel retain results in source order while respecting the configured concurrency', async () => {
  const releases: (() => void)[] = [],
    calls: string[] = []
  const utility: MemoryUtility = async (_, user) => {
    calls.push(user)
    await new Promise<void>(done => releases.push(done))
    return { atoms: [] }
  }
  const pending = retainPrefix(
    { scope, sources: [1, 2, 3].map(n => source(n, '经历' + n)), retainConcurrency: 2 },
    utility,
    1,
  )
  expect(releases).toHaveLength(2)
  releases[1]!()
  await vi.waitFor(() => expect(releases).toHaveLength(3))
  releases[2]!()
  releases[0]!()
  const result = await pending
  expect(rows(result.facts).map(a => a.id)).toEqual(['atom:event:1:0', 'atom:event:2:0', 'atom:event:3:0'])
  expect(calls).toHaveLength(3)
})
it('stops assigning batches after a failure and settles active calls before rejecting', async () => {
  const controls: { resolve: (v: WorldJsonObject) => void; reject: (e: Error) => void }[] = []
  const utility: MemoryUtility = () => new Promise((resolve, reject) => controls.push({ resolve, reject }))
  const pending = retainPrefix(
    { scope, sources: [1, 2, 3].map(n => source(n, '经历' + n)), retainConcurrency: 2 },
    utility,
    1,
  )
  let settled = false
  const rejection = expect(
    pending.finally(() => {
      settled = true
    }),
  ).rejects.toThrow('utility failed')
  expect(controls).toHaveLength(2)
  controls[0]!.reject(new Error('utility failed'))
  await new Promise(done => setTimeout(done, 10))
  expect(settled).toBe(false)
  controls[1]!.resolve({ atoms: [] })
  await rejection
  expect(controls).toHaveLength(2)
})
