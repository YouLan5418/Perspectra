import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, it, expect } from 'vitest'
import { readProject, saveGraph, EditConflict } from '../../apps/host/src/editor/project.ts'
import { editorCommand } from '../../apps/host/src/editor/commands.ts'
import { saveRule } from '../../apps/host/src/editor/rules.ts'
import { saveRulingScript, assistRulingScript } from '../../apps/host/src/editor/adjudication-files.ts'
import { exportProject, playActivity, assertStep } from '../../apps/host/src/editor/export.ts'
import { FrontendActions } from '../../apps/host/src/runtime/frontend-adapter.ts'
import { LensSimulation } from '../../apps/host/src/simulation/simulation.ts'
import type { EditorGraph } from '../../apps/host/src/editor/activity-graph.ts'
import { runEditorCli } from '../../apps/host/src/editor/cli.ts'
let temp: string, root: string
beforeEach(() => {
  temp = mkdtempSync(join(tmpdir(), 'creator-ruling-'))
  root = join(temp, 'pack')
  cpSync('examples/world-packs/porch-note', root, { recursive: true })
})
afterEach(() => rmSync(temp, { recursive: true, force: true }))
const key = 'search-cost',
  source =
    '// @perspectra-rule {"title":"搜查","type":"number","parameters":[{"key":"cost","label":"消耗","type":"number","initial":1}]}\nexport default function(value, parameters) {return value < parameters.cost ? {rejectReason:"精力不足。"} : {value:value-parameters.cost}}\n'
function setup() {
  saveRule(root, { kind: 'variable', base: null, row: { key: 'energy', label: '精力', type: 'number', initial: 3 } })
  saveRulingScript(root, { key, source, base: null })
  const graph: EditorGraph = {
    key: 'search',
    title: '搜查',
    opening: '门廊',
    variables: [{ key: 'clue', label: '线索', type: 'boolean', initial: false, scope: 'private' }],
    choices: [],
  }
  const common = {
    label: '搜查房间',
    condition: { kind: 'always' } as const,
    speech: '',
    next: 'stay' as const,
    result: '找到线索。',
  }
  const target = { kind: 'world' as const, ref: 'energy' }
  graph.choices.push(
    { ...common, id: 'simple', ruling: { kind: 'cost', target, amount: 1, rejectReason: '精力不足。' } },
    {
      ...common,
      id: 'scripted',
      ruling: { kind: 'script', target, script: key, parameters: { cost: 2 } },
      effect: { kind: 'local', ref: 'clue', value: true },
    },
  )
  return saveGraph(root, null, graph)
}
it('executes both ruling modes through Host, with a rejected choice leaving the cost, clue and activity revision intact', async () => {
  setup()
  const trial = await playActivity(root, 'search', {}, 'scripted')
  expect(trial.settlement).toEqual({ label: '精力', before: 3, after: 1 })
  const first = (await exportProject(root, join(temp, 'export'))).directory
  const sim = await LensSimulation.open(first)
  try {
    const state = async () => (await sim.state()).activities!.find(a => a.activityKey === 'search')!
    const step = async (operation: string) => {
      const a = await state()
      return sim.step({
        kind: 'activity',
        request: {
          activityKey: 'search',
          activityId: operation === 'start' ? null : String(a.id),
          revision: operation === 'start' ? 0 : Number(a.revision),
          operation,
          parameters: {},
        },
      })
    }
    assertStep(await step('start'))
    assertStep(await step('simple'))
    expect((await sim.statusTruth()).public).toMatchObject({ energy: 2 })
    assertStep(await step('simple'))
    const before = await state()
    const failed = await step('scripted')
    expect(() => assertStep(failed)).toThrow(/精力不足/)
    expect((await sim.statusTruth()).public).toMatchObject({ energy: 1 })
    expect(await state()).toMatchObject({ revision: before.revision, game: before.game })
    assertStep(await step('simple'))
    const empty = await step('simple')
    expect(() => assertStep(empty)).toThrow(/精力不足/)
  } finally {
    await sim.close()
  }
  const again = await LensSimulation.open(first)
  try {
    const act = async (op: string) => {
      const a = (await again.state()).activities!.find(a => a.activityKey === 'search')!
      assertStep(
        await again.step({
          kind: 'activity',
          request: {
            activityKey: 'search',
            activityId: op === 'start' ? null : String(a.id),
            revision: op === 'start' ? 0 : Number(a.revision),
            operation: op,
            parameters: {},
          },
        }),
      )
    }
    await act('start')
    await act('scripted')
    expect((await again.statusTruth()).public).toMatchObject({ energy: 1 })
    expect((await new FrontendActions(again.previewRuntime).view()).activity?.private).toMatchObject({
      variables: { clue: true },
    })
  } finally {
    await again.close()
  }
})
it('keeps JS source editable, rebuilds referenced code on re-export, and preserves hand edits', async () => {
  const graph = setup()
  const first = (await exportProject(root, join(temp, 'one'))).directory
  expect(readProject(first).graphs.find(g => g.key === graph.key)).toEqual(graph)
  const path = 'scripts/adjudications/' + key + '.js'
  expect(readFileSync(join(first, path), 'utf8')).toBe(source)
  const change = source.replace('value-parameters.cost', 'value-parameters.cost+1')
  saveRulingScript(first, { key, base: source, source: change })
  const generated = 'scripts/activities/search.js'
  const second = (await exportProject(first, join(temp, 'two'))).directory
  expect(readFileSync(join(second, generated), 'utf8')).toContain('value-parameters.cost+1')
  expect(readProject(second).graphs.find(g => g.key === graph.key)).toEqual(graph)
  writeFileSync(join(second, generated), readFileSync(join(second, generated), 'utf8') + '\n// author amendment')
  expect(readProject(second).scripts).toContain(graph.key)
  const result = await editorCommand(second, { operation: 'script-read', kind: 'activity', key: graph.key })
  expect(result).toMatchObject({
    source: expect.stringContaining('author amendment'),
    operations: expect.arrayContaining([expect.objectContaining({ id: 'scripted' })]),
  })
  const scriptPath = join(temp, 'request.json')
  writeFileSync(scriptPath, JSON.stringify({ key: 'search' }))
  expect(await runEditorCli(['ruling-candidates', first, scriptPath])).toMatchObject({
    targets: expect.arrayContaining([expect.objectContaining({ key: 'energy' })]),
  })
})
it('rejects bad bindings, reports competing source edits, and presents an AI edit until explicitly saved', async () => {
  const g = setup()
  const c = g.choices[1]!,
    rule = c.ruling!
  for (const bad of [
    { ...rule, script: 'gone' },
    { ...rule, parameters: { cost: 'two' } },
    { ...rule, target: { kind: 'local', ref: 'clue' } },
  ]) {
    expect(() => saveGraph(root, g, { ...g, choices: [{ ...c, ruling: bad }] })).toThrow()
  }
  const proposal = await assistRulingScript(
    root,
    { key, provider: 'codex', source, prompt: '调整消耗' },
    undefined,
    async () => source.replace('value-parameters.cost', 'value-parameters.cost+1'),
  )
  expect(readFileSync(join(root, 'scripts/adjudications', key + '.js'), 'utf8')).toBe(source)
  saveRulingScript(root, { key, base: source, source: proposal.source })
  expect(() => saveRulingScript(root, { key, base: source, source: source + '\n' })).toThrow(EditConflict)
})
