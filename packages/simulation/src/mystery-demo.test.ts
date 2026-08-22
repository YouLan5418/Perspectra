import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  compileMysteryDemo,
  createMysteryDemoSpec,
  MYSTERY_DEMO_IDS,
  MysteryDemoScenario,
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
  it('compiles one stable TURN_DRIVEN world with private knowledge and distinct observations', () => {
    const first = compileMysteryDemo()
    const second = compileMysteryDemo()
    expect(second).toEqual(first)
    expect(first.manifest).toMatchObject({
      metadata: { title: '灰林宅邸疑案' },
      rulebook: { rulebookId: 'builtin:speak-move', version: 2 },
      entities: [{ entityId: MYSTERY_DEMO_IDS.key, locationId: 'location:study' }],
      characters: expect.arrayContaining([
        expect.objectContaining({ characterId: MYSTERY_DEMO_IDS.alice }),
        expect.objectContaining({ characterId: MYSTERY_DEMO_IDS.bob }),
        expect.objectContaining({ characterId: MYSTERY_DEMO_IDS.detective }),
      ]),
    })
    const editable = createMysteryDemoSpec() as unknown as { metadata: { title: string; description: string } }
    editable.metadata = { title: '调用方副本', description: '' }
    expect(compileMysteryDemo().manifest.metadata.title).toBe('灰林宅邸疑案')
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
})
