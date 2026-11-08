import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { interactionPackageDescription } from '@harness-world/contracts'
import { createInstalledInteractionPackages } from '@harness-world/interactions-basic'
import { compileWorldPackSource } from '@harness-world/world-pack'
import { assembleRoleplay, officialRpgContent, type WorldComposition } from '../../desktop/official-bundle.ts'
import { loadActivitySource } from '../../desktop/host/activity-source.ts'
import { PackModules } from '../../desktop/host/pack-modules.ts'
import { loadPackContent } from '../../desktop/host/pack-content.ts'
import { LensSimulation } from '../../desktop/lens/simulation.ts'
import { copyRpgFixture, openRpgWorld } from '../support/rpg-fixture.ts'

const CHENG = 'character:cheng',
  RUIN1 = 'location:ruin-1',
  RUIN2 = 'location:ruin-2'
type Json = Record<string, any>
const readJson = (path: string): Json => JSON.parse(readFileSync(path, 'utf8'))
const writeJson = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n')
const addAsset = (pack: string, path: string, contents: string) => {
  mkdirSync(join(pack, path, '..'), { recursive: true })
  writeFileSync(join(pack, path), contents)
  const source = readJson(join(pack, 'worldpack.source.json'))
  source.assetFiles.push(path)
  writeJson(join(pack, 'worldpack.source.json'), source)
}
const withoutRpg = (pack: string) => {
  const source = readJson(join(pack, 'worldpack.source.json'))
  source.assetFiles = source.assetFiles.filter((path: string) => path !== 'rpg.json')
  writeJson(join(pack, 'worldpack.source.json'), source)
  rmSync(join(pack, 'rpg.json'))
}
const compile = (pack: string) =>
  compileWorldPackSource(pack, createInstalledInteractionPackages().map(interactionPackageDescription))
/** The installed RPG generator with one skill's power changed in what it generates. */
const strongerFire = (): WorldComposition =>
  assembleRoleplay({
    content: [
      {
        ...officialRpgContent,
        generate: (value, pack) => {
          const config = structuredClone(value) as { skills: { id: string; power: number }[] }
          config.skills = config.skills.map(s => (s.id === 'fire' ? { ...s, power: s.power + 1 } : s))
          return officialRpgContent.generate(config, pack)
        },
      },
    ],
  })

const roots: string[] = []
const copy = (options: Parameters<typeof copyRpgFixture>[0] = {}) => {
  const copied = copyRpgFixture(options)
  roots.push(copied.root)
  return copied
}
const worlds: Awaited<ReturnType<typeof openRpgWorld>>[] = []
const open = async (...args: Parameters<typeof openRpgWorld>) => {
  const world = await openRpgWorld(...args)
  worlds.push(world)
  return world
}
afterEach(async () => {
  for (const world of worlds.splice(0)) await world.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
})

describe('rpg.json in a pack', () => {
  it('a pack without rpg.json opens exactly as before', async () => {
    const plain = copy({ edit: withoutRpg })
    const installed = await open(plain.pack, plain.data)
    // The install without the RPG mechanism is the host as it was before rpg.json existed.
    const before = copy({ edit: withoutRpg })
    const composition = assembleRoleplay({ content: [] })
    const previous = await open(before.pack, before.data, { composition })
    const shape = (events: ReturnType<typeof installed.events>) =>
      events.map(e => ({ seq: e.worldSeq, type: e.eventType, data: e.data }))
    expect(shape(installed.events())).toEqual(shape(previous.events()))
    expect(installed.events().some(e => JSON.stringify(e.data).includes('rpg-'))).toBe(false)
    expect(readJson(join(plain.data, 'plugin-set.json'))).toEqual(readJson(join(before.data, 'plugin-set.json')))
    expect(readJson(join(plain.data, 'plugin-set.json')).generatedContent).toBeUndefined()
  })

  it('a pack with rpg.json gets the generated activities, status module and rules', async () => {
    const { pack, data } = copy({ places: { [CHENG]: RUIN1 } })
    // Nothing generated is written into the pack.
    expect(existsSync(join(pack, 'plugins.json'))).toBe(false)
    expect(existsSync(join(pack, 'plugins/rpg.js'))).toBe(false)
    expect(existsSync(join(pack, 'scripts/activities'))).toBe(false)
    const f = await open(pack, data)
    // Status module: the stats start from rpg.json.
    const initial = f.events().find(e => e.eventType === 'status.updated')!
    expect(JSON.stringify(initial.data)).toContain('"rpg-hp"')
    // Rules: the iron door is locked without the key.
    const refused = await f.move(RUIN2)
    expect(refused.notice).toContain('铁门锁着，需要钥匙。')
    // Activities: arriving in ruin-1 starts its map activity.
    await f.move(RUIN1)
    expect(
      f.events().some(e => e.eventType === 'activity.updated' && (e.data as Json).activityKey === 'rpg-map-ruin-1'),
    ).toBe(true)
    const record = readJson(join(data, 'plugin-set.json'))
    expect(record.generatedContent).toEqual({ 'official-rpg': expect.stringMatching(/^sha256:[0-9a-f]{64}$/u) })
    expect(record.seams.rules).toEqual([{ id: 'official-rpg-rules', version: '1' }])
  })

  it('opening a saved world whose generated content changed fails with both hashes', async () => {
    const { pack, data } = copy()
    const first = await open(pack, data)
    await first.close()
    worlds.splice(worlds.indexOf(first), 1)
    const saved = readJson(join(data, 'plugin-set.json')).generatedContent['official-rpg'] as string
    const changed = loadPackContent(pack, await compile(pack), strongerFire().mechanisms.content)!.hashes[
      'official-rpg'
    ]
    expect(changed).not.toBe(saved)
    await expect(open(pack, data, { composition: strongerFire() })).rejects.toThrow(
      `official-rpg 插件生成的规则与存档不一致（存档 ${saved}，当前 ${changed}）`,
    )
    // The same content opens again.
    const again = await open(pack, data)
    expect(again.events().length).toBeGreaterThan(0)
  })

  it('editing what only the rules layer reads, such as a locked exit reason, also trips the save pin', async () => {
    const { pack, data } = copy()
    const first = await open(pack, data)
    await first.close()
    worlds.splice(worlds.indexOf(first), 1)
    const config = readJson(join(pack, 'rpg.json'))
    config.maps[0].exits[0].lockedReason = '门上的锁换了。'
    writeJson(join(pack, 'rpg.json'), config)
    await expect(open(pack, data)).rejects.toThrow('official-rpg 插件生成的规则与存档不一致')
  })

  it('an rpg.json without its plugin field says the field is missing', async () => {
    const { pack, data } = copy({ config: c => delete c.plugin })
    await expect(open(pack, data)).rejects.toThrow('rpg.json 缺少 plugin 字段')
    expect(existsSync(join(data, 'world.sqlite'))).toBe(false)
  })

  it('a pack asking for another plugin version fails before the world opens', async () => {
    const { pack, data } = copy({ config: c => (c.plugin.version = '2') })
    await expect(open(pack, data)).rejects.toThrow('rpg.json 需要插件 official-rpg 2，当前程序提供 official-rpg 1')
    expect(existsSync(join(data, 'world.sqlite'))).toBe(false)
  })

  it('the lens simulation opens an rpg.json pack with the same generated content', async () => {
    const lens = await LensSimulation.open('tests/fixtures/rpg-pack')
    try {
      expect(JSON.stringify(lens.activityDefinitions())).toContain('rpg-map-ruin-1')
      expect(JSON.stringify(lens.statusDefinition())).toContain('rpg-hp')
    } finally {
      await lens.close()
    }
  })

  it('a composition without the RPG mechanism refuses a pack that needs it', async () => {
    const { pack, data } = copy()
    const composition = assembleRoleplay({ content: [] })
    await expect(open(pack, data, { composition })).rejects.toThrow(
      '这个包的 rpg.json 需要插件 official-rpg 1，当前组合没有提供',
    )
    expect(existsSync(join(data, 'world.sqlite'))).toBe(false)
  })

  it("generated content sits beside the pack's own modules and activities, and a clash fails before the world opens", async () => {
    const own = copy({
      edit: pack => {
        addAsset(pack, 'scripts/activities/chat.js', '// own activity\n')
        addAsset(pack, 'plugins/extra.js', '// own module\n')
        addAsset(
          pack,
          'plugins.json',
          JSON.stringify({ modules: [{ id: 'extra', entry: 'plugins/extra.js', characters: [], capabilities: [] }] }),
        )
      },
    })
    const compiled = await compile(own.pack)
    const rpg = loadPackContent(own.pack, compiled, [officialRpgContent])!
    expect(loadActivitySource(own.pack, compiled, rpg.activities)!.entries.map(e => e.key)).toEqual([
      'chat',
      'rpg-map-ruin-1',
      'rpg-map-ruin-2',
    ])
    expect(PackModules.load(own.pack, compiled, undefined, rpg.statusModules)!.sources.map(s => s.id)).toEqual([
      'extra',
      'rpg',
    ])

    const activity = copy({ edit: pack => addAsset(pack, 'scripts/activities/rpg-map-ruin-1.js', '// mine\n') })
    await expect(open(activity.pack, activity.data)).rejects.toThrow(
      'official-rpg 插件生成的活动 rpg-map-ruin-1 与包内 scripts/activities/rpg-map-ruin-1.js 重名',
    )
    expect(existsSync(join(activity.data, 'world.sqlite'))).toBe(false)
    const module = copy({
      edit: pack => {
        addAsset(pack, 'plugins/rpg.js', '// mine\n')
        addAsset(
          pack,
          'plugins.json',
          JSON.stringify({ modules: [{ id: 'rpg', entry: 'plugins/rpg.js', characters: [], capabilities: [] }] }),
        )
      },
    })
    await expect(open(module.pack, module.data)).rejects.toThrow(
      'official-rpg 插件生成的模块 rpg 与包内 plugins.json 的模块重名',
    )
    expect(existsSync(join(module.data, 'world.sqlite'))).toBe(false)
  })
})
