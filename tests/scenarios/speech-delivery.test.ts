import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, it } from 'vitest'
import { WorldApplication } from '@harness-world/application'
import { brandId, hashWorldJson, type WorldEventDraft, type WorldJsonObject } from '@harness-world/contracts'
import { CharacterViewBuilder, WorldStore } from '@harness-world/store-sqlite'
import { CognitiveMemoryService } from '@harness-world/memory'
import { frozenIntentWorld } from '../fixtures/player-intent-world.ts'

it.each(['direct', 'private'])(
  'rejects unreachable player %s speech without delivering text, witnesses or later replay',
  async scope => {
    const root = mkdtempSync(join(tmpdir(), 'speech-delivery-'))
    const base = frozenIntentWorld()
    const extra: WorldEventDraft[] = [
      {
        eventType: 'character.moved',
        eventVersion: 1,
        data: { characterId: 'character:npc', fromLocationId: 'location:room', toLocationId: 'location:next' },
      },
      {
        eventType: 'scene.member_left',
        eventVersion: 1,
        data: { sceneId: 'scene:room', characterId: 'character:npc' },
      },
      { eventType: 'scene.created', eventVersion: 1, data: { sceneId: 'scene:next', locationId: 'location:next' } },
      {
        eventType: 'scene.member_joined',
        eventVersion: 1,
        data: { sceneId: 'scene:next', characterId: 'character:npc' },
      },
      { eventType: 'scene.activated', eventVersion: 1, data: { sceneId: 'scene:next' } },
    ]
    const genesisEvents = [...base.genesisEvents, ...extra]
    const world = { ...base, genesisEvents, genesisHash: hashWorldJson('world-genesis-plan', genesisEvents) }
    const app = new WorldApplication({
      worldPath: join(root, 'world.sqlite'),
      sessionPath: join(root, 'session.sqlite'),
      memoryPath: join(root, 'memory.sqlite'),
      modelBudgetTokens: 100,
    })
    const secret = '拒绝投递的口令海棠7306'
    let store: WorldStore | undefined
    let memory: CognitiveMemoryService | undefined
    try {
      app.activate(world)
      const submit = (text: string, key: string) =>
        app.submitText(world.manifest.address, {
          text,
          principalId: 'principal:player',
          idempotencyKey: key,
          correlationId: key,
        })
      await submit(
        '/act speak ' + JSON.stringify({ text: secret, scope, addresseeIds: ['character:npc', 'character:bob'] }),
        'unreachable',
      )
      store = new WorldStore(join(root, 'world.sqlite'))
      let events = store.readEvents(world.manifest.address)
      const rejected = events.find(event => event.eventType === 'action.rejected')!
      expect(rejected.data).toMatchObject({ reason: 'SPEECH_RECIPIENT_UNREACHABLE' })
      const transaction = events.filter(event => event.transactionId === rejected.transactionId)
      expect(transaction.some(event => event.eventType === 'character.speak')).toBe(false)
      expect(transaction.find(event => event.eventType === 'action.resolved')?.data).toMatchObject({ accepted: false })
      const observations = transaction
        .filter(event => event.eventType === 'observation.upsert')
        .map(event => (event.data as WorldJsonObject).value as WorldJsonObject)
      expect(observations.map(value => value.observerId)).toEqual(['character:player'])
      expect(JSON.stringify(observations)).not.toContain('occurrence_only')

      // Becoming co-present later permits a new publication, but never delivers the failed one.
      await submit('/move location:next', 'approach')
      await submit(
        '/act speak ' + JSON.stringify({ text: '这次同场送达', scope, addresseeIds: ['character:npc'] }),
        'reachable',
      )
      events = store.readEvents(world.manifest.address)
      const view = new CharacterViewBuilder(store).rebuildAt(
        world.manifest.address,
        brandId('character:npc', 'CharacterId'),
        store.head(world.manifest.address).headSeq,
      )
      expect(JSON.stringify(view.observations)).toContain('这次同场送达')
      expect(JSON.stringify(view.observations)).not.toContain(secret)
      expect(events.filter(event => event.eventType === 'character.speak')).toHaveLength(1)
      const memoryPath = join(root, 'verification-memory.sqlite')
      memory = new CognitiveMemoryService(memoryPath, store, undefined, 2)
      for (const id of ['character:npc', 'character:bob']) {
        const caughtUp = memory.catchUp(
          world.manifest.address,
          brandId(id, 'CharacterId'),
          store.head(world.manifest.address).headSeq,
          'speech-test',
        )
        expect(JSON.stringify(caughtUp)).not.toContain(secret)
      }
      const db = new DatabaseSync(memoryPath, { readOnly: true })
      try {
        const sources = db.prepare('SELECT text_value FROM cognitive_memory_v2_sources').all()
        expect(JSON.stringify(sources)).toContain('这次同场送达')
        expect(JSON.stringify(sources)).not.toContain(secret)
      } finally {
        db.close()
      }
    } finally {
      memory?.close()
      store?.close()
      await app.close()
      rmSync(root, { recursive: true, force: true })
    }
  },
)
