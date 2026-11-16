import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { WorldJsonObject } from '@perspectra/sdk/contracts'
import { WorldStore } from '@perspectra/core/store'
import type { WorldComposition } from '../../apps/host/src/official-bundle.ts'
import { WorldHostRuntime } from '../../apps/host/src/runtime/world-runtime.ts'
import { fakeModels, startFakeProvider } from './fake-provider.ts'

// tests/fixtures/rpg-pack registers rpg.json; the host generates its activities, status module and rules. This
// helper only copies the pack so a test can move people or edit rpg.json, and answers model calls.

const FIXTURE = resolve('tests/fixtures/rpg-pack')
type Json = Record<string, any>
const readJson = (path: string): Json => JSON.parse(readFileSync(path, 'utf8'))
const writeJson = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n')

export interface RpgFixtureOptions {
  /** Edit rpg.json in the copy. */
  config?: (config: Json) => void
  /** Initial locations by character id. */
  places?: Record<string, string>
  /** The fake model's decision for each request (the parsed request JSON). Defaults to abstaining. */
  decide?: (input: WorldJsonObject) => unknown
  /** Any other change to the copied pack directory. */
  edit?: (pack: string) => void
  /** Defaults to the standard install. */
  composition?: WorldComposition
}

/** A temporary copy of the fixture pack and an empty data directory beside it. */
export function copyRpgFixture(options: Pick<RpgFixtureOptions, 'config' | 'places' | 'edit'> = {}) {
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
  if (options.config) {
    const raw = readJson(join(pack, 'rpg.json'))
    options.config(raw)
    writeJson(join(pack, 'rpg.json'), raw)
  }
  options.edit?.(pack)
  return { root, pack, data }
}

/** Open a world from a pack directory with the real host runtime and a fake model. */
export async function openRpgWorld(
  pack: string,
  data: string,
  options: Pick<RpgFixtureOptions, 'decide' | 'composition'> = {},
) {
  const inputs: WorldJsonObject[] = []
  const provider = await startFakeProvider('openai', call => {
    const input = JSON.parse(call.userText) as WorldJsonObject
    inputs.push(input)
    return { tool: options.decide?.(input) ?? { decision: 'abstain' } }
  })
  let runtime: WorldHostRuntime
  try {
    runtime = await WorldHostRuntime.create({
      packPath: pack,
      dataDirectory: data,
      models: fakeModels(provider.endpoint),
      timeoutMs: 5000,
      ...(options.composition ? { composition: options.composition } : {}),
    })
  } catch (error) {
    await provider.close()
    throw error
  }
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
    },
  }
}

/** Copy the fixture pack and open it. */
export async function openRpgFixture(options: RpgFixtureOptions = {}) {
  const { root, pack, data } = copyRpgFixture(options)
  try {
    const world = await openRpgWorld(pack, data, options)
    return {
      ...world,
      async close() {
        await world.close()
        rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
      },
    }
  } catch (error) {
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    throw error
  }
}
export type RpgFixture = Awaited<ReturnType<typeof openRpgFixture>>
