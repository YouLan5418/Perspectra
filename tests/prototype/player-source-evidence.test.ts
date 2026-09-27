import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, it } from 'vitest'
import { WorldApplication } from '@harness-world/application'
import { brandId, type WorldJsonObject, type WorldJsonValue } from '@harness-world/contracts'
import { WorldStore, PlayerInputJobs } from '@harness-world/store-sqlite'
import { CognitiveMemoryService } from '@harness-world/memory'
import { currentEntityState } from '@harness-world/kernel'
import { frozenIntentWorld, intentFixtureProfile } from '../fixtures/player-intent-world.ts'

async function run(text: string, decide: (body: WorldJsonObject) => WorldJsonValue,
  check: (store: WorldStore, root: string, world: ReturnType<typeof frozenIntentWorld>) => void) {
  const root = mkdtempSync(join(tmpdir(), 'player-source-'))
  const world = frozenIntentWorld()
  const app = new WorldApplication({ worldPath: join(root, 'world.sqlite'), sessionPath: join(root, 'session.sqlite'),
    memoryPath: join(root, 'memory.sqlite'), externalCharacterActivations: true, modelBudgetTokens: 100,
    playerIntent: { profile: intentFixtureProfile, dispatch: async raw => decide((raw as WorldJsonObject).body as WorldJsonObject) } })
  let store: WorldStore | undefined
  try {
    app.activate(world)
    await app.submitText(world.manifest.address, { text, principalId: 'principal:player', idempotencyKey: 'source', correlationId: 'source' })
    await app.close()
    store = new WorldStore(join(root, 'world.sqlite'))
    check(store, root, world)
  } finally { await app.close(); store?.close(); rmSync(root, { recursive: true, force: true }) }
}
const observations = (store: WorldStore, world: ReturnType<typeof frozenIntentWorld>) => store.readEvents(world.manifest.address)
  .filter(e => e.eventType === 'observation.upsert').map(e => (e.data as WorldJsonObject).value as WorldJsonObject)

it('retains full addressed text in authorized context and captured memory without interpreting or clipping it', async () => {
  const text = 'NPC，你把日记放桌上吧。'
  await run(text, () => { throw new Error('plain text must not call the interpreter') }, (store, root, world) => {
    for (const id of ['character:player', 'character:npc', 'character:bob']) {
      const content = observations(store, world).find(o => o.observerId === id)!.content as WorldJsonObject
      expect(content.speech).toMatchObject({ text })
      expect(content.playerInput).toMatchObject({ actorId: 'character:player', sourceText: text })
      expect((content.playerInput as WorldJsonObject).sourceSpans).toMatchObject([{ text }])
    }
    expect(currentEntityState(store.readEvents(world.manifest.address), 'entity:cup')?.holderId).toBe(null)
    const memory = new CognitiveMemoryService(join(root, 'memory.sqlite'), store, undefined, 2)
    try { memory.catchUp(world.manifest.address, brandId('character:npc', 'CharacterId'), store.head(world.manifest.address).headSeq, 'source') }
    finally { memory.close() }
    const db = new DatabaseSync(join(root, 'memory.sqlite'), { readOnly: true })
    try {
      const rows = db.prepare('SELECT text_value,metadata_json FROM cognitive_memory_v2_sources').all() as { text_value: string; metadata_json: string }[]
      expect(rows.some(r => r.text_value.includes(text) && JSON.parse(r.metadata_json).playerInput?.sourceText === text)).toBe(true)
    } finally { db.close() }
  })
})

it('keeps private original words out of occurrence-only observers', async () => {
  const secret = '口令是山茶灯，只告诉你。'
  const text = '/act speak ' + JSON.stringify({ text: secret, scope: 'private', addresseeIds: ['character:npc'] })
  await run(text, () => { throw new Error('explicit command must not call the interpreter') }, (store, _root, world) => {
    const values = observations(store, world)
    expect((values.find(o => o.observerId === 'character:npc')!.content as WorldJsonObject).playerInput)
      .toMatchObject({ sourceText: secret })
    const outsider = values.find(o => o.observerId === 'character:bob')!.content as WorldJsonObject
    expect(outsider.contentVisibility).toBe('occurrence_only')
    expect(outsider).not.toHaveProperty('playerInput')
    expect(JSON.stringify(outsider)).not.toContain(secret)
  })
})

it('does not expose a move destination through original input to a departure-only witness', async () => {
  const text = '/move location:next'
  await run(text, () => { throw new Error('move command must not call the interpreter') }, (store, _root, world) => {
    const values = observations(store, world)
    const witness = values.find(o => o.observerId === 'character:npc')!.content as WorldJsonObject
    expect(witness).not.toHaveProperty('playerInput')
    expect(witness.movement).not.toHaveProperty('toLocationId')
    expect((values.find(o => o.observerId === 'character:player')!.content as WorldJsonObject).playerInput).toMatchObject({ sourceText: text })
  })
})

it('keeps malformed commands without publishing a guessed action', async () => {
  const text = '/give entity:cup'
  await run(text, () => { throw new Error('malformed command must not call the interpreter') },
    (store, root, world) => {
      expect(observations(store, world)).toHaveLength(0)
      const jobs = new PlayerInputJobs(join(root, 'world.sqlite'))
      try { expect(jobs.read(world.manifest.address, 'source')).toMatchObject({ status: 'clarification_required', input: { text } }) }
      finally { jobs.close() }
    })
})
