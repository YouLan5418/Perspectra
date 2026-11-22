import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { exportProject, playActivity } from '../../apps/host/src/editor/export.ts'
import { readProject, saveGraph } from '../../apps/host/src/editor/project.ts'
import { ruleReferences, saveRule } from '../../apps/host/src/editor/rules.ts'
import { itemUses } from '../../apps/host/src/editor/item-uses.ts'
import type { ChoiceCondition } from '@perspectra/world-pack/editor-fields'

let temp: string, root: string
const key = 'read-note',
  item = 'entity:opener'
const knife = { kind: 'held', ref: item } as const,
  power = { kind: 'world', ref: 'power-on', value: true } as const
const conditions = [knife, power]
beforeEach(() => {
  temp = mkdtempSync(join(tmpdir(), 'creator-conditions-'))
  root = join(temp, 'pack')
  cpSync('examples/world-packs/porch-note', root, { recursive: true })
  saveRule(root, {
    kind: 'variable',
    base: null,
    row: { key: power.ref, label: '门廊有电', type: 'boolean', initial: true },
  })
})
afterEach(() => rmSync(temp, { recursive: true, force: true }))
function configure(condition: ChoiceCondition) {
  const base = readProject(root).graphs.find(g => g.key === key)!
  return saveGraph(root, base, {
    ...base,
    choices: base.choices.map(c => (c.id === 'open-note' ? { ...c, condition } : c)),
  })
}
it.each(['all', 'any'] as const)('applies %s to offers and settlement in a fresh copy for each start', async kind => {
  const g = configure({ kind, conditions })
  for (const [hasKnife, powerOn] of [
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ] as const) {
    const start = { take: hasKnife ? [item] : [], world: { [power.ref]: powerOn } }
    const allowed = kind === 'all' ? hasKnife && powerOn : hasKnife || powerOn
    const trial = await playActivity(root, key, {}, allowed ? 'open-note' : undefined, g, start)
    expect(trial.checks.find(c => c.id === 'open-note')?.available).toBe(allowed)
    if (allowed) expect(trial.lines?.some(l => l.text.includes('你沿封口展开便笺'))).toBe(true)
  }
  await expect(playActivity(root, key, {}, 'open-note', g, { world: { [power.ref]: false } })).rejects.toThrow()
  const { directory } = await exportProject(root, join(temp, 'out'))
  expect(readProject(directory).graphs.find(g => g.key === key)).toEqual(g)
  expect(readFileSync(join(root, 'scripts/activities/read-note.js'), 'utf8')).toBe(
    readFileSync('examples/world-packs/porch-note/scripts/activities/read-note.js', 'utf8'),
  )
})
it('indexes the precise condition and rejects invalid group members or trial inputs', async () => {
  const g = configure({ kind: 'all', conditions })
  expect(itemUses(root, item).uses).toContainEqual(
    expect.objectContaining({ id: key, choice: 'open-note', field: 'condition/0' }),
  )
  expect(ruleReferences(readProject(root), 'world', power.ref)).toContainEqual(
    expect.objectContaining({ id: key, choice: 'open-note', field: 'condition/1' }),
  )
  saveRule(root, {
    kind: 'variable',
    base: null,
    row: { key: 'secret', label: '未揭示线索', type: 'boolean', initial: true, alwaysKnown: false },
  })
  for (const invalid of [
    [],
    [knife],
    [knife, { kind: 'always' }],
    [knife, { kind: 'all', conditions }],
    [knife, { ...power, ref: 'secret' }],
    [knife, { ...power, value: 1 }],
    [power, { ...knife, ref: 'entity:missing' }],
  ]) {
    expect(() => configure({ kind: 'any', conditions: invalid } as ChoiceCondition)).toThrow()
  }
  expect(readProject(root).graphs.find(graph => graph.key === key)).toEqual(g)
  for (const start of [
    { world: { secret: true } },
    { world: { 'power-on': 1 } },
    { take: [item, item] },
    { take: ['entity:missing'] },
  ])
    await expect(playActivity(root, key, {}, undefined, g, start)).rejects.toThrow()
  await expect(
    playActivity(root, key, { 'character:player': 'scene:library' }, undefined, g, { take: [item] }),
  ).rejects.toThrow('起点无法拿起物品')
})
it('combines presence with the acting player’s local variable and excludes internal state', async () => {
  const base = readProject(root).graphs.find(g => g.key === key)!
  const privateFlag = { key: 'can-read', label: '能读便笺', scope: 'private', type: 'boolean', initial: true } as const
  const conditions = [
    { kind: 'present', ref: 'character:companion' },
    { kind: 'local', ref: privateFlag.key, value: true },
  ] as const
  const graph = saveGraph(root, base, {
    ...base,
    variables: [privateFlag],
    choices: base.choices.map(c => (c.id === 'open-note' ? { ...c, condition: { kind: 'all', conditions } } : c)),
  })
  expect(ruleReferences(readProject(root), 'local', privateFlag.key, key)[0]).toMatchObject({
    choice: 'open-note',
    field: 'condition/1',
  })
  expect((await playActivity(root, key, {}, 'open-note')).checks[0]?.available).toBe(true)
  expect((await playActivity(root, key, { 'character:companion': 'scene:library' })).checks[0]?.available).toBe(false)
  expect(() => saveGraph(root, graph, { ...graph, variables: [{ ...privateFlag, scope: 'internal' }] })).toThrow(
    '出现条件 2',
  )
})
