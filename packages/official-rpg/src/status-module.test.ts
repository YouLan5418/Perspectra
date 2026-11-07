import { readFileSync } from 'node:fs'
import { createContext, Script } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { StatusScripts } from '@harness-world/official-status'
import { parseRpgConfig } from './config.ts'
import { generateStatusModule } from './status-module.ts'
import { referenceJson, referencePack } from './fixtures/reference.ts'

const config = parseRpgConfig(referenceJson(), referencePack)
const { declaration, source } = generateStatusModule(config)

interface Plugin {
  policy(known: object, actorId: string, place: object): { operations: string[]; targets?: Record<string, string[]> }
  resolve(...args: unknown[]): any
}
/** Run the generated source like the host does and hand back the hooks it defines. */
const plugin = (): Plugin => {
  const context = createContext({})
  new Script(source).runInContext(context)
  return new Script('globalThis.packPlugin').runInContext(context) as Plugin
}

const PLAYER = 'character:player'
const item = (entityId: string, holderId: string | null, kind = '物品') => ({
  entityId,
  name: kind,
  kind,
  holderId,
  locationId: null,
})
const truth = (own: Record<string, unknown>) => ({
  public: {},
  characters: {
    [PLAYER]: { 'rpg-hp': 10, 'rpg-hp-max': 40, 'rpg-mp': 2, 'rpg-mp-max': 8, 'rpg-equipment': {}, ...own },
  },
})
const world = (locationId: string, ...items: object[]) => ({ locationId, items: { current: items } })

describe('generateStatusModule', () => {
  it('declares the module for the configured characters', () => {
    expect(declaration).toEqual({
      id: 'rpg',
      entry: 'plugins/rpg.js',
      characters: ['character:player', 'character:cheng'],
      capabilities: [],
    })
    expect(Buffer.byteLength(source)).toBeLessThan(64 * 1024)
  })

  it('produces a definition the host accepts, with locations on stats and their maxima', () => {
    const scripts = new StatusScripts({
      modules: [{ id: 'rpg', source, characters: declaration.characters, unavailableCapabilities: [] }],
    })
    const def = scripts.definition as {
      statuses: { key: string; locations?: string[] }[]
      operations: { id: string }[]
    }
    expect(def.statuses.map(s => s.key)).toEqual(['rpg-hp', 'rpg-hp-max', 'rpg-mp', 'rpg-mp-max', 'rpg-equipment'])
    expect(def.statuses[1]?.locations).toEqual(['location:ruin-1', 'location:ruin-2'])
    expect(def.operations.map(o => o.id)).toEqual(['rpg-rest', 'rpg-use', 'rpg-equip', 'rpg-unequip'])
    const init = scripts.initialize(['character:player', 'character:cheng', 'character:other']) as {
      characters: Record<string, Record<string, unknown>>
    }
    expect(init.characters['character:player']).toMatchObject({
      'rpg-hp': 40,
      'rpg-hp-max': 40,
      'rpg-mp': 8,
      'rpg-equipment': {},
    })
    expect(init.characters['character:other']).toMatchObject({ 'rpg-hp': 0, 'rpg-hp-max': 0 })
  })

  it('rest restores to max only where declared; use applies a consumable the actor holds; equip requires holding the item and a matching slot', () => {
    const p = plugin()
    const rest = (loc: string) => p.resolve(truth({}), PLAYER, 'rest', {}, world(loc), null, null)
    expect(rest('location:ruin-1').rejectReason).toBeTruthy()
    expect(rest('location:bedroom').changes).toEqual([
      { holderId: PLAYER, key: 'rpg-hp', value: 40 },
      { holderId: PLAYER, key: 'rpg-mp', value: 8 },
    ])

    const use = (items: object[], own = {}) =>
      p.resolve(truth(own), PLAYER, 'use', {}, world('location:ruin-1', ...items), 'entity:potion', null)
    expect(use([item('entity:potion', null)]).rejectReason).toBeTruthy()
    const used = use([item('entity:potion', PLAYER, '药水')])
    expect(used.changes).toEqual([{ holderId: PLAYER, key: 'rpg-hp', value: 30 }])
    expect(used.items).toEqual([{ entityId: 'entity:potion', kind: '药水（已用完）' }])
    expect(use([item('entity:potion', PLAYER, '药水（已用完）')]).rejectReason).toBeTruthy()
    expect(use([item('entity:potion', PLAYER, '药水')], { 'rpg-hp': 35 }).changes).toEqual([
      { holderId: PLAYER, key: 'rpg-hp', value: 40 },
    ])

    const equip = (who: string, items: object[], own = {}) =>
      p.resolve(truth(own), who, 'equip', {}, world('location:ruin-1', ...items), 'entity:iron-sword', null)
    expect(equip(PLAYER, [item('entity:iron-sword', null)]).rejectReason).toBeTruthy()
    expect(equip('character:other', [item('entity:iron-sword', 'character:other')]).rejectReason).toBeTruthy()
    expect(
      equip(PLAYER, [item('entity:iron-sword', PLAYER)], { 'rpg-equipment': { weapon: 'entity:other' } }).rejectReason,
    ).toBeTruthy()
    expect(equip(PLAYER, [item('entity:iron-sword', PLAYER)]).changes).toEqual([
      { holderId: PLAYER, key: 'rpg-equipment', value: { weapon: 'entity:iron-sword' } },
    ])
    const off = p.resolve(
      truth({ 'rpg-equipment': { weapon: 'entity:iron-sword' } }),
      PLAYER,
      'unequip',
      {},
      world('location:ruin-1', item('entity:iron-sword', PLAYER)),
      'entity:iron-sword',
      null,
    )
    expect(off.changes).toEqual([{ holderId: PLAYER, key: 'rpg-equipment', value: {} }])
  })

  it('offers only operations that can work now', () => {
    const p = plugin()
    const known = { public: {}, self: { 'rpg-equipment': { weapon: 'entity:iron-sword' } } }
    const place = {
      locationId: 'location:bedroom',
      items: [
        item('entity:potion', PLAYER, '药水'),
        item('entity:iron-sword', PLAYER),
        item('entity:iron-key', PLAYER),
      ],
    }
    const offer = p.policy(known, PLAYER, place)
    expect(offer.operations).toEqual(['rest', 'use', 'unequip'])
    expect(offer.targets).toEqual({ use: ['entity:potion'], unequip: ['entity:iron-sword'] })
  })

  it('ships a runtime file that can be read from source', () => {
    expect(readFileSync(new URL('./runtime/status-rules.js', import.meta.url), 'utf8')).toContain('function install')
  })
})
