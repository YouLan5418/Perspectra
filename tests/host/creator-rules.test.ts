import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { ruleCandidates, ruleReferences, saveRule, assistRule } from '../../apps/host/src/editor/rules.ts'
import { readProject, saveGraph } from '../../apps/host/src/editor/project.ts'
import { exportProject, playRules } from '../../apps/host/src/editor/export.ts'
import { LensSimulation } from '../../apps/host/src/simulation/simulation.ts'
import { runEditorCli } from '../../apps/host/src/editor/cli.ts'
import { eventOptions, eventReferences } from '../../apps/host/src/editor/event-options.ts'
import { editorCommand } from '../../apps/host/src/editor/commands.ts'
import type { EditorGraph } from '../../apps/host/src/editor/activity-graph.ts'
let temp: string, root: string
beforeEach(() => {
  temp = mkdtempSync(join(tmpdir(), 'creator-rules-'))
  root = join(temp, 'pack')
  cpSync('examples/world-packs/porch-note', root, { recursive: true })
})
afterEach(() => rmSync(temp, { recursive: true, force: true }))
const light = { key: 'light', label: '门廊灯光', type: 'boolean', initial: true }
const event = {
  id: 'blackout',
  type: 'power.outage@1',
  observation: '门廊的灯灭了',
  trigger: 'paced',
  location: 'location:start',
  round: 1,
  set: { key: 'light', value: false },
}
function setUp() {
  saveRule(root, { kind: 'variable', base: null, row: light })
}
it('authors calendar events with an item audience, notice locations, grants and scoped source-operation candidates', async () => {
  setUp()
  for (const row of [
    { key: 'day', label: '日期', type: 'number', initial: 1 },
    { key: 'slot', label: '时段', type: 'string', initial: '晨', options: ['晨', '晚'] },
  ])
    saveRule(root, { kind: 'variable', base: null, row })
  const options = await eventOptions(root),
    npc = 'character:companion',
    other = options.locations.find(l => l.id !== 'location:start')!.id
  expect(options.periods.find(v => v.key === 'slot')?.options).toEqual(['晨', '晚'])
  expect(options.actors.map(v => v.id)).toEqual([npc])
  const when = { crossesPackTime: { dayKey: 'day', slotKey: 'slot', slots: ['晨', '晚'], at: { day: 2, slot: '晚' } } }
  const rule = {
    id: 'bell',
    type: 'bell.rings@1',
    location: 'location:start',
    observation: '钟声响了',
    set: { key: 'light', value: true },
    when,
    wakeCharacters: [npc],
    sceneNotices: [{ locations: [other] }],
  }
  await editorCommand(root, { operation: 'rule-save', kind: 'event', base: null, row: rule })
  const invalid = { ...rule, sceneNotices: [{ locations: [other], fromOperation: 'missing' }] }
  await expect(
    editorCommand(root, { operation: 'rule-save', kind: 'event', base: rule, row: invalid }),
  ).rejects.toThrow('来源操作')
  expect(eventReferences(root, 'location', other)[0]?.label).toContain('通知地点')
  expect(eventReferences(root, 'character', npc)[0]?.id).toBe('bell')
  const second = { ...event, id: 'watch', audience: { anyOf: ['scene', { holds: 'entity:opener' }] } }
  saveRule(root, { kind: 'event', base: null, row: second })
  const grants = [{ plugin: 'pack-scripts', type: rule.type, mode: 'durable', effect: { key: 'light', value: false } }]
  saveRule(root, { kind: 'grants', base: [], row: grants })
  expect((await eventOptions(root)).grants).toEqual(grants)
  expect(() => saveRule(root, { kind: 'grants', base: [], row: [] })).toThrow('已更改')
  const out = await exportProject(root, join(temp, 'export'))
  const result = JSON.parse(readFileSync(join(out.directory, 'world-events.json'), 'utf8'))
  expect(result).toMatchObject({ rules: [rule, second], grants })
  saveRule(out.directory, { kind: 'grants', base: grants, row: [] })
  const file = join(out.directory, 'world-events.json')
  const changed = JSON.parse(readFileSync(file, 'utf8'))
  changed.grants = grants
  writeFileSync(file, JSON.stringify(changed))
  expect(() => saveRule(out.directory, { kind: 'grants', base: [], row: [] })).toThrow('已更改')
  const sim = await LensSimulation.open(out.directory)
  await sim.close()
})
function graph(): EditorGraph {
  return {
    key: 'reading',
    title: '阅读',
    opening: '开始读信',
    variables: [
      { key: 'pages', label: '已读页数', scope: 'private', type: 'number', initial: 0 },
      { key: 'hidden', label: '内部', scope: 'internal', type: 'boolean', initial: false },
    ],
    choices: [
      {
        id: 'page',
        label: '翻页',
        condition: { kind: 'world', ref: 'light', value: true },
        effect: { kind: 'local', ref: 'pages', value: 1 },
        result: '读完一页',
        speech: '',
        next: 'stay',
      },
      {
        id: 'switch',
        label: '关灯',
        condition: { kind: 'local', ref: 'pages', value: 1 },
        effect: { kind: 'world', ref: 'light', value: false },
        result: '关了灯',
        speech: '',
        next: 'stay',
      },
    ],
  }
}
it('reuses stable keys, confines local variables and rejects incompatible edits before writing', async () => {
  for (const initial of [0.5, -0, Number.MAX_SAFE_INTEGER + 1])
    expect(() => saveRule(root, { kind: 'variable', base: null, row: { ...light, type: 'number', initial } })).toThrow(
      '初值',
    )
  setUp()
  const g = saveGraph(root, null, graph())
  saveGraph(root, null, {
    ...graph(),
    key: 'other',
    variables: [{ key: 'marker', label: '已读页数', scope: 'shared', type: 'boolean', initial: false }],
    choices: [],
  })
  const p = readProject(root)
  expect(ruleCandidates(p, 'condition', 'reading').map(v => ('key' in v ? v.key : null))).toEqual(['light', 'pages'])
  expect(ruleCandidates(p, 'effect', 'other').map(v => ('key' in v ? v.key : null))).toEqual(['light', 'marker'])
  saveRule(root, { kind: 'variable', base: null, row: { ...light, key: 'secret', alwaysKnown: false } })
  expect(ruleCandidates(readProject(root), 'condition', 'reading')).not.toContainEqual(
    expect.objectContaining({ key: 'secret' }),
  )
  expect(ruleReferences(p, 'world', 'light').map(r => r.field)).toEqual(['condition', 'effect'])
  expect(() =>
    saveGraph(root, g, {
      ...g,
      choices: [{ ...g.choices[0], condition: { kind: 'local', ref: 'hidden', value: true } }],
    }),
  ).toThrow('出现条件')
  await assistRule(
    root,
    { provider: 'codex', kind: 'variable', id: 'light', base: light, prompt: '改名' },
    undefined,
    async (_provider, prompt) => {
      expect(prompt).toContain('门廊灯光')
      return '{"label":"照明"}'
    },
  )
  expect(() => saveRule(root, { kind: 'variable', base: light, row: light })).toThrow('已更改')
  expect(() =>
    saveRule(root, {
      kind: 'variable',
      base: { ...light, label: '照明' },
      row: { ...light, type: 'number', initial: 1 },
    }),
  ).toThrow('出现条件')
  expect(((await runEditorCli(['open', root])) as typeof p).rules.variables[0]?.label).toBe('照明')
})
it('executes scoped reads and writes in the host, and preserves editor declarations across two exports', async () => {
  setUp()
  const g = saveGraph(root, null, graph())
  const first = (await exportProject(root, join(temp, 'export-1'))).directory
  const original = readFileSync(join(root, 'scripts/status.js'), 'utf8')
  expect(readFileSync(join(first, 'scripts/status.js'), 'utf8').startsWith(original)).toBe(true)
  saveRule(first, { kind: 'variable', base: light, row: { ...light, label: '照明' } })
  const second = (await exportProject(first, join(temp, 'export-2'))).directory
  const p = readProject(second)
  expect(p.rules.variables.map(v => v.label)).toEqual(['照明'])
  expect(p.graphs.find(x => x.key === g.key)).toEqual(g)
  const sim = await LensSimulation.open(second)
  try {
    const step = async (id: string) => {
      const state = (await sim.state()).activities?.find(a => a.activityKey === g.key)
      const trace = await sim.step({
        kind: 'activity',
        request: {
          activityKey: g.key,
          activityId: id === 'start' ? null : String(state!.id),
          revision: id === 'start' ? 0 : Number(state!.revision),
          operation: id,
          parameters: {},
        },
      })
      expect(trace.error).toBeUndefined()
      expect(trace.lines.filter(l => l.kind === 'rejected')).toEqual([])
    }
    const offered = async () =>
      (
        ((await sim.state()).activities?.find(a => a.activityKey === g.key)?.options ?? []) as {
          definitionRef: { id: string }
        }[]
      ).map(o => o.definitionRef.id)
    await step('start')
    expect(await offered()).toContain('activity:page')
    expect(await offered()).not.toContain('activity:switch')
    await step('page')
    expect(await offered()).toContain('activity:switch')
    await step('switch')
    expect(await offered()).not.toContain('activity:page')
    expect((await sim.statusTruth()).public).toMatchObject({ light: false })
  } finally {
    await sim.close()
  }
}, 60000)
it('permits only paced rules in the table and reports witnesses from committed game observations', async () => {
  setUp()
  saveRule(root, { kind: 'event', base: null, row: event })
  saveRule(root, { kind: 'event', base: null, row: { ...event, id: 'later', round: 9, trigger: 'hard' } })
  const project = readProject(root)
  expect(ruleCandidates(project, 'pacing')).toContainEqual(expect.objectContaining({ id: 'later', eligible: false }))
  expect(() => saveRule(root, { kind: 'pacing', base: null, row: { id: 'later', intensity: 'high' } })).toThrow(
    '节奏触发',
  )
  saveRule(root, { kind: 'pacing', base: null, row: { id: 'blackout', intensity: 'high' } })
  expect(ruleReferences(readProject(root), 'event', 'blackout')).toHaveLength(1)
  expect(() => saveRule(root, { kind: 'event', base: event, row: { ...event, trigger: 'hard' } })).toThrow('节奏触发')
  const trial = await playRules(root, 1)
  expect(trial.publicStatus).toMatchObject({ light: false })
  expect(trial.occurrences).toEqual([
    expect.objectContaining({
      id: 'blackout',
      witnesses: expect.arrayContaining(['character:player', 'character:companion']),
      wakeRecipients: [],
    }),
  ])
}, 60000)
