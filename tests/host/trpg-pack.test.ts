import { afterEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { interactionPackageDescription } from '@perspectra/sdk/contracts'
import { createInstalledInteractionPackages } from '@perspectra/plugins/basic-interactions'
import { compileWorldPackSource } from '@perspectra/world-pack'
import { composeWorldSeams } from '../../apps/host/src/official-bundle.ts'
import { loadPackContent } from '../../apps/host/src/runtime/pack-content.ts'
import { openRpgWorld } from '../support/rpg-fixture.ts'

const FIXTURE = resolve('tests/fixtures/trpg-pack')
type Json = Record<string, any>
const readJson = (path: string): Json => JSON.parse(readFileSync(path, 'utf8'))
const compile = (pack: string) =>
  compileWorldPackSource(pack, createInstalledInteractionPackages().map(interactionPackageDescription))

const roots: string[] = []
const copy = (edit?: (pack: string) => void) => {
  const root = mkdtempSync(join(tmpdir(), 'trpg-fixture-'))
  roots.push(root)
  const pack = join(root, 'pack'),
    data = join(root, 'data')
  cpSync(FIXTURE, pack, { recursive: true })
  mkdirSync(data)
  edit?.(pack)
  return { pack, data }
}
const worlds: Awaited<ReturnType<typeof openRpgWorld>>[] = []
afterEach(async () => {
  for (const world of worlds.splice(0)) await world.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
})

describe('trpg.json in a pack', () => {
  it('a pack with trpg.json gets the trpg activity, which starts in setup with the chosen participants', async () => {
    const { pack, data } = copy()
    const world = await openRpgWorld(pack, data)
    worlds.push(world)
    const state = await world.runtime.state()
    expect(state.activities?.map(a => a.activityKey)).toEqual(['trpg'])
    await world.runtime.activityAction({
      activityKey: 'trpg',
      activityId: null,
      revision: 0,
      operation: 'start',
      parameters: { npcIds: ['character:aru', 'character:cheng', 'character:mei'] },
      requestId: randomUUID(),
    })
    const started = await world.runtime.state()
    expect(started.activity?.participants).toEqual([
      'character:player',
      'character:aru',
      'character:cheng',
      'character:mei',
    ])
    const updated = world.events().find(e => e.eventType === 'activity.updated')!
    expect((updated.data as Json).activityKey).toBe('trpg')
    expect(JSON.stringify(updated.data)).toContain('"phase":"setup"')
    expect(readJson(join(data, 'plugin-set.json')).gameplayData).toEqual({
      'official-trpg': {
        pluginVersion: '1',
        dataVersion: 1,
        statuses: [],
        activities: [{ key: 'trpg', phases: ['setup', 'invited', 'playing', 'ended'] }],
        digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
      },
    })
  })

  it('packs without trpg.json generate nothing from official-trpg', async () => {
    const generators = composeWorldSeams().content
    const { pack } = copy(pack => {
      const source = readJson(join(pack, 'worldpack.source.json'))
      source.assetFiles = []
      source.plugins = {}
      writeFileSync(join(pack, 'worldpack.source.json'), JSON.stringify(source))
      rmSync(join(pack, 'trpg.json'))
    })
    expect(loadPackContent(pack, await compile(pack), generators)).toBeUndefined()
    const rpg = resolve('tests/fixtures/rpg-pack')
    const content = loadPackContent(rpg, await compile(rpg), generators)!
    expect(Object.keys(content.hashes)).toEqual(['official-rpg'])
    expect(content.activities.every(a => a.generator === 'official-rpg')).toBe(true)
  })

  it('a bad trpg.json stops the world before it opens, naming the path', async () => {
    const { pack, data } = copy(pack => {
      const config = readJson(join(pack, 'trpg.json'))
      config.hosts = ['character:ghost']
      writeFileSync(join(pack, 'trpg.json'), JSON.stringify(config))
    })
    await expect(openRpgWorld(pack, data)).rejects.toThrow('hosts[0]：')
  })
})
