import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { ContentPackFacts } from '@perspectra/sdk'
import { isDiceExpression, parseTrpgConfig } from './config.ts'
import { officialTrpgContent } from './content.ts'

type Json = Record<string, any>
const reference = (): Json =>
  JSON.parse(readFileSync(new URL('./fixtures/rainy-manor.trpg.json', import.meta.url), 'utf8'))
/** The ids of tests/fixtures/trpg-pack. */
const pack: ContentPackFacts = {
  characterIds: ['character:player', 'character:aru', 'character:cheng', 'character:mei'],
  locationIds: ['location:living-room'],
  entityIds: [],
  entityLocations: {},
  playerId: 'character:player',
  names: { 'character:player': '玩家', 'character:aru': '阿茹', 'character:cheng': '澄', 'character:mei': '梅' },
}
const messageFor = (change: (c: Json) => void) => {
  const value = reference()
  change(value)
  try {
    parseTrpgConfig(value, pack)
  } catch (error) {
    expect(error).toBeInstanceOf(TypeError)
    return (error as Error).message
  }
  return ''
}

describe('parseTrpgConfig', () => {
  it('accepts the reference config', () => {
    const config = parseTrpgConfig(reference(), pack)
    expect(config.sheet.stats.map(s => s.key)).toEqual(['hp', 'sanity'])
    expect(config.sheet.dice).toBe('d20')
    expect(config.hosts).toEqual(['character:aru', 'character:mei'])
    expect(config.scenarios?.[0]?.content.filter(c => !c.public).map(c => c.name)).toEqual(['账本'])
    expect(config.themes).toHaveLength(2)
  })

  it('accepts a config with neither scenarios nor themes', () => {
    const value = reference()
    delete value.scenarios
    delete value.themes
    delete value.characters
    delete value.hosts
    const config = parseTrpgConfig(value, pack)
    expect(config.scenarios).toBeUndefined()
    expect(config.themes).toBeUndefined()
  })

  it('names the path of an unknown or player character and host', () => {
    const cases: [(c: Json) => void, string][] = [
      [c => (c.characters['character:ghost'] = {}), 'characters.character:ghost'],
      [c => (c.characters['character:player'] = {}), 'characters.character:player'],
      [c => (c.hosts = ['character:aru', 'character:ghost']), 'hosts[1]'],
      [c => (c.hosts = ['character:player']), 'hosts[0]'],
      [c => (c.characters['character:cheng'].skills.climb = 1), 'characters.character:cheng.skills.climb'],
      [c => (c.characters['character:mei'].stats.sanity = 11), 'characters.character:mei.stats.sanity'],
    ]
    for (const [change, path] of cases)
      expect(messageFor(change)).toMatch(new RegExp(`^${path.replace(/[.[\]]/gu, '\\$&')}：`, 'u'))
    expect(messageFor(c => (c.hosts = ['character:ghost']))).toContain('character:ghost')
  })

  it('rejects a dice expression parseDice would refuse', () => {
    for (const dice of ['d1', '0d6', '21d6', 'd20+02', 'd20+1001', 'D20', '2d6+1+1', '', 20])
      expect(messageFor(c => (c.sheet.dice = dice))).toMatch(/^sheet\.dice：/u)
  })

  it('checks the sheet shape and the scenario content', () => {
    expect(messageFor(c => (c.sheet.stats = []))).toMatch(/^sheet\.stats：/u)
    expect(
      messageFor(
        c =>
          (c.sheet.skills = Array.from({ length: 13 }, (_, i) => ({
            key: 'a' + 'b'.repeat(i),
            label: 'x',
            modifier: 0,
          }))),
      ),
    ).toMatch(/^sheet\.skills：/u)
    expect(messageFor(c => (c.sheet.stats[0].key = 'Hp1'))).toMatch(/^sheet\.stats\[0\]\.key：/u)
    expect(messageFor(c => (c.sheet.skills[1].key = 'agility'))).toMatch(/^sheet\.skills：/u)
    expect(messageFor(c => (c.plugin.version = '2'))).toMatch(/^plugin\.version：/u)
    expect(messageFor(c => (c.extra = 1))).toMatch(/^extra：/u)
    expect(messageFor(c => (c.scenarios[0].content[2].location = '地下室'))).toMatch(
      /^scenarios\[0\]\.content\[2\]\.location：/u,
    )
    // A public entry placed in a hidden place would print that place's name in public content.
    expect(messageFor(c => (c.scenarios[0].content[0].public = false))).toMatch(
      /^scenarios\[0\]\.content\[2\]\.location：.*隐藏地点/u,
    )
    expect(messageFor(c => (c.scenarios[0].content[0].kind = 'monster'))).toMatch(
      /^scenarios\[0\]\.content\[0\]\.kind：/u,
    )
    expect(messageFor(c => c.scenarios.push(c.scenarios[0]))).toMatch(/^scenarios\[1\]\.id：/u)
    expect(messageFor(c => (c.themes = ['同一个', '同一个']))).toMatch(/^themes\[1\]：/u)
  })
})

describe('isDiceExpression', () => {
  it('accepts the forms the design names', () => {
    for (const dice of ['d20', 'd100', '1d20+2', '2d6-1', '20d1000+1000', 'd2-1000'])
      expect(isDiceExpression(dice)).toBe(true)
  })
})

describe('officialTrpgContent', () => {
  it('reads trpg.json and generates one trpg activity that opens in setup', () => {
    expect(officialTrpgContent).toMatchObject({
      id: 'official-trpg',
      version: '1',
      configFile: 'trpg.json',
      dataVersion: 1,
      supportedDataVersions: [1],
    })
    const generated = officialTrpgContent.generate(reference(), pack)
    expect(generated.statusModules).toBeUndefined()
    expect(generated.rules).toBeUndefined()
    expect(generated.activities?.map(a => a.key)).toEqual(['trpg'])
    const again = officialTrpgContent.generate(reference(), pack)
    expect(again.activities?.[0]?.activity.definition).toEqual(generated.activities?.[0]?.activity.definition)
    expect(again.activities?.[0]?.activity.phases).toEqual(generated.activities?.[0]?.activity.phases)
  })

  it('throws the path-prefixed TypeError on bad config', () => {
    const value = reference()
    value.hosts = ['character:ghost']
    expect(() => officialTrpgContent.generate(value, pack)).toThrow(/^hosts\[0\]：/u)
  })
})
