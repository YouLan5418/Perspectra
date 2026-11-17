import { expect, it } from 'vitest'
import type { WorldJsonObject } from '@perspectra/sdk/contracts'
import { rows, text } from './archive.ts'
import { retain, group, consolidate } from './episodes.ts'
import { bindActivity } from './projections.ts'
import { deliver } from './delivery.ts'
import { admit, seedsFor } from './admission.ts'

const scope = {
  worldAddress: { tenantId: 't', worldId: 'w', branchId: 'b' },
  characterId: 'character:friend',
  asOfWorldSeq: 10,
}
const request = {
  context: {
    character: { characterId: 'character:friend' },
    scene: { locationId: 'location:tea' },
    items: { current: [] },
    observations: [],
    selfObservations: [],
  },
}
const query = { originalText: '明天来喝茶吗', entitySeeds: [], requiredEntityIds: [], mode: 'search' }
async function fixture(sourceIds = ['event:0', 'event:1']): Promise<WorldJsonObject> {
  const sources = ['character:player said: 我明天来喝茶。', 'character:player said: 我改主意了，明天不来。'].map(
    (value, i) => ({
      sourceId: sourceIds[i]!,
      sourceHash: 'hash:' + i,
      worldSeq: i,
      knownTick: i,
      characterId: scope.characterId,
      worldAddress: scope.worldAddress,
      epistemicKind: 'reported_speech',
      text: value,
    }),
  )
  const data = await retain({ scope, sources }, async () => ({ atoms: [] })),
    ids = rows(data.facts).map(a => text(a.id))
  const grouped = await group(data, async () => ({ groups: [{ episode_id: null, label: '喝茶约定', atom_ids: ids }] }))
  const obs = await consolidate({ ...data, episodes: grouped.episodes! }, async () => ({
    observations: [
      {
        observation_id: null,
        text: '旅人改变了计划，是否来喝茶仍有疑问。',
        supporting_atom_ids: [ids[1]!],
        contradicting_atom_ids: [ids[0]!],
      },
    ],
  }))
  return { ...data, episodes: grouped.episodes!, observations: obs.observations! }
}
it('delivers a revisable understanding with visible counter-evidence without modifying the archive', async () => {
  const data = await fixture(),
    before = structuredClone(data),
    out = deliver(data, [{ id: 'obs:1' }], request, 10, query, 6, 12000),
    item = rows(out.memories)[0]!
  expect(item).toMatchObject({
    epistemicKind: 'subjective_inference',
    hasUnresolvedCounterEvidence: true,
    evidenceCoverage: { complete: true, counterIncluded: 1 },
  })
  expect(text(item.text)).toContain('不是权威世界事实')
  expect(rows(item.keyEvidence).map(e => e.role)).toEqual(['counter', 'support'])
  expect(data).toEqual(before)
})
it('keeps mandatory provenance within budget and marks optional evidence omissions honestly', async () => {
  const data = await fixture(),
    full = deliver(data, [{ id: 'obs:1' }], request, 10, query, 1, 12000),
    fullItem = rows(full.memories)[0]!,
    emptyEvidence = {
      ...fullItem,
      keyEvidence: [],
      evidenceCoverage: {
        included: 0,
        total: 2,
        counterIncluded: 0,
        counterTotal: 1,
        complete: false,
        note: '仅证据摘选；未展示的证据和反证仍存在，不能视为已核实或冲突已解决。',
      },
    }
  const budget = [...JSON.stringify([emptyEvidence])].length
  const limited = deliver(data, [{ id: 'obs:1' }], request, 10, query, 1, budget)
  expect(rows(limited.memories)[0]).toMatchObject({
    keyEvidence: [],
    hasUnresolvedCounterEvidence: true,
    evidenceCoverage: { complete: false, counterTotal: 1 },
  })
  expect(deliver(data, [{ id: 'obs:1' }], request, 10, query, 0, 12000).memories).toEqual([])
  expect(deliver(data, [{ id: 'obs:1' }], request, 10, query, 1, 2).memories).toEqual([])
})
it('rejects character, branch, future knowledge and candidate mapping violations', async () => {
  const data = await fixture()
  expect(() => deliver(data, [], { context: { character: { characterId: 'character:other' } } }, 10, query)).toThrow(
    'character or world',
  )
  expect(() =>
    deliver(
      data,
      [],
      { context: { ...request.context, cognition: { address: { ...scope.worldAddress, branchId: 'other' } } } },
      10,
      query,
    ),
  ).toThrow('character or world')
  expect(() => deliver(data, [], request, 0, query)).toThrow('future')
  expect(() => deliver(data, [], { context: { ...request.context, cognition: { address: null } } }, 10, query)).toThrow(
    'character or world',
  )
  expect(() => deliver(data, [{ id: 'foreign' }], request, 10, query)).toThrow('candidate')
  expect(() =>
    deliver(data, [{ id: 'episode:1', matches: [{ atomIds: ['foreign'], sourceRefs: [] }] }], request, 10, query),
  ).toThrow('candidate evidence')
  const changed = structuredClone(data)
  rows(changed.sources)[0]!.sourceHash = 'changed'
  expect(() => deliver(changed, [], request, 10, query)).toThrow()
})

it('rejects a scored atom outside the matched episode evidence', async () => {
  const data = await fixture(),
    first = rows(data.facts)[0]!,
    second = rows(data.facts)[1]!
  const grouped = await group({ ...data, episodes: [] }, async () => ({
    groups: [{ episode_id: null, label: 'first', atom_ids: [first.id!] }],
  }))
  Object.assign(data, { episodes: grouped.episodes! })
  expect(() =>
    deliver(
      data,
      [
        {
          id: 'episode:1',
          matches: [
            {
              atomIds: [first.id!],
              sourceRefs: first.sourceRefs!,
              atomScores: [{ atomId: second.id!, relevance: 1, accepted: true }],
            },
          ],
        },
      ],
      request,
      10,
      query,
    ),
  ).toThrow('Foreign candidate evidence score')
})

it('uses code-point ID order for tied evidence under a one-item budget', async () => {
  const data = await fixture(['event:2', 'event_a']),
    atoms = rows(data.facts),
    episode = rows(data.episodes)[0]!
  const result = deliver(
    data,
    [
      {
        id: episode.id!,
        matches: [
          {
            atomIds: episode.eventAtomIds!,
            sourceRefs: episode.sourceRefs!,
            atomScores: [...atoms].reverse().map(a => ({ atomId: a.id!, relevance: 1, accepted: true })),
          },
        ],
      },
    ],
    request,
    10,
    query,
    1,
    12000,
  )
  expect(rows(result.memories)[0]!.sourceIds).toEqual(['event:2'])
})
it('uses an explicit activity ID to deliver the authorized ending and never exposes private metadata', async () => {
  const sources = [true, false].map((active, i) => ({
    sourceId: 'event:' + i,
    sourceHash: 'hash:' + i,
    worldSeq: i,
    knownTick: i,
    characterId: scope.characterId,
    worldAddress: scope.worldAddress,
    epistemicKind: 'observed_action',
    text: JSON.stringify({
      actorId: 'character:player',
      actionType: 'interact',
      status: 'accepted',
      resultDescription: active ? '开始了' : '结束了',
      resultMetadata: {
        activity: {
          id: 'activity:first',
          revision: i + 1,
          phase: active ? 'open' : 'closed',
          round: 1,
          active,
          lifecycle: active ? 'started' : 'ended',
          private: { secret: 73 },
        },
      },
    }),
  }))
  const data = bindActivity({
    ...(await retain({ scope, sources }, async () => {
      throw new Error('No model for action atoms')
    })),
    episodes: [],
    observations: [],
  })
  const result = deliver(
      data,
      [{ id: 'atom:event:0:0' }],
      request,
      10,
      { ...query, originalText: 'activity:first 结束了吗' },
      1,
      12000,
    ),
    item = rows(result.memories)[0]!
  expect(item).toMatchObject({ sourceIds: ['event:1'], deliveryCoverage: { endingIncluded: true, status: 'ended' } })
  expect(text(item.text)).toContain('活动已结束')
  expect(JSON.stringify(result)).not.toContain('secret')
})
it('explicit object candidacy does not import unrelated visible objects or use the observer as a seed', () => {
  const result = seedsFor(
    { context: { ...request.context, items: { current: [{ entityId: 'entity:other', locationId: 'location:tea' }] } } },
    {
      ...query,
      entitySeeds: [
        { id: 'entity:key', roles: ['mentioned'] },
        { id: 'character:friend', roles: ['actor'] },
      ],
      requiredEntityIds: ['entity:key'],
    },
    'character:friend',
  )
  expect(result).toMatchObject({ entityIds: ['entity:key'], mode: 'explicit-object' })
})
it('refuses projection evidence that does not belong to the represented memory', async () => {
  const data = await fixture(),
    first = rows(data.facts)[0]!,
    second = rows(data.facts)[1]!
  const index = {
    scope,
    units: [{ id: 'retrieval:0', memoryId: first.id!, atomIds: [second.id!], sourceRefs: second.sourceRefs! }],
  }
  expect(() => admit(data, index, { scope, results: [] }, request, query)).toThrow('Foreign projection atoms')
  const foreign = { ...index, scope: { ...scope, asOfWorldSeq: 11 } }
  expect(() => admit(data, foreign, { scope, results: [] }, request, query)).toThrow('prefix')
})
