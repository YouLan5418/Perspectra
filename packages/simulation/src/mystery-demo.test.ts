import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { brandId } from '@harness-world/contracts'
import {
  compileMysteryDemo,
  createMysteryIntentCatalog,
  createMysteryDemoSpec,
  MYSTERY_DEMO_IDS,
  MysteryDemoScenario,
  requireMysterySnapshotValue,
} from './mystery-demo.ts'

const directories: string[] = []

function paths() {
  const directory = mkdtempSync(join(tmpdir(), 'hcw-mystery-demo-'))
  directories.push(directory)
  return { worldPath: join(directory, 'world.sqlite'), sessionPath: join(directory, 'session.sqlite') }
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('three-role mystery Demo', () => {
  it('fails closed when an expected snapshot binding is absent', () => {
    expect(requireMysterySnapshotValue('present', 'fixture')).toBe('present')
    expect(() => requireMysterySnapshotValue(undefined, 'fixture')).toThrow('missing fixture')
  })

  it('compiles one stable TURN_DRIVEN world with private knowledge and distinct observations', () => {
    const first = compileMysteryDemo()
    const second = compileMysteryDemo()
    expect(second).toEqual(first)
    expect(first.manifest).toMatchObject({
      metadata: { title: '灰林宅邸疑案' },
      rulebook: { rulebookId: 'builtin:speak-move', version: 4 },
      entities: expect.arrayContaining([
        expect.objectContaining({ entityId: MYSTERY_DEMO_IDS.key, locationId: 'location:study' }),
        expect.objectContaining({ entityId: MYSTERY_DEMO_IDS.desk, locationId: 'location:study' }),
      ]),
      characters: expect.arrayContaining([
        expect.objectContaining({ characterId: MYSTERY_DEMO_IDS.alice }),
        expect.objectContaining({ characterId: MYSTERY_DEMO_IDS.bob }),
        expect.objectContaining({ characterId: MYSTERY_DEMO_IDS.detective }),
      ]),
    })
    const editable = createMysteryDemoSpec() as unknown as { metadata: { title: string; description: string } }
    editable.metadata = { title: '调用方副本', description: '' }
    expect(compileMysteryDemo().manifest.metadata.title).toBe('灰林宅邸疑案')

    const extended = {
      ...first,
      manifest: {
        ...first.manifest,
        characters: [...first.manifest.characters, {
          characterId: brandId('character:guest', 'CharacterId'), name: 'Guest', locationId: 'location:study',
        }],
        entities: [...first.manifest.entities, {
          entityId: 'entity:guest-note', locationId: 'location:study', kind: 'note',
        }],
      },
    }
    expect(createMysteryIntentCatalog(extended)).toMatchObject({
      characters: expect.arrayContaining([{ id: 'character:guest', aliases: ['Guest'] }]),
      entities: expect.arrayContaining([{ id: 'entity:guest-note', aliases: ['entity:guest-note'] }]),
      evidence: expect.arrayContaining([{
        id: 'evidence:inspection:entity:guest-note', aliases: ['evidence:inspection:entity:guest-note'],
      }]),
    })
  })

  it('runs Bob taking the key through Proposal and Rulebook, then replays identically after restart', async () => {
    const storage = paths()
    const first = new MysteryDemoScenario(storage)
    try {
      expect(first.activate()).toMatchObject({ status: 'activated', tick: 0 })
      const genesis = await first.snapshot()
      expect(genesis.tick).toBe(0)
      expect(genesis.entity).toEqual({
        entityId: MYSTERY_DEMO_IDS.key, locationId: 'location:study', holderId: null, kind: 'key',
      })
      expect(genesis.authority).toBeNull()
      expect(JSON.stringify(genesis.views.alice)).not.toContain('is_culprit')
      expect(JSON.stringify(genesis.views.player)).not.toContain('is_culprit')
      expect(JSON.stringify(genesis.views.bob)).toContain('is_culprit')
      expect(JSON.stringify(genesis.views.detective)).toContain('may_be_involved')
      expect(genesis.views.alice.scenes.map(value => value.sceneId)).toEqual([MYSTERY_DEMO_IDS.scene])
      expect(new Set([
        genesis.views.alice.observations[0]?.value,
        genesis.views.bob.observations[0]?.value,
        genesis.views.detective.observations[0]?.value,
      ].map(value => JSON.stringify(value))).size).toBe(3)

      const result = await first.runOpeningTurn()
      expect(result).toMatchObject({ status: 'accepted', tick: 1 })
      expect(first.providerCalls).toEqual({ bob: 1, director: 1 })
      const committed = await first.snapshot()
      expect(committed.entity).toEqual({
        entityId: MYSTERY_DEMO_IDS.key, locationId: null, holderId: MYSTERY_DEMO_IDS.bob, kind: 'key',
      })
      expect(committed.authority?.authority).toMatchObject({
        participants: expect.arrayContaining([
          expect.objectContaining({ participantId: 'player' }),
          expect.objectContaining({ participantId: 'agent:bob', terminalStatus: 'proposed' }),
          expect.objectContaining({ participantId: 'director:detective-observer', terminalStatus: 'proposed' }),
        ]),
        actions: expect.arrayContaining([
          expect.objectContaining({ participantId: 'agent:bob', actionType: 'take' }),
        ]),
        resolutions: expect.arrayContaining([
          expect.objectContaining({ status: 'accepted' }),
        ]),
      })
      expect(JSON.stringify(committed.authority)).not.toContain('agent:alice')
      expect(await first.deliver()).toBe(2)
      const eventHashes = committed.eventHashes
      const viewHashes = Object.values(committed.views).map(view => view.bundleHash)
      await first.close()

      const restarted = new MysteryDemoScenario(storage)
      try {
        expect(await restarted.runOpeningTurn()).toEqual(result)
        expect(restarted.providerCalls).toEqual({ bob: 0, director: 0 })
        const replay = await restarted.snapshot()
        expect(replay.eventHashes).toEqual(eventHashes)
        expect(Object.values(replay.views).map(view => view.bundleHash)).toEqual(viewHashes)
        expect(replay.entity).toEqual(committed.entity)
        expect(await restarted.deliver()).toBe(0)
      } finally {
        await restarted.close()
      }
    } finally {
      await first.close()
    }
  })

  it('runs a multi-Turn investigation from natural language through evidence and a correct accusation', async () => {
    const storage = paths()
    const first = new MysteryDemoScenario(storage)
    await first.runOpeningTurn()
    const asked = await first.submitPlayerText('询问鲍勃关于钥匙', 'mystery-demo:ask-bob')
    expect(asked).toMatchObject({ status: 'submitted', action: { actionType: 'ask' }, result: { status: 'accepted', tick: 2 } })
    const beforeClarification = await first.snapshot()
    expect(JSON.stringify(beforeClarification.views.player)).toContain('我没碰过那把钥匙。')
    expect(JSON.stringify(beforeClarification.views.bob)).toContain('我没碰过那把钥匙。')
    expect(await first.submitPlayerText('检查柜子', 'mystery-demo:unknown-target')).toMatchObject({
      status: 'clarification_required', reason: 'inspection target is unknown',
    })
    expect((await first.snapshot()).eventHashes).toEqual(beforeClarification.eventHashes)
    const inspected = await first.submitPlayerText('检查一下书桌', 'mystery-demo:inspect-desk')
    expect(inspected).toMatchObject({ status: 'submitted', action: { actionType: 'inspect' }, result: { status: 'accepted', tick: 3 } })
    const premature = await first.submitPlayerText('指控鲍勃：钥匙痕迹', 'mystery-demo:premature-accusation')
    expect(premature).toMatchObject({ status: 'submitted', result: { status: 'rejected', reason: 'EVIDENCE_NOT_PRESENTED', tick: 4 } })
    const presented = await first.submitPlayerText('向侦探出示钥匙痕迹', 'mystery-demo:present-key-trace')
    expect(presented).toMatchObject({ status: 'submitted', action: { actionType: 'present_evidence' }, result: { status: 'accepted', tick: 5 } })
    const incorrect = await first.submitPlayerText('指控爱丽丝：钥匙痕迹', 'mystery-demo:accuse-alice')
    expect(incorrect).toMatchObject({ status: 'submitted', result: { status: 'accepted', tick: 6 } })
    expect((await first.snapshot()).investigation.status).toBe('open')
    const correct = await first.submitPlayerText('指控鲍勃：钥匙痕迹', 'mystery-demo:accuse-bob')
    expect(correct).toMatchObject({ status: 'submitted', result: { status: 'accepted', tick: 7 } })
    expect(first.providerCalls).toEqual({ bob: 7, director: 7 })
    const solved = await first.snapshot()
    expect(solved.investigation).toMatchObject({
      status: 'solved', culpritId: MYSTERY_DEMO_IDS.bob,
      evidence: [{
        evidenceId: MYSTERY_DEMO_IDS.keyMovedEvidence,
        discoveredBy: [MYSTERY_DEMO_IDS.player],
        presentedBy: [MYSTERY_DEMO_IDS.player],
      }],
    })
    expect(JSON.stringify(solved.views.player)).toContain(MYSTERY_DEMO_IDS.keyMovedEvidence)
    expect(JSON.stringify(solved.views.player)).not.toContain('is_culprit')
    expect(solved.authority?.authority).toMatchObject({
      actions: expect.arrayContaining([expect.objectContaining({ actionType: 'accuse', participantId: 'player' })]),
    })
    expect(await first.deliver()).toBe(10)
    const hashes = solved.eventHashes
    await first.close()

    const restarted = new MysteryDemoScenario(storage)
    try {
      expect(await restarted.submitPlayerText('指控鲍勃：钥匙痕迹', 'mystery-demo:accuse-bob')).toEqual(correct)
      expect(restarted.providerCalls).toEqual({ bob: 0, director: 0 })
      expect((await restarted.snapshot()).eventHashes).toEqual(hashes)
      expect(await restarted.deliver()).toBe(0)
    } finally {
      await restarted.close()
    }
  })

  it('keeps a legal pre-opening key inspection usable across later Turns and restart', async () => {
    const storage = paths()
    const first = new MysteryDemoScenario(storage)
    try {
      const inspected = await first.submitPlayerText('检查一下钥匙', 'mystery-demo:inspect-key-first')
      expect(inspected).toMatchObject({ status: 'submitted', result: { status: 'accepted', tick: 1 } })
      expect((await first.snapshot()).investigation.evidence).toContainEqual({
        evidenceId: MYSTERY_DEMO_IDS.keyEvidence,
        discoveredBy: [MYSTERY_DEMO_IDS.player],
        presentedBy: [],
      })
      expect(await first.submitPlayerText('询问鲍勃关于钥匙', 'mystery-demo:ask-after-key')).toMatchObject({
        status: 'submitted', result: { status: 'accepted', tick: 2 },
      })
    } finally {
      await first.close()
    }
    const restarted = new MysteryDemoScenario(storage)
    try {
      expect(await restarted.submitPlayerText('向侦探出示钥匙本身', 'mystery-demo:present-key-itself')).toMatchObject({
        status: 'submitted', result: { status: 'accepted', tick: 3 },
      })
    } finally {
      await restarted.close()
    }
  })
})
