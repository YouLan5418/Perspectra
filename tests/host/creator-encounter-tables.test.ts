import { cpSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { editorCommand } from '../../apps/host/src/editor/commands.ts'
import { encounterTables, saveTables, previewTable } from '../../apps/host/src/editor/encounter-tables.ts'
import { exportProject } from '../../apps/host/src/editor/export.ts'
import { LensSimulation } from '../../apps/host/src/simulation/simulation.ts'
import { assertStep } from '../../apps/host/src/editor/trial-controls.ts'
import type { EncounterTable } from '../../apps/host/src/runtime/encounter-tables.ts'
import { runEditorCli } from '../../apps/host/src/editor/cli.ts'
import { activityPages } from '../../apps/host/src/editor/activity-pages.ts'
import { validateInstalledPack } from '../../apps/host/src/pack-validation.ts'

let dir: string, root: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'perspectra-tables-'))
  root = join(dir, 'pack')
  cpSync('examples/world-packs/porch-note', root, { recursive: true })
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))
const table: EncounterTable = {
  key: 'porch',
  title: '门廊的差事',
  clockKey: 'watch',
  rows: [
    {
      key: 'letter',
      title: '代投便笺',
      kind: 'quest',
      location: 'location:start',
      conditions: [
        { key: 'tide', op: 'gte', value: 3 },
        { key: 'lantern', op: 'eq', value: true },
        { key: 'shift', op: 'eq', value: '暮班' },
      ],
      weight: 1,
      limit: 1,
      duration: 2,
      rewardKey: 'stamps',
      reward: 7,
    },
    { key: 'cat', title: '书房里的猫', kind: 'encounter', location: 'location:library', weight: 6 },
  ],
}
async function setup() {
  for (const [key, label, type, initial] of [
    ['watch', '更次', 'number', 1],
    ['stamps', '邮戳', 'number', 0],
    ['tide', '潮位', 'number', 3],
    ['lantern', '灯亮着', 'boolean', true],
    ['shift', '值班', 'string', '暮班'],
  ] as const)
    await editorCommand(root, {
      operation: 'rule-save',
      kind: 'variable',
      base: null,
      row: { key, label, type, initial, ...(key === 'shift' ? { options: ['早班', '暮班'] } : {}) },
    })
  return encounterTables(root)
}
it('shares the filtered pool with the real activity and settles one quest once across visits', async () => {
  const book = await setup()
  saveTables(root, { base: book.base, tables: [table] })
  const menu = (await activityPages(root)).declarations['table-porch']
  expect(menu?.operations).toContainEqual({ id: 'activity:draw', label: '抽取候选' })
  const scenario = {
    key: table.key,
    location: 'location:start',
    values: { tide: 3, lantern: true, shift: '暮班', watch: 1 },
  }
  const preview = previewTable(root, scenario)
  expect(preview.total).toBe(1)
  expect(preview.rows[1]?.reasons).toContain('需要地点：书房')
  expect(previewTable(root, { ...scenario, counts: { letter: 1 } }).total).toBe(0)
  expect(previewTable(root, { ...scenario, values: { ...scenario.values, tide: 2 } }).rows[0]?.reasons).toContain(
    '潮位 ≥ 3（当前：2）',
  )
  const request = join(dir, 'preview.json')
  writeFileSync(request, JSON.stringify(scenario))
  expect(await runEditorCli(['tables-preview', root, request])).toEqual(preview)
  expect(await editorCommand(root, { operation: 'rule-references', kind: 'world', id: 'tide' })).toContainEqual(
    expect.objectContaining({ section: 'tables', id: 'porch', field: 'letter/condition/0' }),
  )
  expect(() => saveTables(root, { base: book.base, tables: [] })).toThrow()
  const path = (await exportProject(root, join(dir, 'out'))).directory
  // Removing a previously published table in a draft hides it from authoring menus immediately.
  saveTables(path, { base: encounterTables(path).base, tables: [] })
  expect((await activityPages(path)).declarations['table-porch']).toBeUndefined()
  const sim = await LensSimulation.open(path)
  try {
    const state = async () => (await sim.state()).activities!.find(a => a.activityKey === 'table-porch')!
    async function act(operation: string) {
      const current = await state()
      assertStep(
        await sim.step({
          kind: 'activity',
          request: {
            activityKey: 'table-porch',
            activityId: operation === 'start' ? null : String(current.id),
            revision: operation === 'start' ? 0 : Number(current.revision),
            operation,
            parameters: {},
          },
        }),
      )
    }
    await act('start')
    await act('draw')
    await act('accept')
    await act('leave')
    await act('start')
    expect(JSON.stringify((await state()).options)).toContain('activity:claim')
    expect((await sim.statusTruth()).public).toMatchObject({ stamps: 0 })
    await act('claim')
    expect((await sim.statusTruth()).public).toMatchObject({ stamps: 7 })
    expect(JSON.stringify((await state()).options)).not.toMatch(/activity:(claim|draw)/u)
    await act('leave')
    await act('start')
    expect(JSON.stringify((await state()).options)).not.toMatch(/activity:(claim|draw)/u)
  } finally {
    await sim.close()
  }
}, 60000)
it('rejects missing references and invalid rows before changing the source', async () => {
  const book = await setup()
  for (const row of [
    { rewardKey: 'deleted' },
    { location: 'location:unknown' },
    { weight: 1001 },
    { completeEvent: 'missing' },
    { duration: 0 },
    { conditions: [{ key: 'missing', op: 'eq', value: 1 }] },
    { conditions: [{ key: 'lantern', op: 'gt', value: true }] },
    { conditions: [{ key: 'shift', op: 'eq', value: '午班' }] },
  ]) {
    expect(() =>
      saveTables(root, { base: book.base, tables: [{ ...table, rows: [{ ...table.rows[0], ...row }] }] }),
    ).toThrow()
  }
  expect(encounterTables(root).base).toEqual(book.base)
})
it('requires a witnessed occurrence and supports a paced event independently of the state it writes', async () => {
  const book = await setup()
  const rule = { type: 'bell.rings@1', round: 1, observation: '值班铃响了', set: { key: 'lantern', value: true } }
  for (const row of [
    { ...rule, id: 'porch-bell', trigger: 'paced', location: 'location:start' },
    { ...rule, id: 'other-bell', location: 'location:library' },
  ])
    await editorCommand(root, { operation: 'rule-save', kind: 'event', base: null, row })
  await editorCommand(root, {
    operation: 'rule-save',
    kind: 'pacing',
    base: null,
    row: { id: 'porch-bell', intensity: 'high' },
  })
  const rows: EncounterTable['rows'] = [
    { key: 'visible', title: '门廊值班', kind: 'encounter', event: 'porch-bell', rewardKey: 'stamps', reward: 1 },
    { key: 'hidden', title: '未听见的铃', kind: 'encounter', event: 'other-bell', rewardKey: 'stamps', reward: 30 },
  ]
  saveTables(root, { base: book.base, tables: [{ key: 'bells', title: '听铃', rows }] })
  expect(previewTable(root, { key: 'bells' }).total).toBe(0)
  expect(previewTable(root, { key: 'bells', events: ['porch-bell'] }).total).toBe(1)
  const exported = (await exportProject(root, join(dir, 'out'))).directory
  const sim = await LensSimulation.open(exported)
  try {
    assertStep(await sim.step({ kind: 'wait' }))
    expect(sim.worldOccurrences().find(e => e.id === 'porch-bell')?.witnesses).toContain('character:player')
    expect(sim.worldOccurrences().find(e => e.id === 'other-bell')?.witnesses).not.toContain('character:player')
    for (const operation of ['start', 'draw']) {
      const state = (await sim.state()).activities!.find(a => a.activityKey === 'table-bells')!
      assertStep(
        await sim.step({
          kind: 'activity',
          request: {
            activityKey: 'table-bells',
            activityId: operation === 'start' ? null : String(state.id),
            revision: operation === 'start' ? 0 : Number(state.revision),
            operation,
            parameters: {},
          },
        }),
      )
    }
    expect((await sim.statusTruth()).public).toMatchObject({ stamps: 1 })
  } finally {
    await sim.close()
  }
  const file = join(exported, 'gameplay-tables.json')
  const bad = JSON.parse(readFileSync(file, 'utf8'))
  bad.tables[0].rows[0].event = 'nonexistent'
  writeFileSync(file, JSON.stringify(bad))
  await expect(validateInstalledPack(exported, [])).rejects.toThrow('世界事件不存在')
}, 60000)
