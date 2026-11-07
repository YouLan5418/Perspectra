import { describe, expect, it } from 'vitest'
import { parseRpgConfig } from './config.ts'
import { referenceJson, referencePack } from './fixtures/reference.ts'

type Json = Record<string, any>
const messageFor = (change: (c: Json) => void) => {
  const value = referenceJson()
  change(value)
  try {
    parseRpgConfig(value, referencePack)
  } catch (error) {
    return (error as Error).message
  }
  return ''
}

describe('parseRpgConfig', () => {
  it('accepts the reference config', () => {
    const config = parseRpgConfig(referenceJson(), referencePack)
    expect(config.stats.map(s => s.key)).toEqual(['hp', 'mp'])
    expect(config.maps[0]?.exits?.[0]?.requires?.holds).toBe('entity:iron-key')
    expect(config.retreat).toBe('stay')
  })

  it('names the path and the missing id for unknown references', () => {
    const cases: [(c: Json) => void, string, string][] = [
      [
        c => (c.characters['character:ghost'] = c.characters['character:cheng']),
        'characters.character:ghost',
        'character:ghost',
      ],
      [c => (c.maps[1].locationId = 'location:x'), 'maps[1].locationId', 'location:x'],
      [c => (c.maps[0].exits[0].to = 'location:x'), 'maps[0].exits[0].to', 'location:x'],
      [c => (c.maps[0].exits[0].requires.holds = 'entity:x'), 'maps[0].exits[0].requires.holds', 'entity:x'],
      [c => (c.consumables['entity:x'] = { restore: { hp: 1 } }), 'consumables.entity:x', 'entity:x'],
      [
        c => (c.characters['character:cheng'].skills = ['strike', 'nope']),
        'characters.character:cheng.skills[1]',
        'nope',
      ],
      [c => (c.enemies.golem.skills = ['nope']), 'enemies.golem.skills[0]', 'nope'],
      [c => (c.maps[0].enemies = ['ghoul']), 'maps[0].enemies[0]', 'ghoul'],
      [c => (c.maps[0].scripted[0].target = 'ghoul'), 'maps[0].scripted[0].target', 'ghoul'],
      [c => (c.maps[0].scripted[0].characterId = 'character:x'), 'maps[0].scripted[0].characterId', 'character:x'],
      [c => (c.rest.restore = 'half'), 'rest.restore', 'half'],
      [c => (c.skills[1].cost = { sp: 1 }), 'skills[1].cost.sp', 'sp'],
      [c => (c.party.leader = 'character:cheng2'), 'party.leader', 'character:cheng2'],
      [c => (c.defeat.to = 'location:x'), 'defeat.to', 'location:x'],
    ]
    for (const [change, path, id] of cases) {
      const message = messageFor(change)
      expect(message.startsWith(path + '：'), message).toBe(true)
      expect(message).toContain(id)
    }
  })

  it('rejects a config whose generated statuses or operations exceed the host limits', () => {
    const message = messageFor(c => {
      c.stats = Array.from({ length: 32 }, (_, i) => ({ key: 's' + i, label: 'S' + i }))
      c.characters = {}
      c.skills = []
      c.consumables = {}
      delete c.rest
      c.enemies = {}
      c.maps = []
      delete c.defeat
      delete c.party
    })
    expect(message.startsWith('stats：')).toBe(true)
  })
})
