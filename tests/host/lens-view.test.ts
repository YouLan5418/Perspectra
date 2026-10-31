import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { LensSimulation } from '../../desktop/lens/simulation.ts'
import { buildLensView, type LensItem, type LensView } from '../../desktop/lens/view.ts'

const PACK = resolve('examples/world-packs/model-girls-sweet-days')
let simulation: LensSimulation
let view: LensView
beforeAll(async () => {
  simulation = await LensSimulation.open(PACK)
  view = await buildLensView(PACK, simulation)
}, 60_000)
afterAll(() => simulation?.close())

const item = (id: string): LensItem => {
  const found = view.items.find(candidate => candidate.id === id)
  if (!found) throw new Error('missing item ' + id)
  return found
}
const field = (id: string, key: string) => item(id).fields.find(candidate => candidate.key === key)?.value

it('characters show autonomy', () => {
  expect(field('character:deepseek', 'everyPlayerTurns')).toBe(1)
  expect(field('character:deepseek', 'opportunities')).toBe(1)
  const interactions = field('character:deepseek', 'interactions') as string[]
  expect(interactions).toContain('做一锅热乎的黄金蛋炒饭')
  expect(interactions).not.toContain('冲泡一杯专属热饮端在手里')
})

it('events list labelled conditions', () => {
  const condition = view.items.find(
    candidate => candidate.parentId === 'event:midnight-fridge' && candidate.title === '时段是深夜',
  )
  expect(condition).toBeDefined()
  expect(condition!.fields.find(f => f.key === 'met')?.value).toBe(true)
  expect(condition!.source).toMatchObject({ kind: 'script', hook: 'autoStart', label: '时段是深夜' })
  expect(field('event:midnight-fridge', 'autoStart')).toBe(true)
})

it('statuses show opening values', () => {
  expect(field('status:slot', 'opening')).toBe('深夜')
  expect(field('status:money', 'opening:character:deepseek')).toBe(20)
})

it('knowledge is per character', () => {
  const entry = view.items.find(
    candidate =>
      candidate.section === 'knowledge' &&
      candidate.parentId === 'character:gpt' &&
      String(candidate.fields.find(f => f.key === 'content')?.value).startsWith('我有一本硬壳笔记本'),
  )
  expect(entry).toBeDefined()
})

it('every item has a resolvable source', () => {
  const sections = new Set(view.items.map(candidate => candidate.section))
  expect([...sections].sort()).toEqual(
    ['characters', 'events', 'items', 'knowledge', 'places', 'presets', 'rules', 'statuses'].sort(),
  )
  for (const candidate of view.items) {
    const { source } = candidate
    expect(existsSync(join(PACK, source.file)), candidate.id).toBe(true)
    if (source.kind !== 'json') continue
    let value: unknown = JSON.parse(readFileSync(join(PACK, source.file), 'utf8'))
    for (const part of source.pointer.split('/').slice(1)) value = (value as Record<string, unknown>)?.[part]
    expect(value, candidate.id + ' ' + source.pointer).toBeDefined()
  }
})

it('ids are stable across builds', async () => {
  const again = await buildLensView(PACK, simulation)
  expect(again.items.map(candidate => candidate.id)).toEqual(view.items.map(candidate => candidate.id))
  expect(new Set(view.items.map(candidate => candidate.id)).size).toBe(view.items.length)
  expect(again.packId).toBe('pack:model-girls-sweet-days')
})
