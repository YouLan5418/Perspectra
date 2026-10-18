import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { interactionPackageDescription } from '@harness-world/contracts'
import { createBasicInteractionPackage } from '@harness-world/interactions-basic'
import type { RulebookEvent } from '@harness-world/kernel'
import { compileWorldPackSource, type CompiledWorldPackV5 } from '@harness-world/world-pack'
import { PackStatus, type StatusEventData } from '../experiments/pack-status.ts'

const original = resolve('examples/world-packs/ai-girls-awaken-v10')
const market = readFileSync(resolve('tests/prototype/fixtures/status-market.js'), 'utf8')
let root: string, packPath: string, pack: CompiledWorldPackV5, plain: CompiledWorldPackV5
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'pack-status-'))
  const compile = (path: string) => compileWorldPackSource(path, [interactionPackageDescription(createBasicInteractionPackage())])
  plain = await compile(original) as CompiledWorldPackV5
  packPath = join(root, 'pack')
  cpSync(original, packPath, { recursive: true })
  writeFileSync(join(packPath, 'scripts/status.js'), market, 'utf8')
  const source = JSON.parse(readFileSync(join(packPath, 'worldpack.source.json'), 'utf8'))
  source.assetFiles.push('scripts/status.js')
  writeFileSync(join(packPath, 'worldpack.source.json'), JSON.stringify(source, null, 2), 'utf8')
  pack = await compile(packPath) as CompiledWorldPackV5
}, 60_000)
afterAll(() => rmSync(root, { recursive: true, force: true }))

const event = (data: StatusEventData): RulebookEvent => ({ eventType: 'status.updated', eventVersion: 1, data: data as never })
const withDefinition = (edit: (definition: string) => string) =>
  market.replace(/definition: \{[\s\S]*?\n {2}\},\n {2}initialize/u, match => edit(match))

describe('pack status', () => {
  it('loads only a registered, unmodified status script', () => {
    expect(PackStatus.load(original, plain)).toBeUndefined()
    expect(PackStatus.load(packPath, pack)?.statuses.map(s => s.key)).toEqual(['money', 'time', 'hp'])
    writeFileSync(join(packPath, 'scripts/status.js'), market + '\n// edited', 'utf8')
    try { expect(() => PackStatus.load(packPath, pack)).toThrow(/编译/u) }
    finally { writeFileSync(join(packPath, 'scripts/status.js'), market, 'utf8') }
  })

  it('parses the market fixture and rejects unknown keys, bad types and duplicate ids', () => {
    const status = PackStatus.parse(market, pack)
    expect(status.statuses.map(s => [s.key, s.type, s.owner])).toEqual([
      ['money', 'number', 'character'], ['time', 'number', 'public'], ['hp', 'number', 'character']])
    expect(status.statuses[2]!.activities).toEqual(['duel'])
    expect(status.operations.map(o => [o.id, o.actors])).toEqual([
      ['buy', 'any'], ['steal', 'npc'], ['check-purse', 'any'], ['set-time', 'player'], ['drink-potion', 'any']])
    expect(status.operations[1]!.characterParameters).toEqual(['targetId'])
    for (const broken of [
      withDefinition(d => d.replace("owner: 'character' },", "owner: 'character', color: 'red' },")),
      withDefinition(d => d.replace("type: 'number', owner: 'public'", "type: 'object', owner: 'public'")),
      withDefinition(d => d.replace("key: 'hp'", "key: 'money'")),
      withDefinition(d => d.replace("id: 'check-purse'", "id: 'buy'")),
      withDefinition(d => d.replace("id: 'check-purse'", "id: 'start'")),
      withDefinition(d => d.replace("key: 'hp'", "key: 'HP'")),
      withDefinition(d => d.replace("characterParameters: ['targetId']", "characterParameters: ['victim']")),
      withDefinition(d => d.replace("schema: { ...object, properties: {} } },\n      { id: 'set-time'",
        "schema: { type: 'object', properties: {} } },\n      { id: 'set-time'")),
    ]) {
      expect(broken).not.toBe(market)
      expect(() => PackStatus.parse(broken, pack)).toThrow()
    }
  })

  it('folds truth from initial and later events', () => {
    const status = PackStatus.parse(market, pack), initial = status.initialEvent()
    expect(initial.eventType).toBe('status.updated')
    const ids = pack.content.characters.map(c => c.characterId)
    expect(status.truth([initial])).toEqual({ public: { time: 0 },
      characters: Object.fromEntries(ids.map(id => [id, { money: 100, hp: 20 }])) })
    const later = event({ source: { kind: 'round', round: 1 },
      changes: [{ holderId: null, key: 'time', value: 10 }, { holderId: 'character:gpt', key: 'money', value: 70 }], reveals: [] })
    const truth = status.truth([initial, { eventType: 'world.tick-advanced', data: { tick: 1 } }, later])
    expect(truth.public).toEqual({ time: 10 })
    expect(truth.characters['character:gpt']).toEqual({ money: 70, hp: 20 })
    expect(truth.characters['character:claude']).toEqual({ money: 100, hp: 20 })
  })

  it('owner learns initial private values; others see nothing', () => {
    const status = PackStatus.parse(market, pack), events = [status.initialEvent()]
    const gpt = status.known(events, 'character:gpt')
    expect(gpt.filter(k => k.key !== 'time')).toEqual([
      { key: 'money', label: '余额', holderId: 'character:gpt', value: 100, current: true },
      { key: 'hp', label: '生命', holderId: 'character:gpt', value: 20, current: true }])
    expect(JSON.stringify(gpt)).not.toContain('character:claude')
  })

  it('a theft leaves the victim with the old value marked current:false', () => {
    const status = PackStatus.parse(market, pack)
    const theft = event({ source: { kind: 'operation', operation: 'steal', actorId: 'character:gpt' },
      changes: [{ holderId: 'character:claude', key: 'money', value: 70 }, { holderId: 'character:gpt', key: 'money', value: 130 }],
      reveals: [{ observerId: 'character:gpt', holderId: 'character:gpt', key: 'money', value: 130 }] })
    const events = [status.initialEvent(), theft]
    expect(status.known(events, 'character:claude')).toContainEqual(
      { key: 'money', label: '余额', holderId: 'character:claude', value: 100, current: false })
    expect(status.known(events, 'character:gpt')).toContainEqual(
      { key: 'money', label: '余额', holderId: 'character:gpt', value: 130, current: true })
    expect(status.known(events, 'character:gpt').some(k => k.holderId === 'character:claude')).toBe(false)
  })

  it('alwaysKnown time is visible to everyone without reveals', () => {
    const status = PackStatus.parse(market, pack)
    const events = [status.initialEvent(), event({ source: { kind: 'round', round: 1 },
      changes: [{ holderId: null, key: 'time', value: 10 }], reveals: [] })]
    for (const id of ['character:player', 'character:glm']) {
      expect(status.known(events, id)).toContainEqual({ key: 'time', label: '时间', holderId: null, value: 10, current: true })
    }
    expect(status.known([], 'character:player')).toEqual([])
  })

  it('validate rejects a reveal to an observer outside the scene', () => {
    const status = PackStatus.parse(market, pack), events = [status.initialEvent()]
    const data: StatusEventData = { source: { kind: 'operation', operation: 'check-purse', actorId: 'character:gpt' },
      changes: [], reveals: [{ observerId: 'character:gpt', holderId: 'character:gpt', key: 'money', value: 100 }] }
    expect(() => status.validate(events, data, ['character:gpt'])).not.toThrow()
    expect(() => status.validate(events, { ...data, reveals: [{ ...data.reveals[0]!, observerId: 'character:claude' }] },
      ['character:gpt'])).toThrow(/场景/u)
  })

  it('validate rejects undeclared keys, wrong types, mismatched holders and stale reveal values', () => {
    const status = PackStatus.parse(market, pack), events = [status.initialEvent()], scene = ['character:gpt']
    const source = { kind: 'operation', operation: 'buy', actorId: 'character:gpt' } as const
    for (const data of [
      { source, changes: [{ holderId: 'character:gpt', key: 'gold', value: 1 }], reveals: [] },
      { source, changes: [{ holderId: 'character:gpt', key: 'money', value: '1' }], reveals: [] },
      { source, changes: [{ holderId: 'character:gpt', key: 'money', value: Number.NaN }], reveals: [] },
      { source, changes: [{ holderId: null, key: 'money', value: 1 }], reveals: [] },
      { source, changes: [{ holderId: 'character:gpt', key: 'time', value: 1 }], reveals: [] },
      { source, changes: [{ holderId: 'character:nobody', key: 'money', value: 1 }], reveals: [] },
      { source, changes: [], reveals: [{ observerId: 'character:gpt', holderId: 'character:gpt', key: 'money', value: 90 }] },
    ] as StatusEventData[]) expect(() => status.validate(events, data, scene)).toThrow()
    expect(() => status.validate(events, { source, changes: [{ holderId: 'character:gpt', key: 'money', value: 90 }],
      reveals: [{ observerId: 'character:gpt', holderId: 'character:gpt', key: 'money', value: 90 }] }, scene)).not.toThrow()
  })

  it('validate rejects an operation-sourced change to an activity-scoped status', () => {
    const status = PackStatus.parse(market, pack), events = [status.initialEvent()], scene = ['character:gpt']
    const change = { holderId: 'character:gpt', key: 'hp', value: 25 }
    for (const source of [{ kind: 'operation', operation: 'drink-potion', actorId: 'character:gpt' },
      { kind: 'round', round: 1 }, { kind: 'activity', activityKey: 'chess', actorId: 'character:gpt' }] as const) {
      expect(() => status.validate(events, { source, changes: [change], reveals: [] }, scene)).toThrow(/活动/u)
    }
    expect(() => status.validate(events, { source: { kind: 'activity', activityKey: 'duel', actorId: 'character:gpt' },
      changes: [change], reveals: [] }, scene)).not.toThrow()
    // Unscoped statuses accept changes from activities too.
    expect(() => status.validate(events, { source: { kind: 'activity', activityKey: 'chess', actorId: 'character:gpt' },
      changes: [{ holderId: 'character:gpt', key: 'money', value: 1 }], reveals: [] }, scene)).not.toThrow()
  })
})
