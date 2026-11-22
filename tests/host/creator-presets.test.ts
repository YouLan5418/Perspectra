import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { beforeEach, afterEach, it, expect } from 'vitest'
import {
  presetBook,
  savePreset,
  assistPreset,
  validatePresets,
  type PresetRow,
} from '../../apps/host/src/editor/presets.ts'
import { playPresets } from '../../apps/host/src/editor/preset-play.ts'
import { exportProject } from '../../apps/host/src/editor/export.ts'
import { runEditorCli } from '../../apps/host/src/editor/cli.ts'
import { worldRecords, saveRecord } from '../../apps/host/src/editor/world-records.ts'
let temp: string, root: string
const read = (dir: string, f: string) => JSON.parse(readFileSync(join(dir, f), 'utf8'))
const write = (dir: string, f: string, v: unknown) => writeFileSync(join(dir, f), JSON.stringify(v))
const companion = 'character:companion',
  visitor = 'character:visitor',
  player = 'character:player'
const pack: PresetRow = { scope: 'pack', id: '', preset: { prompt: '所有人使用短句。', temperature: 1.3 } }
const group: PresetRow = {
  scope: 'group',
  id: '门廊来客',
  members: [companion, visitor],
  preset: { prompt: '用见闻开头。', topP: 0.8 },
}
const actor: PresetRow = {
  scope: 'character',
  id: companion,
  preset: {
    nodes: [
      {
        id: 'voice',
        name: '阿林的文风',
        role: 'user',
        position: 'afterContext',
        enabled: true,
        content: '{{char}}先描述眼前的颜色。',
      },
    ],
    maxOutputTokens: 250,
  },
}
beforeEach(() => {
  temp = mkdtempSync(join(tmpdir(), 'creator-presets-'))
  root = join(temp, 'pack')
  cpSync('examples/world-packs/porch-note', root, { recursive: true })
  const c = read(root, 'characters.json'),
    s = read(root, 'scenes.json')
  c.characters.push({ ...c.characters[1], characterId: visitor, displayName: '小余' })
  s.scenes[0].participantIds.push(visitor)
  write(root, 'characters.json', c)
  write(root, 'scenes.json', s)
})
afterEach(() => rmSync(temp, { recursive: true, force: true }))
it('resolves actual Host sends separately before and after allocating bundled presets', async () => {
  for (const row of [group, pack, actor]) savePreset(root, { base: null, row })
  const expected = actor
  const trial = (assigned: boolean) => playPresets(root, { assigned, expected, text: '门廊今天好安静。' })
  const plain = await trial(false)
  expect(plain.actors).toHaveLength(2)
  for (const a of plain.actors)
    expect(a.requests[0]).toMatchObject({
      scope: 'base',
      generation: { temperature: 1.3 },
      messages: [{ content: '角色表现预设：所有人使用短句。' }],
    })
  const assigned = await trial(true)
  const ours = assigned.actors.find(a => a.id === companion)!.requests[0]!,
    theirs = assigned.actors.find(a => a.id === visitor)!.requests[0]!
  expect(ours).toMatchObject({
    scope: 'character',
    generation: { maxOutputTokens: 250 },
    messages: [{ position: 'afterContext', role: 'user', content: '阿林先描述眼前的颜色。' }],
  })
  expect(ours.generation).not.toHaveProperty('temperature')
  expect(theirs).toMatchObject({
    scope: 'group',
    name: group.id,
    generation: { topP: 0.8 },
    messages: [{ content: '角色表现预设：用见闻开头。' }],
  })
  expect(JSON.stringify(assigned)).not.toContain('speakingStyle')
}, 60000)
it('opens native sources, preserves untouched bytes and removes a cleared declared asset on export', async () => {
  write(root, 'model-preset.json', pack.preset)
  write(root, 'role-presets.json', { groups: [{ name: group.id, preset: group.preset, members: group.members }] })
  const m = read(root, 'worldpack.source.json')
  m.assetFiles.push('role-presets.json')
  write(root, 'worldpack.source.json', m)
  expect(await runEditorCli(['preset-validate', root])).toMatchObject({ valid: true, entries: 2 })
  expect(await runEditorCli(['preset-candidates', root])).toEqual([
    { id: companion, name: '阿林' },
    { id: visitor, name: '小余' },
  ])
  write(temp, 'change.json', { base: pack, row: { ...pack, preset: { prompt: '保留停顿。' } } })
  await runEditorCli(['preset-save', root, join(temp, 'change.json')])
  const out = (await exportProject(root, join(temp, 'exported'))).directory
  expect(read(out, 'model-preset.json')).toEqual({ prompt: '保留停顿。' })
  expect(readFileSync(join(out, 'role-presets.json'))).toEqual(readFileSync(join(root, 'role-presets.json')))
  expect(read(root, 'model-preset.json')).toEqual(pack.preset)
  savePreset(out, { base: group, row: null })
  const next = (await exportProject(out, join(temp, 'no-groups'))).directory
  expect(existsSync(join(next, 'role-presets.json'))).toBe(false)
  expect(read(next, 'worldpack.source.json').assetFiles).not.toContain('role-presets.json')
  expect(validatePresets(next).entries).toBe(1)
}, 30000)
it('lists both preset references and samples the same native rules from the CLI', async () => {
  for (const row of [group, actor]) savePreset(root, { base: null, row })
  const request = join(temp, 'request.json')
  write(temp, 'request.json', { id: companion })
  expect(await runEditorCli(['preset-references', root, request])).toEqual(
    expect.arrayContaining([
      { section: 'presets', id: 'group/' + group.id, label: expect.any(String) },
      { section: 'presets', id: 'character/' + companion, label: expect.any(String) },
    ]),
  )
  const slot = worldRecords(root).records.find(r => r.kind === 'slot')!
  expect(() =>
    saveRecord(root, { kind: 'slot', id: slot.id, base: slot.values, values: { characterId: companion } }),
  ).toThrow('随包预设引用')
  write(temp, 'request.json', {
    preset: {
      ...actor.preset,
      textRules: [
        {
          id: 'voice',
          name: '省略重复',
          enabled: true,
          stage: 'display',
          target: 'speech',
          pattern: '好+',
          flags: 'g',
          replacement: '好',
        },
      ],
    },
    text: '好好好',
    stage: 'display',
    target: 'speech',
  })
  expect(await runEditorCli(['preset-sample', root, request])).toMatchObject({
    messages: expect.arrayContaining([
      {
        role: 'user',
        content: '示例角色先描述眼前的颜色。',
        id: 'voice',
        name: '阿林的文风',
        enabled: true,
        position: 'afterContext',
      },
    ]),
    result: { text: '好', trace: [{ id: 'voice', name: '省略重复', text: '好' }] },
  })
})
it('allows repairing multiple stale references in a native project before export', () => {
  const missing = 'character:retired'
  write(root, 'role-presets.json', {
    characters: { [missing]: {} },
    groups: [{ name: group.id, members: [player], preset: group.preset }],
  })
  expect(() => validatePresets(root)).toThrow('不可调用')
  const stale = presetBook(root).rows
  savePreset(root, { base: stale.find(r => r.id === missing), row: null })
  expect(() => validatePresets(root)).toThrow(player)
  savePreset(root, { base: stale.find(r => r.scope === 'group'), row: group })
  expect(validatePresets(root)).toMatchObject({ valid: true, entries: 1 })
})
it('merges independent new nodes and validates assistant group membership', async () => {
  savePreset(root, { base: null, row: pack })
  const template = actor.preset.nodes![0]!
  const add = (id: string) =>
    savePreset(root, { base: pack, row: { ...pack, preset: { ...pack.preset, nodes: [{ ...template, id }] } } })
  add('a')
  add('b')
  expect(presetBook(root).rows[0]!.preset.nodes!.map(n => n.id)).toEqual(['a', 'b'])
  savePreset(root, { base: null, row: group })
  const change = await assistPreset(
    root,
    { provider: 'dsh', base: group, prompt: '只留阿林' },
    undefined,
    async (_, instruction) => {
      expect(instruction).toContain('availableMembers')
      return JSON.stringify({ members: [companion] })
    },
  )
  expect(change.rows.find(r => r.scope === 'group')?.members).toEqual([companion])
  savePreset(root, change.undo!)
  expect(presetBook(root).rows.find(r => r.scope === 'group')).toEqual(group)
})
it('rejects ineligible members and bad presets and merges concurrent fields with scoped undo', async () => {
  savePreset(root, { base: null, row: group })
  for (const row of [
    { ...group, id: '冲突组' },
    { ...actor, id: player },
    { ...actor, id: 'character:missing' },
    { ...group, id: '空组', members: [] },
    { ...pack, preset: { temperature: 10 } },
    { ...pack, preset: { nodes: [{ ...actor.preset.nodes![0], content: '{{unknown}}' }] } },
  ])
    expect(() => savePreset(root, { base: null, row })).toThrow()
  expect(presetBook(root).rows).toEqual([group])
  savePreset(root, { base: null, row: actor })
  const next = { ...actor, preset: { ...actor.preset, temperature: 0.3 } }
  const assisted = await assistPreset(
    root,
    { provider: 'claude', prompt: '改为第一人称', base: actor },
    undefined,
    async (_, prompt) => {
      expect(prompt).not.toContain(group.preset.prompt)
      savePreset(root, { base: actor, row: next })
      return '{"prompt":"以第一人称表达。"}'
    },
  )
  expect(assisted.rows.find(r => r.id === companion)?.preset).toMatchObject({
    temperature: 0.3,
    prompt: '以第一人称表达。',
  })
  savePreset(root, assisted.undo!)
  expect(presetBook(root).rows.find(r => r.id === companion)).toEqual(next)
  expect(() => savePreset(root, { base: actor, row: { ...actor, preset: { temperature: 0.4 } } })).toThrow(
    'temperature',
  )
})
