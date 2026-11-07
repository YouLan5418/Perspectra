import { readFileSync } from 'node:fs'
import { createContext, Script } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { StatusState, adjudicateItemChanges, parseStatusOperationResult } from '@harness-world/application'
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
    expect(def.statuses.map(s => s.key)).toEqual([
      'rpg-hp',
      'rpg-hp-max',
      'rpg-mp',
      'rpg-mp-max',
      'rpg-equipment',
      'rpg-party',
    ])
    expect(def.statuses[1]?.locations).toEqual(['location:ruin-1', 'location:ruin-2'])
    expect(def.operations.map(o => o.id)).toEqual([
      'rpg-rest',
      'rpg-use',
      'rpg-equip',
      'rpg-unequip',
      'rpg-join',
      'rpg-leave',
    ])
    const init = scripts.initialize(['character:player', 'character:cheng', 'character:aru']) as {
      characters: Record<string, Record<string, unknown>>
    }
    expect(init.characters['character:player']).toMatchObject({
      'rpg-hp': 40,
      'rpg-hp-max': 40,
      'rpg-mp': 8,
      'rpg-equipment': {},
    })
    expect(init.characters['character:aru']).toMatchObject({ 'rpg-hp': 0, 'rpg-hp-max': 0 })
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
    expect(equip('character:aru', [item('entity:iron-sword', 'character:aru')]).rejectReason).toBeTruthy()
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

  it('a companion joins and leaves only herself; anyone listed but away from the leader is dropped on the next operation', () => {
    const p = plugin()
    const CHENG = 'character:cheng'
    const base = truth({})
    const party = (list: string[]) => ({
      public: { 'rpg-party': list },
      characters: { ...base.characters, [CHENG]: { 'rpg-hp': 1, 'rpg-hp-max': 30, 'rpg-mp': 0, 'rpg-mp-max': 12 } },
    })
    const at = (characterIds: string[]) => ({ ...world('location:living-room'), characterIds })
    const call = (actor: string, op: string, list: string[], here: string[]) =>
      p.resolve(party(list), actor, op, {}, at(here), null, null)
    const place = { locationId: 'location:living-room', items: [] }
    expect(p.policy({ public: {}, self: {} }, CHENG, place).operations).toContain('join')
    expect(p.policy({ public: { 'rpg-party': [CHENG] }, self: {} }, CHENG, place).operations).toContain('leave')
    expect(p.policy({ public: {}, self: {} }, PLAYER, place).operations).not.toContain('join')

    expect(call(PLAYER, 'join', [], [PLAYER, CHENG]).rejectReason).toBe('你就是队长。')
    expect(call(CHENG, 'join', [], [CHENG]).rejectReason).toBe('队长不在这里。')
    const joined = call(CHENG, 'join', [], [PLAYER, CHENG])
    expect(joined.changes).toEqual([{ holderId: null, key: 'rpg-party', value: [CHENG] }])
    expect(joined.reveals.map((r: { observerId: string }) => r.observerId).sort()).toEqual([CHENG, PLAYER].sort())
    expect(call(CHENG, 'join', [CHENG], [PLAYER, CHENG]).rejectReason).toBe('已经在队伍里了。')
    expect(call(CHENG, 'leave', [CHENG], [PLAYER, CHENG]).changes).toEqual([
      { holderId: null, key: 'rpg-party', value: [] },
    ])
    expect(call(CHENG, 'leave', [], [PLAYER, CHENG]).rejectReason).toBe('你不在队伍里。')

    // Listed but elsewhere: the leader's next operation, or hers, drops her.
    const rest = (actor: string, here: string[]) =>
      p.resolve(party([CHENG]), actor, 'rest', {}, { ...world('location:bedroom'), characterIds: here }, null, null)
    expect(rest(PLAYER, [PLAYER]).changes).toContainEqual({ holderId: null, key: 'rpg-party', value: [] })
    expect(rest(CHENG, [CHENG]).changes).toContainEqual({ holderId: null, key: 'rpg-party', value: [] })
    expect(rest(PLAYER, [PLAYER, CHENG]).changes.some((c: { key: string }) => c.key === 'rpg-party')).toBe(false)
  })

  it('ships a runtime file that can be read from source', () => {
    expect(readFileSync(new URL('./runtime/status-rules.js', import.meta.url), 'utf8')).toContain('function install')
  })

  it('keeps offering unequip for an occupied slot after the item left her hands', () => {
    const p = plugin()
    const known = { public: {}, self: { 'rpg-equipment': { weapon: 'entity:iron-sword' } } }
    const place = { locationId: 'location:ruin-1', items: [item('entity:iron-sword', 'character:cheng')] }
    expect(p.policy(known, PLAYER, place).targets?.unequip).toEqual(['entity:iron-sword'])
    const off = p.resolve(
      truth({ 'rpg-equipment': { weapon: 'entity:iron-sword' } }),
      PLAYER,
      'unequip',
      {},
      world('location:ruin-1', item('entity:iron-sword', 'character:cheng')),
      'entity:iron-sword',
      null,
    )
    expect(off.changes).toEqual([{ holderId: PLAYER, key: 'rpg-equipment', value: {} }])
  })

  it('has the host accept a use result: status shape and the consumed-item change', () => {
    const scripts = new StatusScripts({
      modules: [{ id: 'rpg', source, characters: declaration.characters, unavailableCapabilities: [] }],
    })
    const state = new StatusState(
      scripts.definition,
      [PLAYER],
      referencePack.entityIds.map(entityId => ({ entityId })),
    )
    const raw = scripts.resolve({
      truth: truth({}),
      actorId: PLAYER,
      operation: 'rpg-use',
      parameters: {},
      world: world('location:ruin-1', item('entity:potion', PLAYER, '药水')),
      targetId: 'entity:potion',
      external: null,
    } as never)
    const result = parseStatusOperationResult(raw)
    if ('rejected' in result) throw new Error(result.rejected)
    state.validate(
      [] as never,
      {
        source: { kind: 'operation', operation: 'rpg-use', actorId: PLAYER },
        changes: result.changes,
        reveals: [],
        description: result.description,
      } as never,
      [PLAYER],
    )
    const events = [
      {
        eventType: 'entity.upsert',
        data: { entityId: 'entity:potion', kind: '药水', holderId: PLAYER, locationId: null },
      },
    ]
    const drafts = adjudicateItemChanges({
      events: events as never,
      actorId: PLAYER,
      interactionId: 'status:rpg-use',
      sceneIds: [PLAYER],
      entityIds: ['entity:potion'],
      value: result.items,
    })
    expect(drafts).toHaveLength(1)
    expect(drafts[0]).toMatchObject({
      eventType: 'entity.upsert',
      data: { entityId: 'entity:potion', kind: '药水（已用完）' },
    })
  })
})
