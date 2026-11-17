import { expect, it, vi } from 'vitest'
import type { WorldJsonObject } from '@perspectra/sdk/contracts'
import { aliasTable, clean, lexicalTerms, queryProjection } from './queries.ts'
import { atomSearchText } from './projections.ts'
import { buildIndex, recallQuality } from './retrieval.ts'
import { object, sourceRef } from './archive.ts'

const scope = {
  worldAddress: { tenantId: 't', worldId: 'w', branchId: 'b' },
  characterId: 'character:friend',
  asOfWorldSeq: 20,
}
const source: WorldJsonObject = {
  sourceId: 'event:1',
  sourceHash: 'hash:1',
  worldSeq: 1,
  knownTick: 1,
  characterId: scope.characterId,
  worldAddress: scope.worldAddress,
  epistemicKind: 'observed_action',
  text: '{}',
}

function retrievalIndex(): WorldJsonObject {
  const ref = sourceRef(source),
    units = [
      {
        id: 'retrieval:0',
        kind: 'fact',
        memoryId: 'atom:action',
        projectionLevel: 'event_atom',
        atomIds: ['atom:action'],
        sourceRefs: [ref],
        channels: ['action'],
        entities: ['entity:chest'],
        entityRoles: [{ id: 'entity:chest', roles: ['interaction:entityId'] }],
        text: '铜箱已经打开。',
        retrievalText: '铜箱已经打开。',
      },
      {
        id: 'retrieval:1',
        kind: 'fact',
        memoryId: 'atom:speech',
        projectionLevel: 'event_atom',
        atomIds: ['atom:speech'],
        sourceRefs: [ref],
        channels: ['speech'],
        entities: ['entity:chest'],
        entityRoles: [{ id: 'entity:chest', roles: ['mentioned'] }],
        text: '铜箱里仍有一把钥匙。',
        retrievalText: '铜箱里仍有一把钥匙。',
      },
    ]
  return {
    scope,
    sources: [source],
    units,
    vectors: [Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0)), Array(384).fill(0)],
    links: [],
    stats: {},
  }
}

it('matches Python casefold tokenization and whitespace rules for Unicode text', () => {
  expect(lexicalTerms('Straße ſhade ﬃancée')).toEqual(['strasse', 'shade', 'ffianc', 'e'])
  const aliases: WorldJsonObject = { people: [], characterIds: [] }
  expect(clean('甲\u0085乙\ufeff', aliases)).toBe('甲 乙\ufeff')
})

it('matches the formal bridge action projection including its result description', () => {
  expect(
    atomSearchText({
      evidence: {
        channel: 'action',
        context: JSON.stringify({
          actorId: 'character:player',
          actionType: 'interact',
          status: 'accepted',
          interaction: { interactionId: 'interaction:inspect', entityId: 'entity:chest' },
          resultDescription: '不进入 Python 的 action_text 投影',
        }),
      },
    }),
  ).toBe('观察到行动结果：player，inspect，对象chest 不进入 Python 的 action_text 投影')
})

it('encodes repeated retrieval passages once in first-seen order and maps vectors back', async () => {
  const ref = sourceRef(source),
    projected: WorldJsonObject = {
      scope,
      sources: [source],
      facts: ['same', 'same', 'other'].map((value, i) => ({
        id: `retrieval:${i}`,
        kind: 'fact',
        memoryId: `atom:${i}`,
        projectionLevel: 'event_atom',
        atomIds: [`atom:${i}`],
        sourceRefs: [ref],
        entities: [],
        text: value,
        retrievalText: value,
      })),
      episodes: [],
      observations: [],
    },
    sameVector = Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0)),
    otherVector = Array(384).fill(0),
    encode = vi.fn(async (texts: readonly string[]) => texts.map(text => (text === 'same' ? sameVector : otherVector))),
    index = await buildIndex(projected, encode)
  expect(encode).toHaveBeenCalledExactlyOnceWith(['same', 'other'], false)
  expect(index.vectors).toEqual([sameVector, sameVector, otherVector])
})

it('keeps one searchable Han character below the Python low-information threshold', () => {
  const projection = queryProjection(
    {
      context: { character: { characterId: scope.characterId }, scene: {}, stimulus: [] },
      recallEvidence: { query: '钥' },
    },
    undefined,
    value => value.length,
  )
  expect(projection).toMatchObject({
    semanticQuery: '',
    keywordTerms: [],
    mode: 'skip',
    contentChars: 1,
    tokenCount: 0,
  })
})

it('projects exact accepted object actions and retrieves only non-action evidence without an E5 query', async () => {
  const query = queryProjection(
      {
        context: {
          character: { characterId: 'character:player', name: '旅人' },
          scene: {},
          stimulus: [
            {
              value: {
                content: {
                  actorId: 'character:player',
                  actionType: 'interact',
                  status: 'accepted',
                  interaction: { entityId: 'entity:chest' },
                },
              },
            },
          ],
        },
      },
      undefined,
      value => value.length,
    ),
    encode = vi.fn(async () => {
      throw new Error('exact object recall must not encode a query')
    }),
    result = await recallQuality(retrievalIndex(), scope, query, encode)
  expect(query).toMatchObject({ mode: 'entity', requiredEntityIds: ['entity:chest'] })
  expect(encode).not.toHaveBeenCalled()
  expect(result.memoryArmResults).toMatchObject({ semantic: [], bm25: [], graph: ['atom:speech'], temporal: [] })
  expect(result.results).toMatchObject([{ id: 'atom:speech' }])
})

it('validates temporal and semantic diagnostics before returning a skipped query', async () => {
  const index = { ...retrievalIndex(), links: [['retrieval:0', 'foreign', 'temporal', 0.5, null]] }
  await expect(
    recallQuality(index, scope, { mode: 'skip', semanticQuery: '', skipReason: 'low information' }, async () => []),
  ).rejects.toThrow('Invalid or foreign graph edge')
})

it('rejects alias history from another character, branch, or future knowledge tick', () => {
  const doc = { scope, sources: [source] },
    entry: WorldJsonObject = {
      scope: { worldAddress: scope.worldAddress, characterId: scope.characterId },
      worldSeq: 1,
      people: [{ characterId: 'character:friend', name: '夏遥' }],
    }
  expect(() =>
    aliasTable(doc, [{ ...entry, scope: { ...object(entry.scope), characterId: 'character:other' } }]),
  ).toThrow()
  expect(() =>
    aliasTable(doc, [
      { ...entry, scope: { ...object(entry.scope), worldAddress: { ...scope.worldAddress, branchId: 'other' } } },
    ]),
  ).toThrow()
  expect(aliasTable(doc, [{ ...entry, worldSeq: 21 }]).people).toEqual([])
})
