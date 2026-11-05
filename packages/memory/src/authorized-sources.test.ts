import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  brandId,
  hashWorldJson,
  worldAddressKey,
  type CharacterId,
  type WorldAddress,
  type WorldEventDraft,
  type WorldJsonObject,
} from '@harness-world/contracts'
import { WorldStore } from '@harness-world/store-sqlite'
import { AuthorizedSourceStore } from './authorized-sources.ts'
import { MEMORY_MIGRATIONS, MEMORY_APPLICATION_ID } from './memory-schema.ts'
import { openMigratedDatabase } from '@harness-world/store-sqlite'

const directories: string[] = []
let lastMemoryPath = ''

/** The captured rows mentioning `text`, as the columns a memory implementation can rely on. */
function entries(characterId: CharacterId, text: string, asOfWorldSeq = 8, scope = address()) {
  const db = new DatabaseSync(lastMemoryPath, { readOnly: true })
  try {
    const rows = db
      .prepare(
        'SELECT memory_kind, epistemic_kind, text_value, metadata_json FROM cognitive_memory_v2_sources WHERE namespace_key = ? AND source_seq <= ? ORDER BY source_seq, source_id',
      )
      .all(`${worldAddressKey(scope)}\u001f${characterId}`, asOfWorldSeq) as {
      memory_kind: string
      epistemic_kind: string
      text_value: string
      metadata_json: string
    }[]
    return rows
      .filter(row => text.trim() !== '' && row.text_value.includes(text))
      .map(row => ({
        memoryKind: row.memory_kind,
        epistemicKind: row.epistemic_kind,
        text: row.text_value,
        metadata: JSON.parse(row.metadata_json),
      }))
  } finally {
    db.close()
  }
}

function paths(): { readonly world: string; readonly memory: string } {
  const directory = mkdtempSync(join(tmpdir(), 'hcw-memory-v2-'))
  directories.push(directory)
  lastMemoryPath = join(directory, 'memory.sqlite')
  return { world: join(directory, 'world.sqlite'), memory: lastMemoryPath }
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function address(branch = 'main'): WorldAddress {
  return {
    tenantId: brandId('tenant:memory-v2', 'TenantId'),
    worldId: brandId('world:memory-v2', 'WorldId'),
    branchId: brandId(`branch:${branch}`, 'BranchId'),
  }
}

const alice = brandId('character:alice', 'CharacterId')
const bob = brandId('character:bob', 'CharacterId')
const charlie = brandId('character:charlie', 'CharacterId')

function authorSource(id: string): WorldJsonObject {
  return { sourceKind: 'worldpack-test/v2', sourceId: id, sourceHash: hashWorldJson('memory-v2-author-source', id) }
}

function claimValue(): WorldJsonObject {
  return {
    proposition: { text: 'The north road is blocked' },
    stance: 'believed',
    confidencePermille: 700,
    saliencePermille: 600,
    awareness: 'conscious',
    status: 'active',
    basisRefs: [],
    source: authorSource('claim:road'),
  }
}

function goalValue(): WorldJsonObject {
  return {
    objective: { kind: 'narrative', value: 'Reach the station' },
    priorityPermille: 700,
    awareness: 'conscious',
    status: 'active',
    parentGoalKey: null,
    targetKeys: ['location:station'],
    blockerKeys: [],
    basisRefs: [],
    source: authorSource('goal:station'),
  }
}

async function commit(
  store: WorldStore,
  suffix: string,
  events: readonly WorldEventDraft[],
  target = address(),
): Promise<void> {
  const head = store.head(target)
  await store.commitRound({
    address: target,
    transactionId: brandId(`transaction:memory-v2:${suffix}`, 'TransactionId'),
    roundId: brandId(`round:memory-v2:${suffix}`, 'InteractionRoundId'),
    expectedHeadSeq: head.headSeq,
    expectedTick: head.tick,
    nextTick: head.tick + 1,
    events,
    outbox: [],
    correlationId: `memory-v2:${suffix}`,
  })
}

async function fixture() {
  const path = paths()
  const world = new WorldStore(path.world)
  world.createBranch(address())
  await commit(world, 'genesis', [
    { eventType: 'character.created', eventVersion: 1, data: { characterId: alice, locationId: 'location:road' } },
    { eventType: 'character.created', eventVersion: 1, data: { characterId: bob, locationId: 'location:road' } },
    { eventType: 'character.created', eventVersion: 1, data: { characterId: charlie, locationId: 'location:road' } },
    {
      eventType: 'observation.upsert',
      eventVersion: 1,
      data: {
        id: 'observation:rain',
        value: { observerId: alice, content: 'cold rain at the station', epistemicKind: 'direct_observation' },
      },
    },
    {
      eventType: 'observation.upsert',
      eventVersion: 1,
      data: {
        id: 'observation:speech',
        value: {
          observerId: alice,
          content: {
            actionType: 'speak',
            actorId: bob,
            speech: { characterId: bob, text: 'the bridge is closed' },
          },
        },
      },
    },
    {
      eventType: 'observation.upsert',
      eventVersion: 1,
      data: {
        id: 'observation:bob',
        value: { observerId: bob, content: { actionType: 'take', entityId: 'entity:ticket' } },
      },
    },
    {
      eventType: 'subjective-claim.upsert',
      eventVersion: 1,
      data: { id: 'claim:road', characterId: alice, value: claimValue() },
    },
    {
      eventType: 'character-goal.upsert',
      eventVersion: 1,
      data: { id: 'goal:station', characterId: alice, value: goalValue() },
    },
  ])
  return { path, world, memory: new AuthorizedSourceStore(path.memory, world) }
}

describe('Cognitive Memory v2', () => {
  it('keeps silent narration as attributed communication and only in the recipient memory', async () => {
    const path = paths()
    const world = new WorldStore(path.world)
    world.createBranch(address())
    await commit(world, 'narration', [
      { eventType: 'character.created', eventVersion: 1, data: { characterId: alice, locationId: 'location:road' } },
      { eventType: 'character.created', eventVersion: 1, data: { characterId: bob, locationId: 'location:road' } },
      {
        eventType: 'observation.upsert',
        eventVersion: 1,
        data: {
          id: 'observation:narration',
          value: {
            observerId: alice,
            content: {
              actionType: 'speak',
              actorId: bob,
              speech: { characterId: bob, text: '', narration: '铜钥匙已经在我口袋里。' },
            },
          },
        },
      },
    ])
    const memory = new AuthorizedSourceStore(path.memory, world)
    try {
      memory.catchUp(address(), alice, 3, 'narration:alice')
      const memories = entries(alice, '铜钥匙已经在我口袋里', 3)
      expect(memories).toMatchObject([
        {
          memoryKind: 'communication',
          epistemicKind: 'reported_speech',
          text: 'character:bob published narration (not an adjudicated outcome): 铜钥匙已经在我口袋里。',
          metadata: { speakerId: bob, narration: '铜钥匙已经在我口袋里。' },
        },
      ])
      memory.catchUp(address(), bob, 3, 'narration:bob')
      expect(entries(bob, '铜钥匙已经在我口袋里', 3)).toEqual([])
      expect(world.readEvents(address()).some(event => event.eventType === 'entity.transferred')).toBe(false)
    } finally {
      memory.close()
      world.close()
    }
  })

  it('captures only committed, observer-scoped manifestation content without promoting private affect', async () => {
    const path = paths()
    const world = new WorldStore(path.world)
    world.createBranch(address())
    await commit(world, 'manifestation-observations', [
      { eventType: 'character.created', eventVersion: 1, data: { characterId: alice, locationId: 'location:road' } },
      { eventType: 'character.created', eventVersion: 1, data: { characterId: bob, locationId: 'location:road' } },
      {
        eventType: 'observation.upsert',
        eventVersion: 1,
        data: {
          id: 'observation:alice:manifested-speech',
          value: {
            observerId: alice,
            content: {
              actionType: 'speak',
              actorId: bob,
              speech: { characterId: bob, text: '我没事。' },
              manifestation: {
                characterId: bob,
                description: 'Bob 避开视线，声音发颤。',
                cues: [
                  { cueId: 'cue:gaze', channel: 'gaze', description: '避开视线', persistence: 'event_only' },
                  { cueId: 'cue:voice', channel: 'voice', description: '声音发颤', persistence: 'event_only' },
                ],
              },
            },
          },
        },
      },
      {
        eventType: 'observation.upsert',
        eventVersion: 1,
        data: {
          id: 'observation:alice:manifested-only',
          value: {
            observerId: alice,
            content: {
              actionType: 'move',
              actorId: bob,
              manifestation: {
                characterId: bob,
                description: null,
                cues: [
                  { cueId: 'cue:posture', channel: 'posture', description: '抱起双臂', persistence: 'event_only' },
                ],
              },
            },
          },
        },
      },
    ])
    const memory = new AuthorizedSourceStore(path.memory, world)
    memory.catchUp(address(), alice, 4, 'catchup:manifestation:alice')
    expect(entries(alice, '声音发颤', 4)).toMatchObject([
      {
        memoryKind: 'communication',
        epistemicKind: 'reported_speech',
        text: 'character:bob said: 我没事。; character:bob appeared: Bob 避开视线，声音发颤。',
        metadata: { manifestation: { characterId: bob } },
      },
    ])
    expect(entries(alice, '抱起双臂', 4)).toMatchObject([
      {
        memoryKind: 'episodic',
        epistemicKind: 'direct_observation',
        text: 'character:bob appeared: 抱起双臂',
      },
    ])
    memory.catchUp(address(), bob, 4, 'catchup:manifestation:bob')
    expect(entries(bob, '声音发颤', 4)).toEqual([])
    expect(JSON.stringify(entries(alice, '声音发颤', 4))).not.toContain('jealousy')
    memory.close()
    world.close()
  })

  it.each([
    ['missing-character', { description: 'visible', cues: [{ description: 'visible' }] }, 'requires characterId'],
    [
      'invalid-description',
      { characterId: bob, description: 1, cues: [{ description: 'visible' }] },
      'description must be string',
    ],
    ['missing-cues', { characterId: bob, description: 'visible', cues: [] }, 'requires accepted cues'],
    ['invalid-cue', { characterId: bob, description: null, cues: [{}] }, 'cue requires description'],
  ] as const)(
    'fails closed for malformed committed manifestation observations: %s',
    async (suffix, manifestation, message) => {
      const path = paths()
      const world = new WorldStore(path.world)
      world.createBranch(address())
      await commit(world, `malformed-manifestation:${suffix}`, [
        { eventType: 'character.created', eventVersion: 1, data: { characterId: alice, locationId: 'location:road' } },
        {
          eventType: 'observation.upsert',
          eventVersion: 1,
          data: {
            id: `observation:alice:${suffix}`,
            value: { observerId: alice, content: { manifestation } },
          },
        },
      ])
      const memory = new AuthorizedSourceStore(path.memory, world)
      expect(() => memory.catchUp(address(), alice, 2, `catchup:${suffix}`)).toThrow(message)
      memory.close()
      world.close()
    },
  )

  it('captures the frozen subjective inference and self intention observation kinds', async () => {
    const path = paths()
    const world = new WorldStore(path.world)
    world.createBranch(address())
    await commit(world, 'subjective-observations', [
      { eventType: 'character.created', eventVersion: 1, data: { characterId: alice, locationId: 'location:road' } },
      {
        eventType: 'observation.upsert',
        eventVersion: 1,
        data: {
          id: 'observation:alice:inference',
          value: { observerId: alice, content: 'Bob may be hiding something', epistemicKind: 'subjective_inference' },
        },
      },
      {
        eventType: 'observation.upsert',
        eventVersion: 1,
        data: {
          id: 'observation:alice:intention',
          value: { observerId: alice, content: 'I will reach the station', epistemicKind: 'self_intention' },
        },
      },
    ])
    const memory = new AuthorizedSourceStore(path.memory, world)
    memory.catchUp(address(), alice, 3, 'catchup:subjective-observations')
    expect(entries(alice, 'Bob', 3)).toMatchObject([
      {
        memoryKind: 'episodic',
        epistemicKind: 'subjective_inference',
      },
    ])
    expect(entries(alice, 'station', 3)).toMatchObject([
      {
        memoryKind: 'episodic',
        epistemicKind: 'self_intention',
      },
    ])
    memory.close()
    world.close()
  })

  it('remembers an author stimulus as noticed or as a thought, never one for the other', async () => {
    const path = paths()
    const world = new WorldStore(path.world)
    world.createBranch(address())
    await commit(world, 'beat-stimuli', [
      { eventType: 'character.created', eventVersion: 1, data: { characterId: alice, locationId: 'location:road' } },
      {
        eventType: 'observation.upsert',
        eventVersion: 1,
        data: {
          id: 'beat:1:rent:stimulus:0',
          value: {
            observerId: alice,
            actionId: 'beat:1:rent',
            epistemicKind: 'direct_observation',
            content: { status: 'accepted', perceived: 'a rent notice under the door' },
          },
        },
      },
      {
        eventType: 'observation.upsert',
        eventVersion: 1,
        data: {
          id: 'beat:1:rent:stimulus:1',
          value: {
            observerId: alice,
            actionId: 'beat:1:rent',
            epistemicKind: 'subjective_inference',
            content: { status: 'accepted', innerThought: 'maybe the rent was mine to pay' },
          },
        },
      },
    ])
    const memory = new AuthorizedSourceStore(path.memory, world)
    memory.catchUp(address(), alice, 3, 'catchup:beat-stimuli')
    expect(entries(alice, 'under the door', 3)).toMatchObject([{ epistemicKind: 'direct_observation' }])
    expect(entries(alice, 'mine to pay', 3)).toMatchObject([{ epistemicKind: 'subjective_inference' }])
    memory.close()
    world.close()
  })

  it('captures four source kinds, keeps reported speech subjective, and persists stable receipts', async () => {
    const { world, memory } = await fixture()
    const fullHistoryRead = vi.spyOn(world, 'readEvents').mockImplementation(() => {
      throw new Error('Cognitive Memory must use typed Event range reads')
    })
    const first = memory.catchUp(address(), alice, 8)
    const replay = memory.catchUp(address(), alice, 8, 'catchup:alice:replay')
    expect(replay).toEqual(first)
    expect(first.watermark).toMatchObject({
      verifiedThroughSeq: 8,
      capturedThroughSeq: 8,
      memoryEpoch: 1,
    })
    expect(first.capturedMemoryIds).toHaveLength(4)
    expect(entries(alice, 'bridge')).toMatchObject([
      {
        memoryKind: 'communication',
        epistemicKind: 'reported_speech',
        text: 'character:bob said: the bridge is closed',
      },
    ])
    expect(entries(alice, 'north')[0]).toMatchObject({
      memoryKind: 'belief',
      epistemicKind: 'subjective_inference',
    })
    expect(entries(alice, 'station').some(value => value.memoryKind === 'intention')).toBe(true)
    expect(entries(alice, '   ')).toEqual([])
    memory.catchUp(address(), bob, 8, 'catchup:bob')
    expect(entries(bob, 'bridge')).toEqual([])
    expect(entries(bob, 'ticket')).toMatchObject([
      {
        memoryKind: 'episodic',
        epistemicKind: 'observed_action',
      },
    ])
    expect(fullHistoryRead).not.toHaveBeenCalled()
    memory.close()
    world.close()
  })

  it('keeps fork, character, and future sources outside the selected namespace', async () => {
    const { world, memory } = await fixture()
    const child = address('child')
    world.forkBranch(address(), child, 8)
    await commit(world, 'future', [
      {
        eventType: 'observation.upsert',
        eventVersion: 1,
        data: { id: 'observation:future', value: { observerId: alice, content: 'FUTURE_CANARY' } },
      },
    ])
    memory.catchUp(address(), alice, 9, 'catchup:parent')
    memory.catchUp(child, alice, 8, 'catchup:child')
    memory.catchUp(address(), bob, 9, 'catchup:bob')
    expect(entries(alice, 'FUTURE_CANARY', 9)).toHaveLength(1)
    expect(entries(alice, 'FUTURE_CANARY', 8, child)).toEqual([])
    expect(entries(bob, 'cold', 9)).toEqual([])
    memory.close()
    world.close()
  })

  it('fails closed on backward, divergent, malformed, unverified, and conflicting derived state', async () => {
    const { path, world, memory } = await fixture()
    expect(() => memory.catchUp(address(), alice, -1, 'negative')).toThrow(RangeError)
    memory.catchUp(address(), alice, 8, 'catchup:base')
    expect(() => memory.catchUp(address(), alice, 7, 'backward')).toThrow('cannot move backward')
    const raw = new DatabaseSync(path.memory)
    raw.prepare(`UPDATE cognitive_memory_v2_namespaces SET source_map_hash = 'sha256:corrupt'`).run()
    raw.close()
    expect(() => memory.catchUp(address(), alice, 8, 'watermark-diverged')).toThrow('source map diverged')
    memory.close()

    const repaired = new AuthorizedSourceStore(path.memory, world)
    repaired.reset(address(), alice)
    repaired.catchUp(address(), alice, 8, 'recaptured')
    const sourceDamage = new DatabaseSync(path.memory)
    sourceDamage
      .prepare(`UPDATE cognitive_memory_v2_sources SET source_hash = 'sha256:corrupt' WHERE namespace_key LIKE ?`)
      .run(`%${alice}`)
    sourceDamage.close()
    expect(() => repaired.catchUp(address(), alice, 8, 'source-diverged')).toThrow('divergent content')

    const receiptDamage = new DatabaseSync(path.memory)
    receiptDamage.prepare(`UPDATE cognitive_memory_v2_receipts SET receipt_hash = 'sha256:corrupt'`).run()
    receiptDamage.close()
    repaired.reset(address(), alice)
    const receipt = repaired.catchUp(address(), alice, 8, 'receipt-base')
    const conflicting = new DatabaseSync(path.memory)
    conflicting
      .prepare(`UPDATE cognitive_memory_v2_receipts SET receipt_hash = 'sha256:corrupt' WHERE receipt_id = ?`)
      .run(receipt.receiptId)
    conflicting.close()
    expect(() => repaired.catchUp(address(), alice, 8, 'receipt-diverged')).toThrow('receipt diverged')
    repaired.close()
    world.close()
  })

  it('rejects malformed communication and episodic vocabularies and rolls back a damaged reset', async () => {
    {
      const path = paths()
      const world = new WorldStore(path.world)
      world.createBranch(address())
      await commit(world, 'content-fallback', [
        { eventType: 'character.created', eventVersion: 1, data: { characterId: alice, locationId: 'location:a' } },
        {
          eventType: 'observation.upsert',
          eventVersion: 1,
          data: { id: 'observation:self', value: { observerId: alice } },
        },
      ])
      const memory = new AuthorizedSourceStore(path.memory, world)
      expect(memory.catchUp(address(), alice, 2, 'content-fallback').capturedMemoryIds).toHaveLength(1)
      memory.close()
      world.close()
    }
    for (const [suffix, value, message] of [
      ['speech', { observerId: alice, content: { speech: { characterId: bob } } }, 'publication requires'],
      ['epistemic', { observerId: alice, content: 'text', epistemicKind: 'omniscient' }, 'epistemicKind'],
      ['value', null, 'must be an object'],
      ['id', { observerId: alice, content: 'text' }, 'observation id'],
    ] as const) {
      const path = paths()
      const world = new WorldStore(path.world)
      world.createBranch(address())
      await commit(world, `malformed:${suffix}`, [
        { eventType: 'character.created', eventVersion: 1, data: { characterId: alice, locationId: 'location:a' } },
        {
          eventType: 'observation.upsert',
          eventVersion: 1,
          data: { id: suffix === 'id' ? '' : `observation:${suffix}`, value },
        },
      ])
      const memory = new AuthorizedSourceStore(path.memory, world)
      expect(() => memory.catchUp(address(), alice, 2, `malformed:${suffix}`)).toThrow(message)
      memory.close()
      world.close()
    }

    const fixtureValue = await fixture()
    fixtureValue.memory.catchUp(address(), alice, 8, 'reset:base')
    const raw = new DatabaseSync(fixtureValue.path.memory)
    raw.exec('DROP TABLE cognitive_memory_v2_receipts')
    raw.close()
    expect(() => fixtureValue.memory.reset(address(), alice)).toThrow()
    fixtureValue.memory.close()
    fixtureValue.world.close()
  })

  it('increments memoryEpoch on rebuild', async () => {
    const { path, world, memory } = await fixture()
    memory.catchUp(address(), alice, 8, 'epoch:first')
    expect(memory.reset(address(), alice)).toBe(2)
    const second = memory.catchUp(address(), alice, 8, 'epoch:second')
    expect(second.watermark.memoryEpoch).toBe(2)
    memory.close()

    const unopened = new AuthorizedSourceStore(path.memory, world)
    expect(unopened.reset(address(), bob)).toBe(1)
    expect(unopened.watermark(address(), bob)).toMatchObject({ memoryEpoch: 1, verifiedThroughSeq: 0 })
    unopened.close()
    world.close()
  })

  it('lists only this character, in order, up to the prefix asked for', async () => {
    const { world, memory } = await fixture()
    memory.catchUp(address(), alice, 8, 'sources:alice')
    const all = memory.sources(address(), alice, 8)
    expect(all.map(source => source.sourceSeq)).toEqual([...all.map(source => source.sourceSeq)].sort((a, b) => a - b))
    expect(all.some(source => source.text.includes('the bridge is closed'))).toBe(true)
    expect(memory.sources(address(), bob, 8)).toEqual([])
    expect(memory.sources(address(), alice, 0)).toEqual([])
    memory.close()
    world.close()
  })

  it('reads a memory database written by the previous version', async () => {
    const { path, world, memory } = await fixture()
    memory.close()
    // The previous schema with one row of everything the migration removes, plus a source and a receipt it keeps.
    rmSync(path.memory, { force: true })
    const old = openMigratedDatabase(path.memory, MEMORY_APPLICATION_ID, MEMORY_MIGRATIONS.slice(0, -1))
    const key = `${worldAddressKey(address())}\u001f${alice}`
    old
      .prepare('INSERT INTO cognitive_memory_v2_fts(namespace_key, memory_id, text_value) VALUES (?, ?, ?)')
      .run(key, 'm', 'old')
    old.close()
    const reopened = new AuthorizedSourceStore(path.memory, world)
    const receipt = reopened.catchUp(address(), alice, 8, 'after-migration')
    expect(receipt.capturedMemoryIds).toHaveLength(4)
    reopened.close()
    const raw = new DatabaseSync(path.memory, { readOnly: true })
    const tables = (raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(
      row => row.name,
    )
    raw.close()
    expect(tables).toEqual(
      expect.arrayContaining([
        'cognitive_memory_v2_sources',
        'cognitive_memory_v2_namespaces',
        'cognitive_memory_v2_receipts',
      ]),
    )
    for (const gone of [
      'cognitive_memory_v2_fts',
      'cognitive_memory_v2_terms',
      'cognitive_memory_v2_summaries',
      'cognitive_memory_v2_recall_receipts',
      'memory_entries',
      'cognitive_jobs',
    ])
      expect(tables).not.toContain(gone)
    world.close()
  })
})
