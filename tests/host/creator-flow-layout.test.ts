import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { readProject, saveGraph } from '../../apps/host/src/editor/project.ts'
import { parseGraph, type EditorGraph } from '../../apps/host/src/editor/activity-graph.ts'
import { exportProject } from '../../apps/host/src/editor/export.ts'
import { runEditorCli } from '../../apps/host/src/editor/cli.ts'

let dir: string, pack: string, base: EditorGraph
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'creator-flow-'))
  pack = join(dir, 'pack')
  cpSync('examples/world-packs/porch-note', pack, { recursive: true })
  base = readProject(pack).graphs[0]!
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

it('exports nested layout and merges an independent CLI text edit without changing gameplay for layout alone', async () => {
  const layout = [
    { id: 'letters', title: '便笺' },
    { id: 'unseal', title: '拆阅便笺', parent: 'letters', x: 80, y: 45 },
    { id: 'open-note', parent: 'unseal' },
  ]
  const moved = saveGraph(pack, base, { ...base, layout })
  const { directory } = await exportProject(pack, join(dir, 'out'))
  expect(readProject(directory).graphs[0]).toEqual(moved)
  expect(readFileSync(join(directory, 'scripts/activities/read-note.js'), 'utf8')).toBe(
    readFileSync(join(pack, 'scripts/activities/read-note.js'), 'utf8'),
  )
  const request = join(dir, 'save.json')
  writeFileSync(request, JSON.stringify({ base, graph: { ...base, title: '新的标题' } }))
  const saved = await runEditorCli(['save', pack, request])
  expect(saved).toMatchObject({ layout, title: '新的标题' })
  expect(() =>
    parseGraph({
      ...base,
      layout: [
        { id: 'a', title: 'A', parent: 'b' },
        { id: 'b', title: 'B', parent: 'a' },
      ],
    }),
  ).toThrow('子流程层级')
})
it('finds the precise compound-condition member and distinguishes local variables in different activities', async () => {
  const variable = { key: 'seen', label: '读过', type: 'boolean', initial: false, scope: 'shared' } as const
  const graph = saveGraph(pack, base, {
    ...base,
    variables: [variable],
    choices: base.choices.map((c, i) =>
      i === 0
        ? { ...c, condition: { kind: 'all', conditions: [c.condition, { kind: 'local', ref: 'seen', value: false }] } }
        : c,
    ),
  })
  saveGraph(pack, null, { ...graph, key: 'another' })
  const request = join(dir, 'query.json')
  writeFileSync(request, JSON.stringify({ kind: 'local', id: 'seen', scope: 'another' }))
  expect(await runEditorCli(['activity-references', pack, request])).toEqual([
    expect.objectContaining({ activity: 'another', choice: 'open-note', field: 'condition/1', valid: true }),
  ])
  const dirty = structuredClone(graph)
  dirty.choices[0]!.condition = { kind: 'held', ref: 'entity:missing' }
  writeFileSync(join(pack, 'creator-activities', graph.key + '.json'), JSON.stringify(dirty))
  writeFileSync(request, JSON.stringify({ kind: 'held', id: 'entity:missing' }))
  expect(await runEditorCli(['activity-references', pack, request])).toEqual([
    expect.objectContaining({ field: 'condition', valid: false }),
  ])
})
