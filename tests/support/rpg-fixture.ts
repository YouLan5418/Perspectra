import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { WorldJsonObject } from '@harness-world/contracts'
import { WorldStore } from '@harness-world/store-sqlite'
import { parseRpgConfig, type RpgConfig } from '../../packages/official-rpg/src/config.ts'
import { generateMapActivities } from '../../packages/official-rpg/src/map-activity.ts'
import { generateStatusModule } from '../../packages/official-rpg/src/status-module.ts'
import { WorldHostRuntime } from '../../desktop/host/world-runtime.ts'
import { fakeModels, startFakeProvider } from './fake-provider.ts'

// Temporary wiring until Task 8 loads rpg.json in the host: the generated activities and status module are written
// into a copy of tests/fixtures/rpg-pack as ordinary pack assets. Delete this helper once the host does it.

const FIXTURE = resolve('tests/fixtures/rpg-pack')
type Json = Record<string, any>
const readJson = (path: string): Json => JSON.parse(readFileSync(path, 'utf8'))
const writeJson = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n')

export interface RpgFixtureOptions {
  /** Edit rpg.json before generation. */
  config?: (config: Json) => void
  /** Initial locations by character id. */
  places?: Record<string, string>
  /** The fake model's decision for each request (the parsed request JSON). Defaults to abstaining. */
  decide?: (input: WorldJsonObject) => unknown
}

/** Copy the fixture pack, write the generated RPG content into it, and open it with the real host runtime. */
export async function openRpgFixture(options: RpgFixtureOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), 'rpg-fixture-'))
  const pack = join(root, 'pack'),
    data = join(root, 'data')
  cpSync(FIXTURE, pack, { recursive: true })
  mkdirSync(data)
  const characters = readJson(join(pack, 'characters.json'))
  for (const character of characters.characters)
    if (options.places?.[character.characterId]) character.initialLocationId = options.places[character.characterId]
  writeJson(join(pack, 'characters.json'), characters)
  // Scenes start where the characters are.
  const scenes = readJson(join(pack, 'scenes.json'))
  for (const scene of scenes.scenes) {
    scene.participantIds = characters.characters
      .filter((c: Json) => c.initialLocationId === scene.locationId)
      .map((c: Json) => c.characterId)
    scene.lifecycle = scene.participantIds.length ? 'active' : 'created'
  }
  writeJson(join(pack, 'scenes.json'), scenes)

  const raw = readJson(join(pack, 'rpg.json'))
  options.config?.(raw)
  writeJson(join(pack, 'rpg.json'), raw)
  const locations = readJson(join(pack, 'locations.json')).locations as Json[]
  const entities = readJson(join(pack, 'entities.json')).entities as Json[]
  const config: RpgConfig = parseRpgConfig(raw, {
    characterIds: characters.characters.map((c: Json) => c.characterId),
    locationIds: locations.map(l => l.locationId),
    entityIds: entities.map(e => e.entityId),
    entityLocations: Object.fromEntries(entities.map(e => [e.entityId, e.locationId ?? null])),
  })
  const names = Object.fromEntries([
    ...characters.characters.map((c: Json) => [c.characterId, c.displayName]),
    ...locations.map(l => [l.locationId, l.name]),
  ])
  const activities = generateMapActivities(config, { playerId: 'character:player', names })
  const module = generateStatusModule(config)
  mkdirSync(join(pack, 'scripts/activities'), { recursive: true })
  mkdirSync(join(pack, 'plugins'), { recursive: true })
  const assets: string[] = []
  for (const { key, source } of activities) {
    writeFileSync(join(pack, `scripts/activities/${key}.js`), source)
    assets.push(`scripts/activities/${key}.js`)
  }
  writeFileSync(join(pack, module.declaration.entry), module.source)
  writeJson(join(pack, 'plugins.json'), { modules: [module.declaration] })
  const source = readJson(join(pack, 'worldpack.source.json'))
  source.assetFiles = [...source.assetFiles, ...assets, 'plugins.json', module.declaration.entry]
  writeJson(join(pack, 'worldpack.source.json'), source)

  const inputs: WorldJsonObject[] = []
  const provider = await startFakeProvider('openai', call => {
    const input = JSON.parse(call.userText) as WorldJsonObject
    inputs.push(input)
    return { tool: options.decide?.(input) ?? { decision: 'abstain' } }
  })
  const runtime = await WorldHostRuntime.create({
    packPath: pack,
    dataDirectory: data,
    models: fakeModels(provider.endpoint),
    timeoutMs: 5000,
  })
  const events = () => {
    const store = new WorldStore(join(data, 'world.sqlite'))
    try {
      return store.readEvents(runtime.address)
    } finally {
      store.close()
    }
  }
  return {
    runtime,
    pack,
    data,
    inputs,
    events,
    move: (locationId: string) => runtime.submit('/act move ' + JSON.stringify({ locationId })),
    async close() {
      await runtime.close()
      await provider.close()
      rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    },
  }
}
export type RpgFixture = Awaited<ReturnType<typeof openRpgFixture>>
