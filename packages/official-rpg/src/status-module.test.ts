import { describe, expect, it } from 'vitest'
import { StatusState, adjudicateItemChanges, parseStatusOperationResult } from '@harness-world/application'
import { StatusScripts } from '@harness-world/official-status'
import type { StatusTruth, WorldJsonObject } from '@harness-world/contracts'
import { parseRpgConfig } from './config.ts'
import { generateStatusModule } from './status-module.ts'
import { referenceJson, referencePack } from './fixtures/reference.ts'

const config = parseRpgConfig(referenceJson(), referencePack)
const { declaration, module } = generateStatusModule(config)

type Json = Record<string, any>

const PLAYER = 'character:player'
const item = (entityId: string, holderId: string | null, kind = '物品') => ({
  entityId,
  name: kind,
  kind,
  holderId,
  locationId: null,
})
const truth = (own: Record<string, unknown>): StatusTruth =>
  ({
    public: {},
    characters: {
      [PLAYER]: { 'rpg-hp': 10, 'rpg-hp-max': 40, 'rpg-mp': 2, 'rpg-mp-max': 8, 'rpg-equipment': {}, ...own },
    },
  }) as StatusTruth
const world = (locationId: string, ...items: object[]): WorldJsonObject =>
  ({ locationId, items: { current: items } }) as unknown as WorldJsonObject

describe('generateStatusModule', () => {
  it('declares the native module for the configured characters without generating script source', () => {
    expect(declaration).toEqual({
      id: 'rpg',
      characters: ['character:player', 'character:cheng'],
      capabilities: [],
    })
    expect(typeof module.initialize).toBe('function')
    expect(typeof module.policy).toBe('function')
    expect(typeof module.resolve).toBe('function')
  })

  it('produces a definition the host accepts, with locations on stats and their maxima', () => {
    const scripts = new StatusScripts({
      modules: [{ id: 'rpg', module, characters: declaration.characters, unavailableCapabilities: [] }],
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
      'rpg-unlocked',
    ])
    expect(def.statuses[1]?.locations).toEqual(['location:ruin-1', 'location:ruin-2'])
    expect(def.operations.map(o => o.id)).toEqual([
      'rpg-rest',
      'rpg-use',
      'rpg-equip',
      'rpg-unequip',
      'rpg-unlock',
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
    const rest = (loc: string) => module.resolve(truth({}), PLAYER, 'rest', {}, world(loc), null, null) as Json
    expect(rest('location:ruin-1').rejectReason).toBeTruthy()
    expect(rest('location:bedroom').changes).toEqual([
      { holderId: PLAYER, key: 'rpg-hp', value: 40 },
      { holderId: PLAYER, key: 'rpg-mp', value: 8 },
    ])

    const use = (items: object[], own = {}) =>
      module.resolve(truth(own), PLAYER, 'use', {}, world('location:ruin-1', ...items), 'entity:potion', null) as Json
    expect(use([item('entity:potion', null)]).rejectReason).toBeTruthy()
    const used = use([item('entity:potion', PLAYER, '药水')])
    expect(used.changes).toEqual([{ holderId: PLAYER, key: 'rpg-hp', value: 30 }])
    expect(used.items).toEqual([{ entityId: 'entity:potion', kind: '药水（已用完）' }])
    expect(use([item('entity:potion', PLAYER, '药水（已用完）')]).rejectReason).toBeTruthy()
    expect(use([item('entity:potion', PLAYER, '药水')], { 'rpg-hp': 35 }).changes).toEqual([
      { holderId: PLAYER, key: 'rpg-hp', value: 40 },
    ])

    const equip = (who: string, items: object[], own = {}) =>
      module.resolve(
        truth(own),
        who,
        'equip',
        {},
        world('location:ruin-1', ...items),
        'entity:iron-sword',
        null,
      ) as Json
    expect(equip(PLAYER, [item('entity:iron-sword', null)]).rejectReason).toBeTruthy()
    expect(equip('character:aru', [item('entity:iron-sword', 'character:aru')]).rejectReason).toBeTruthy()
    expect(
      equip(PLAYER, [item('entity:iron-sword', PLAYER)], { 'rpg-equipment': { weapon: 'entity:other' } }).rejectReason,
    ).toBeTruthy()
    expect(equip(PLAYER, [item('entity:iron-sword', PLAYER)]).changes).toEqual([
      { holderId: PLAYER, key: 'rpg-equipment', value: { weapon: 'entity:iron-sword' } },
    ])
    const off = module.resolve(
      truth({ 'rpg-equipment': { weapon: 'entity:iron-sword' } }),
      PLAYER,
      'unequip',
      {},
      world('location:ruin-1', item('entity:iron-sword', PLAYER)),
      'entity:iron-sword',
      null,
    ) as Json
    expect(off.changes).toEqual([{ holderId: PLAYER, key: 'rpg-equipment', value: {} }])
  })

  it('offers only operations that can work now', () => {
    const known = {
      public: {},
      self: { 'rpg-equipment': { weapon: 'entity:iron-sword' } },
    } as unknown as WorldJsonObject
    const place = {
      locationId: 'location:bedroom',
      items: [
        item('entity:potion', PLAYER, '药水'),
        item('entity:iron-sword', PLAYER),
        item('entity:iron-key', PLAYER),
      ],
    } as unknown as WorldJsonObject
    const offer = module.policy(known, PLAYER, place)
    expect(offer.operations).toEqual(['rest', 'use', 'unequip'])
    expect(offer.targets).toEqual({ use: ['entity:potion'], unequip: ['entity:iron-sword'] })
  })

  it('a companion joins and leaves only herself; anyone listed but away from the leader is dropped on the next operation', () => {
    const CHENG = 'character:cheng'
    const base = truth({})
    const party = (list: string[]): StatusTruth =>
      ({
        public: { 'rpg-party': list },
        characters: { ...base.characters, [CHENG]: { 'rpg-hp': 1, 'rpg-hp-max': 30, 'rpg-mp': 0, 'rpg-mp-max': 12 } },
      }) as StatusTruth
    const at = (characterIds: string[]) =>
      ({ ...world('location:living-room'), characterIds }) as unknown as WorldJsonObject
    const call = (actor: string, op: string, list: string[], here: string[]) =>
      module.resolve(party(list), actor, op, {}, at(here), null, null) as Json
    const place = { locationId: 'location:living-room', items: [] } as unknown as WorldJsonObject
    expect(module.policy({ public: {}, self: {} }, CHENG, place).operations).toContain('join')
    expect(module.policy({ public: { 'rpg-party': [CHENG] }, self: {} }, CHENG, place).operations).toEqual(
      expect.arrayContaining(['leave', 'join']),
    )
    expect(module.policy({ public: {}, self: {} }, PLAYER, place).operations).not.toContain('join')

    expect(call(PLAYER, 'join', [], [PLAYER, CHENG]).rejectReason).toBe('你就是队长。')
    expect(call(CHENG, 'join', [], [CHENG]).rejectReason).toBe('队长不在这里。')
    const joined = call(CHENG, 'join', [], [PLAYER, CHENG])
    expect(joined.changes).toEqual([{ holderId: null, key: 'rpg-party', value: [CHENG] }])
    expect(joined.reveals.map((r: { observerId: string }) => r.observerId).sort()).toEqual([CHENG, PLAYER].sort())
    const again = call(CHENG, 'join', [CHENG], [PLAYER, CHENG])
    expect(again).toMatchObject({ description: '已经在队伍里了。', audience: 'self' })
    expect(again.changes).toEqual([{ holderId: null, key: 'rpg-party', value: [CHENG] }])
    expect(call(CHENG, 'leave', [CHENG], [PLAYER, CHENG]).changes).toEqual([
      { holderId: null, key: 'rpg-party', value: [] },
    ])
    const gone = call(CHENG, 'leave', [], [PLAYER, CHENG])
    expect(gone).toMatchObject({ description: '已经不在队伍里了。', audience: 'self' })
    expect(gone.changes).toEqual([{ holderId: null, key: 'rpg-party', value: [] }])
    expect(gone.reveals.map((r: { observerId: string }) => r.observerId)).toContain(CHENG)

    const rest = (actor: string, here: string[]) =>
      module.resolve(
        party([CHENG]),
        actor,
        'rest',
        {},
        { ...world('location:bedroom'), characterIds: here } as unknown as WorldJsonObject,
        null,
        null,
      ) as Json
    expect(rest(PLAYER, [PLAYER]).changes).toContainEqual({ holderId: null, key: 'rpg-party', value: [] })
    expect(rest(CHENG, [CHENG]).changes).toContainEqual({ holderId: null, key: 'rpg-party', value: [] })
    expect(rest(PLAYER, [PLAYER, CHENG]).changes.some((c: { key: string }) => c.key === 'rpg-party')).toBe(false)
  })

  it('keeps offering unequip for an occupied slot after the item left her hands', () => {
    const known = {
      public: {},
      self: { 'rpg-equipment': { weapon: 'entity:iron-sword' } },
    } as unknown as WorldJsonObject
    const place = {
      locationId: 'location:ruin-1',
      items: [item('entity:iron-sword', 'character:cheng')],
    } as unknown as WorldJsonObject
    expect(module.policy(known, PLAYER, place).targets?.unequip).toEqual(['entity:iron-sword'])
    const off = module.resolve(
      truth({ 'rpg-equipment': { weapon: 'entity:iron-sword' } }),
      PLAYER,
      'unequip',
      {},
      world('location:ruin-1', item('entity:iron-sword', 'character:cheng')),
      'entity:iron-sword',
      null,
    ) as Json
    expect(off.changes).toEqual([{ holderId: PLAYER, key: 'rpg-equipment', value: {} }])
  })

  it('has the host accept a use result: status shape and the consumed-item change', () => {
    const scripts = new StatusScripts({
      modules: [{ id: 'rpg', module, characters: declaration.characters, unavailableCapabilities: [] }],
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
