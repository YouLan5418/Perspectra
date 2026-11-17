import { expect, it, vi } from 'vitest'
import type { WorldJsonObject, WorldJsonValue } from '@perspectra/sdk/contracts'
import { consolidate, retain } from './episodes.ts'
import { rows, text } from './archive.ts'
import { createCoreRuntime, reprojectArchive } from './runtime.ts'

const scope = {
  worldAddress: { tenantId: 'tenant', worldId: 'world', branchId: 'branch' },
  characterId: 'character:friend',
  asOfWorldSeq: 8,
}

function emptyArchive(): WorldJsonObject {
  return {
    scope,
    sources: [],
    representations: [],
    facts: [],
    episodes: [],
    observations: [],
  }
}

function recallInput(cognition?: WorldJsonObject, retrievalAliases?: WorldJsonValue): WorldJsonObject {
  const context: WorldJsonObject = {
    character: { characterId: scope.characterId, name: '朋友' },
    scene: { people: [] },
    items: [],
    stimulus: [],
    observations: [],
    selfObservations: [],
    ...(cognition === undefined ? {} : { cognition }),
  }
  return {
    operation: 'recall',
    archive: emptyArchive(),
    index: {
      scope,
      sources: [],
      units: [],
      vectors: [],
      links: [],
      stats: {},
      ...(retrievalAliases === undefined ? {} : { retrievalAliases }),
    },
    request: { context },
    tick: 8,
    observations: true,
    deliveryMode: 'minimal',
    deliveryBudget: { maxItems: 6, maxJsonChars: 12000 },
  }
}

it('accepts missing and null retrieval aliases on an empty archive, but rejects a null cognition address', async () => {
  const runtime = createCoreRuntime({
    model: { protocol: 'openai', endpoint: 'http://127.0.0.1:9/v1/chat/completions', model: 'fixture' },
    assetDirectory: 'unused-empty-assets',
  })
  try {
    const result = await runtime.run(recallInput(), new AbortController().signal)
    expect(result.delivery).toEqual([])
    const nullAliases = await runtime.run(recallInput(undefined, null), new AbortController().signal)
    expect(nullAliases.delivery).toEqual([])
    await expect(runtime.run(recallInput({ address: null }), new AbortController().signal)).rejects.toThrow(
      'scope mismatch',
    )
  } finally {
    await runtime.close()
  }
})

it('rejects parallel calls on one Core runtime while the active request is settling', async () => {
  const runtime = createCoreRuntime({
      model: { protocol: 'openai', endpoint: 'http://127.0.0.1:9/v1/chat/completions', model: 'fixture' },
      assetDirectory: 'unused-empty-assets',
    }),
    first = runtime.run(recallInput({ address: null }), new AbortController().signal)
  try {
    await expect(runtime.run(recallInput(), new AbortController().signal)).rejects.toThrow('active request')
    await expect(first).rejects.toThrow('scope mismatch')
  } finally {
    await runtime.close()
  }
})

it('rejects an unmigrated delivery mode instead of silently selecting minimal delivery', async () => {
  const runtime = createCoreRuntime({
    model: { protocol: 'openai', endpoint: 'http://127.0.0.1:9/v1/chat/completions', model: 'fixture' },
    assetDirectory: 'unused-empty-assets',
  })
  try {
    await expect(
      runtime.run({ ...recallInput(), deliveryMode: 'expanded' }, new AbortController().signal),
    ).rejects.toThrow('Unsupported Core delivery mode: expanded')
  } finally {
    await runtime.close()
  }
})

it('reprojects action evidence without changing Sources or subjective model decisions', async () => {
  const source: WorldJsonObject = {
      sourceId: 'event:8',
      sourceHash: 'hash:8',
      worldSeq: 8,
      knownTick: 8,
      characterId: scope.characterId,
      worldAddress: scope.worldAddress,
      epistemicKind: 'observed_action',
      text: JSON.stringify({
        actorId: 'character:player',
        actionType: 'interact',
        status: 'accepted',
        interaction: { entityId: 'entity:lantern' },
        resultDescription: '玩家拿起了灯笼。',
        resultMetadata: {
          activity: {
            id: 'activity:tea',
            revision: 1,
            phase: 'started',
            round: 0,
            active: true,
            lifecycle: 'started',
            private: { answer: 'never projected' },
          },
        },
        privateHostData: { answer: 73 },
      }),
    },
    retained = await retain(
      { scope, sources: [source] },
      vi.fn(async () => ({ atoms: [] })),
    ),
    integration = await consolidate({ ...retained, episodes: [], observations: [] }, async () => ({
      observations: [
        {
          observation_id: null,
          text: '朋友记得玩家拿起了灯笼。',
          supporting_atom_ids: [text(rows(retained.facts)[0]!.id)],
          contradicting_atom_ids: [],
        },
      ],
    })),
    archive: WorldJsonObject = { ...retained, episodes: [], observations: integration.observations! },
    before = rows(archive.observations).map(unit => ({
      id: unit.id,
      text: unit.text,
      supportingAtomIds: unit.supportingAtomIds,
      contradictingAtomIds: unit.contradictingAtomIds,
      sourceFactIds: unit.sourceFactIds,
    })),
    projected = reprojectArchive(archive)
  expect(projected.sources).toEqual(archive.sources)
  expect(
    rows(projected.observations).map(unit => ({
      id: unit.id,
      text: unit.text,
      supportingAtomIds: unit.supportingAtomIds,
      contradictingAtomIds: unit.contradictingAtomIds,
      sourceFactIds: unit.sourceFactIds,
    })),
  ).toEqual(before)
  expect(JSON.stringify(rows(projected.facts)[0]!.evidence)).toContain('玩家拿起了灯笼。')
  expect(JSON.stringify(rows(projected.facts)[0]!.evidence)).not.toContain('never projected')
  expect(JSON.stringify(rows(projected.sources)[0]!.text)).toContain('privateHostData')
})
