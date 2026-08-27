import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  brandId,
  hashWorldJson,
  type WorldAddress,
  type WorldEventDraft,
  type WorldJsonObject,
} from '@harness-world/contracts'
import { CognitionProjectionRebuilder } from './cognition-projection.ts'
import { WorldStore } from './world-store.ts'

const directories: string[] = []

function database(name: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'hcw-cognition-'))
  directories.push(directory)
  return join(directory, name)
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function address(branch = 'main', world = 'cognition'): WorldAddress {
  return {
    tenantId: brandId('tenant:cognition', 'TenantId'),
    worldId: brandId(`world:${world}`, 'WorldId'),
    branchId: brandId(`branch:${branch}`, 'BranchId'),
  }
}

async function commit(store: WorldStore, target: WorldAddress, suffix: string, events: readonly WorldEventDraft[]) {
  const head = store.head(target)
  return store.commitRound({
    address: target,
    transactionId: brandId(`transaction:${suffix}`, 'TransactionId'),
    roundId: brandId(`round:${suffix}`, 'InteractionRoundId'),
    expectedHeadSeq: head.headSeq,
    expectedTick: head.tick,
    nextTick: head.tick + 1,
    events,
    outbox: [],
    correlationId: suffix,
  })
}

function source(id: string): WorldJsonObject {
  return {
    sourceKind: 'worldpack-test/v2', sourceId: `source:${id}`,
    sourceHash: hashWorldJson('cognition-test-source', { id }),
  }
}

function common(id: string): WorldJsonObject {
  return { basisRefs: [source(`basis:${id}`)], source: source(id) }
}

function event(eventType: string, id: string, characterId: string, value: WorldJsonObject): WorldEventDraft {
  return { eventType, eventVersion: 1, data: { id, characterId, value } }
}

const fixtures = {
  claim: { proposition: { text: 'The road is flooded' }, stance: 'believed', confidencePermille: 700, saliencePermille: 500, awareness: 'conscious', status: 'active', ...common('claim') },
  goal: { objective: { kind: 'narrative', value: 'Reach the station' }, priorityPermille: 600, awareness: 'partially_conscious', status: 'blocked', parentGoalKey: null, targetKeys: ['location:station'], blockerKeys: [], ...common('goal') },
  relationship: { target: 'character:bob', type: 'distrust', facet: 'reliability', intensityPermille: 600, confidencePermille: 500, awareness: 'unrecognized', status: 'active', ...common('relationship') },
  affect: { type: 'anxiety', intensityPermille: 550, cause: { text: 'delay' }, targetKey: null, awareness: 'conscious', expressionMode: 'restrained', duration: 'short_lived', status: 'active', ...common('affect') },
  tension: {
    title: 'Ask or stay quiet', pressurePermille: 650, awareness: 'partially_conscious', status: 'resolved', resolutionKind: 'integrated',
    poles: [
      { key: 'pole:ask', tendency: 'express', impulseText: 'Ask now', strengthPermille: 600, awareness: 'conscious', basisRefs: [source('pole:ask')] },
      { key: 'pole:quiet', tendency: 'conceal', impulseText: 'Wait', strengthPermille: 700, awareness: 'unrecognized', basisRefs: [] },
    ],
    ...common('tension'),
  },
  commitment: { content: 'Travel together', origin: 'agreement', saliencePermille: 500, awareness: 'conscious', status: 'active', ...common('commitment') },
  loop: { kind: 'question', summary: 'Why was Bob late?', saliencePermille: 500, status: 'answered', ...common('loop') },
} as const

function seven(characterId: string): readonly WorldEventDraft[] {
  return [
    event('subjective-claim.upsert', 'claim:road', characterId, fixtures.claim),
    event('character-goal.upsert', 'goal:station', characterId, fixtures.goal),
    event('relationship-attitude.upsert', 'relationship:bob', characterId, fixtures.relationship),
    event('affect-episode.upsert', 'affect:delay', characterId, fixtures.affect),
    event('inner-tension.upsert', 'tension:question', characterId, fixtures.tension),
    event('commitment.upsert', 'commitment:travel', characterId, fixtures.commitment),
    event('open-loop.upsert', 'loop:late', characterId, fixtures.loop),
  ]
}

async function rejected(suffix: string, draft: WorldEventDraft, message: string): Promise<void> {
  const store = new WorldStore(database(`${suffix}.sqlite`))
  const target = address('main', suffix)
  store.createBranch(target)
  await commit(store, target, suffix, [draft])
  expect(() => new CognitionProjectionRebuilder(store).rebuildAt(target, 1)).toThrow(message)
  store.close()
}

describe('CognitionProjectionRebuilder', () => {
  it('rebuilds seven private temporal states at exact parent and fork prefixes', async () => {
    const store = new WorldStore(database('temporal.sqlite'))
    const parent = address('parent')
    const child = address('child')
    store.createBranch(parent)
    await commit(store, parent, 'base', [
      { eventType: 'unrelated.event', eventVersion: 1, data: null },
      ...seven('character:alice'),
      event('subjective-claim.upsert', 'claim:bob', 'character:bob', { ...fixtures.claim, proposition: { text: 'Alice is worried' } }),
    ])
    const forkSeq = store.head(parent).headSeq
    store.forkBranch(parent, child, forkSeq)
    await commit(store, parent, 'future', [
      event('subjective-claim.upsert', 'claim:road', 'character:alice', { ...fixtures.claim, stance: 'doubted' }),
      event('affect-episode.upsert', 'affect:future', 'character:bob', { ...fixtures.affect, cause: 'FUTURE_CANARY' }),
    ])

    const rebuilder = new CognitionProjectionRebuilder(store)
    let heartbeats = 0
    const childBundle = rebuilder.rebuildAt(child, forkSeq, () => { heartbeats += 1 })
    expect(heartbeats).toBeGreaterThan(1)
    expect(childBundle).toMatchObject({
      asOfWorldSeq: forkSeq,
      claims: [{ id: 'claim:road' }, { id: 'claim:bob' }],
      goals: [{ id: 'goal:station' }],
      relationships: [{ id: 'relationship:bob' }],
      affects: [{ id: 'affect:delay' }],
      innerTensions: [{ id: 'tension:question' }],
      commitments: [{ id: 'commitment:travel' }],
      openLoops: [{ id: 'loop:late' }],
    })
    expect(JSON.stringify(childBundle)).not.toContain('FUTURE_CANARY')
    expect(childBundle.claims[0]!.sourceRef).toMatchObject({ sourceKind: 'world_event', sourceSeq: 2 })

    const parentNow = rebuilder.rebuildAt(parent, store.head(parent).headSeq)
    expect((parentNow.claims.find(value => value.id === 'claim:road')!.value as WorldJsonObject).stance).toBe('doubted')
    expect(JSON.stringify(parentNow)).toContain('FUTURE_CANARY')
    const history = rebuilder.historyAt(parent, store.head(parent).headSeq)
      .filter(value => value.id === 'claim:road')
    expect(history).toHaveLength(2)
    expect(history[0]!.validToSeq).toBe(history[1]!.validFromSeq)
    expect(history[1]!.validToSeq).toBeNull()

    const alice = rebuilder.rebuildCharacterAt(child, brandId('character:alice', 'CharacterId'), forkSeq)
    const bob = rebuilder.rebuildCharacterAt(child, brandId('character:bob', 'CharacterId'), forkSeq)
    expect(alice.claims.map(value => value.id)).toEqual(['claim:road'])
    expect(bob.claims.map(value => value.id)).toEqual(['claim:bob'])
    expect(alice.bundleHash).not.toBe(bob.bundleHash)
    expect(rebuilder.rebuildAt(child, forkSeq).bundleHash).toBe(childBundle.bundleHash)
    expect(() => rebuilder.rebuildAt(parent, -1)).toThrow(RangeError)
    expect(() => rebuilder.rebuildAt(parent, store.head(parent).headSeq + 1)).toThrow('later than the branch head')
    store.close()
  })

  it('fails closed on ownership changes and duplicate active Claim propositions', async () => {
    const ownership = new WorldStore(database('ownership.sqlite'))
    const ownershipAddress = address('main', 'ownership')
    ownership.createBranch(ownershipAddress)
    await commit(ownership, ownershipAddress, 'owner-a', [event('subjective-claim.upsert', 'claim:same', 'character:alice', fixtures.claim)])
    await commit(ownership, ownershipAddress, 'owner-b', [event('subjective-claim.upsert', 'claim:same', 'character:bob', fixtures.claim)])
    expect(() => new CognitionProjectionRebuilder(ownership).rebuildAt(ownershipAddress, 2)).toThrow('ownership')
    ownership.close()

    const duplicate = new WorldStore(database('duplicate.sqlite'))
    const duplicateAddress = address('main', 'duplicate')
    duplicate.createBranch(duplicateAddress)
    await commit(duplicate, duplicateAddress, 'duplicate', [
      event('subjective-claim.upsert', 'claim:a', 'character:alice', fixtures.claim),
      event('subjective-claim.upsert', 'claim:b', 'character:alice', fixtures.claim),
    ])
    expect(() => new CognitionProjectionRebuilder(duplicate).rebuildAt(duplicateAddress, 2)).toThrow('multiple active Claims')
    duplicate.close()
  })

  it('rejects malformed common envelopes and every unsupported cognition vocabulary', async () => {
    const changed = (base: WorldJsonObject, patch: WorldJsonObject): WorldJsonObject => ({ ...base, ...patch })
    const without = (base: WorldJsonObject, key: string): WorldJsonObject => {
      const copy = { ...base }
      delete copy[key]
      return copy
    }
    const invalid: readonly (readonly [string, WorldEventDraft, string])[] = [
      ['data', { eventType: 'subjective-claim.upsert', eventVersion: 1, data: null }, 'must be an object'],
      ['id', event('subjective-claim.upsert', '', 'character:alice', fixtures.claim), '.id'],
      ['character', event('subjective-claim.upsert', 'claim:a', ' padded ', fixtures.claim), 'characterId'],
      ['value', { eventType: 'subjective-claim.upsert', eventVersion: 1, data: { id: 'claim:a', characterId: 'character:alice', value: null } }, '.value'],
      ['basis-array', event('subjective-claim.upsert', 'claim:a', 'character:alice', changed(fixtures.claim, { basisRefs: null })), 'basisRefs'],
      ['basis-source', event('subjective-claim.upsert', 'claim:a', 'character:alice', changed(fixtures.claim, { basisRefs: [null] })), 'must be an object'],
      ['source', event('subjective-claim.upsert', 'claim:a', 'character:alice', changed(fixtures.claim, { source: null })), 'must be an object'],
      ['source-kind', event('subjective-claim.upsert', 'claim:a', 'character:alice', changed(fixtures.claim, { source: { ...source('a'), sourceKind: '' } })), 'sourceKind'],
      ['source-id', event('subjective-claim.upsert', 'claim:a', 'character:alice', changed(fixtures.claim, { source: { ...source('a'), sourceId: '' } })), 'sourceId'],
      ['source-hash', event('subjective-claim.upsert', 'claim:a', 'character:alice', changed(fixtures.claim, { source: { ...source('a'), sourceHash: 'sha256:ABC' } })), 'lowercase'],
      ['claim-proposition', event('subjective-claim.upsert', 'claim:a', 'character:alice', without(fixtures.claim, 'proposition')), 'proposition'],
      ['claim-stance', event('subjective-claim.upsert', 'claim:a', 'character:alice', changed(fixtures.claim, { stance: 'certain' })), 'vocabulary'],
      ['claim-confidence', event('subjective-claim.upsert', 'claim:a', 'character:alice', changed(fixtures.claim, { confidencePermille: -1 })), 'safe integer'],
      ['claim-salience', event('subjective-claim.upsert', 'claim:a', 'character:alice', changed(fixtures.claim, { saliencePermille: 1001 })), 'safe integer'],
      ['claim-awareness', event('subjective-claim.upsert', 'claim:a', 'character:alice', changed(fixtures.claim, { awareness: 'unrecognized' })), 'vocabulary'],
      ['claim-status', event('subjective-claim.upsert', 'claim:a', 'character:alice', changed(fixtures.claim, { status: 'resolved' })), 'active'],
      ['goal-objective', event('character-goal.upsert', 'goal:a', 'character:alice', changed(fixtures.goal, { objective: null })), 'objective'],
      ['goal-priority', event('character-goal.upsert', 'goal:a', 'character:alice', changed(fixtures.goal, { priorityPermille: 'high' })), 'safe integer'],
      ['goal-awareness', event('character-goal.upsert', 'goal:a', 'character:alice', changed(fixtures.goal, { awareness: 'hidden' })), 'vocabulary'],
      ['goal-status', event('character-goal.upsert', 'goal:a', 'character:alice', changed(fixtures.goal, { status: 'paused' })), 'vocabulary'],
      ['goal-parent', event('character-goal.upsert', 'goal:a', 'character:alice', changed(fixtures.goal, { parentGoalKey: 1 })), 'parentGoalKey'],
      ['goal-target-array', event('character-goal.upsert', 'goal:a', 'character:alice', changed(fixtures.goal, { targetKeys: null })), 'targetKeys'],
      ['goal-target-entry', event('character-goal.upsert', 'goal:a', 'character:alice', changed(fixtures.goal, { targetKeys: [''] })), 'targetKeys[0]'],
      ['goal-target-duplicate', event('character-goal.upsert', 'goal:a', 'character:alice', changed(fixtures.goal, { targetKeys: ['a', 'a'] })), 'duplicate'],
      ['goal-blocker-array', event('character-goal.upsert', 'goal:a', 'character:alice', changed(fixtures.goal, { blockerKeys: null })), 'blockerKeys'],
      ['relationship-target', event('relationship-attitude.upsert', 'relationship:a', 'character:alice', changed(fixtures.relationship, { target: '' })), '.target'],
      ['relationship-type', event('relationship-attitude.upsert', 'relationship:a', 'character:alice', changed(fixtures.relationship, { type: 'friendship' })), 'vocabulary'],
      ['relationship-facet', event('relationship-attitude.upsert', 'relationship:a', 'character:alice', changed(fixtures.relationship, { facet: '' })), '.facet'],
      ['relationship-intensity', event('relationship-attitude.upsert', 'relationship:a', 'character:alice', changed(fixtures.relationship, { intensityPermille: 0 })), 'from 1'],
      ['relationship-confidence', event('relationship-attitude.upsert', 'relationship:a', 'character:alice', changed(fixtures.relationship, { confidencePermille: 1001 })), 'safe integer'],
      ['relationship-awareness', event('relationship-attitude.upsert', 'relationship:a', 'character:alice', changed(fixtures.relationship, { awareness: 'hidden' })), 'vocabulary'],
      ['relationship-status', event('relationship-attitude.upsert', 'relationship:a', 'character:alice', changed(fixtures.relationship, { status: 'paused' })), 'vocabulary'],
      ['affect-type', event('affect-episode.upsert', 'affect:a', 'character:alice', changed(fixtures.affect, { type: 'confused' })), 'vocabulary'],
      ['affect-intensity', event('affect-episode.upsert', 'affect:a', 'character:alice', changed(fixtures.affect, { intensityPermille: 0 })), 'from 1'],
      ['affect-cause', event('affect-episode.upsert', 'affect:a', 'character:alice', without(fixtures.affect, 'cause')), 'cause'],
      ['affect-target', event('affect-episode.upsert', 'affect:a', 'character:alice', changed(fixtures.affect, { targetKey: 1 })), 'targetKey'],
      ['affect-awareness', event('affect-episode.upsert', 'affect:a', 'character:alice', changed(fixtures.affect, { awareness: 'hidden' })), 'vocabulary'],
      ['affect-expression', event('affect-episode.upsert', 'affect:a', 'character:alice', changed(fixtures.affect, { expressionMode: 'loud' })), 'vocabulary'],
      ['affect-duration', event('affect-episode.upsert', 'affect:a', 'character:alice', changed(fixtures.affect, { duration: 'forever' })), 'vocabulary'],
      ['affect-status', event('affect-episode.upsert', 'affect:a', 'character:alice', changed(fixtures.affect, { status: 'paused' })), 'vocabulary'],
      ['tension-title', event('inner-tension.upsert', 'tension:a', 'character:alice', changed(fixtures.tension, { title: '' })), '.title'],
      ['tension-pressure', event('inner-tension.upsert', 'tension:a', 'character:alice', changed(fixtures.tension, { pressurePermille: 0 })), 'from 1'],
      ['tension-awareness', event('inner-tension.upsert', 'tension:a', 'character:alice', changed(fixtures.tension, { awareness: 'hidden' })), 'vocabulary'],
      ['tension-status', event('inner-tension.upsert', 'tension:a', 'character:alice', changed(fixtures.tension, { status: 'paused' })), 'vocabulary'],
      ['tension-resolution', event('inner-tension.upsert', 'tension:a', 'character:alice', changed(fixtures.tension, { resolutionKind: 'won' })), 'vocabulary'],
      ['tension-poles', event('inner-tension.upsert', 'tension:a', 'character:alice', changed(fixtures.tension, { poles: [] })), 'two through four'],
      ['tension-pole-object', event('inner-tension.upsert', 'tension:a', 'character:alice', changed(fixtures.tension, { poles: [null, fixtures.tension.poles[1]] })), 'must be an object'],
      ['tension-pole-key', event('inner-tension.upsert', 'tension:a', 'character:alice', changed(fixtures.tension, { poles: [{ ...fixtures.tension.poles[0], key: '' }, fixtures.tension.poles[1]] })), '.key'],
      ['tension-pole-tendency', event('inner-tension.upsert', 'tension:a', 'character:alice', changed(fixtures.tension, { poles: [{ ...fixtures.tension.poles[0], tendency: 'freeze' }, fixtures.tension.poles[1]] })), 'vocabulary'],
      ['tension-pole-impulse', event('inner-tension.upsert', 'tension:a', 'character:alice', changed(fixtures.tension, { poles: [{ ...fixtures.tension.poles[0], impulseText: '' }, fixtures.tension.poles[1]] })), 'impulseText'],
      ['tension-pole-strength', event('inner-tension.upsert', 'tension:a', 'character:alice', changed(fixtures.tension, { poles: [{ ...fixtures.tension.poles[0], strengthPermille: 0 }, fixtures.tension.poles[1]] })), 'from 1'],
      ['tension-pole-awareness', event('inner-tension.upsert', 'tension:a', 'character:alice', changed(fixtures.tension, { poles: [{ ...fixtures.tension.poles[0], awareness: 'hidden' }, fixtures.tension.poles[1]] })), 'vocabulary'],
      ['tension-pole-basis', event('inner-tension.upsert', 'tension:a', 'character:alice', changed(fixtures.tension, { poles: [{ ...fixtures.tension.poles[0], basisRefs: null }, fixtures.tension.poles[1]] })), 'basisRefs'],
      ['tension-pole-basis-source', event('inner-tension.upsert', 'tension:a', 'character:alice', changed(fixtures.tension, { poles: [{ ...fixtures.tension.poles[0], basisRefs: [null] }, fixtures.tension.poles[1]] })), 'must be an object'],
      ['tension-pole-duplicate', event('inner-tension.upsert', 'tension:a', 'character:alice', changed(fixtures.tension, { poles: [fixtures.tension.poles[0], { ...fixtures.tension.poles[1], key: fixtures.tension.poles[0].key }] })), 'duplicate keys'],
      ['commitment-content', event('commitment.upsert', 'commitment:a', 'character:alice', without(fixtures.commitment, 'content')), 'content'],
      ['commitment-origin', event('commitment.upsert', 'commitment:a', 'character:alice', changed(fixtures.commitment, { origin: 'habit' })), 'vocabulary'],
      ['commitment-salience', event('commitment.upsert', 'commitment:a', 'character:alice', changed(fixtures.commitment, { saliencePermille: -1 })), 'safe integer'],
      ['commitment-awareness', event('commitment.upsert', 'commitment:a', 'character:alice', changed(fixtures.commitment, { awareness: 'unrecognized' })), 'vocabulary'],
      ['commitment-status', event('commitment.upsert', 'commitment:a', 'character:alice', changed(fixtures.commitment, { status: 'paused' })), 'vocabulary'],
      ['loop-kind', event('open-loop.upsert', 'loop:a', 'character:alice', changed(fixtures.loop, { kind: 'mystery' })), 'vocabulary'],
      ['loop-summary', event('open-loop.upsert', 'loop:a', 'character:alice', changed(fixtures.loop, { summary: '' })), '.summary'],
      ['loop-salience', event('open-loop.upsert', 'loop:a', 'character:alice', changed(fixtures.loop, { saliencePermille: 1001 })), 'safe integer'],
      ['loop-status', event('open-loop.upsert', 'loop:a', 'character:alice', changed(fixtures.loop, { status: 'paused' })), 'vocabulary'],
    ]
    for (const [suffix, draft, message] of invalid) await rejected(suffix, draft, message)
  })
})
