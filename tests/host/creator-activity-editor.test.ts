import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { compileWorldPackSource } from '@perspectra/world-pack'
import { EditConflict, readProject, saveGraph } from '../../apps/host/src/editor/project.ts'
import { exportProject, playActivity } from '../../apps/host/src/editor/export.ts'
import { applyAssistantChanges, assistActivity } from '../../apps/host/src/editor/assistant.ts'
import { LensSimulation, matchAction } from '../../apps/host/src/simulation/simulation.ts'

let temp: string, source: string
beforeEach(() => {
  temp = mkdtempSync(join(tmpdir(), 'perspectra-editor-test-'))
  source = join(temp, 'source')
  cpSync(resolve('examples/world-packs/porch-note'), source, { recursive: true })
})
afterEach(() => rmSync(temp, { recursive: true, force: true }))
it('opens a newly created world, exports its first activity and plays it in the host', async () => {
  const empty = join(temp, 'new-world')
  execFileSync(
    process.execPath,
    ['skills/perspectra-creator/scripts/create-world.mjs', empty, 'pack:first', '新故事'],
    { windowsHide: true },
  )
  expect(readProject(empty).graphs).toEqual([])
  saveGraph(empty, null, {
    key: 'arrival',
    title: '到访',
    opening: '门开了。',
    choices: [
      {
        id: 'knock',
        label: '敲门',
        condition: { kind: 'always' },
        speech: '有人在吗？',
        result: '你敲了敲门。',
        next: 'end',
      },
    ],
  })
  const { directory } = await exportProject(empty, join(temp, 'first-export'))
  const run = await playActivity(directory, 'arrival', {}, 'knock')
  expect(run.lines).toContainEqual(
    expect.objectContaining({ kind: 'speech', text: expect.stringContaining('有人在吗') }),
  )
  expect(run.packHash).toMatch(/^sha256:/)
}, 60_000)
it('retains the full proposal on conflict and undoes only what was actually applied', async () => {
  const base = readProject(source).graphs[0]!
  const manual = { ...base, title: '作者标题', opening: '相同开场' }
  const err = await assistActivity(source, { provider: 'codex', key: base.key, prompt: '调整开场和标题' }, async () => {
    saveGraph(source, base, manual)
    return JSON.stringify({ title: '助手标题', opening: '相同开场', choices: [{ id: 'leave', label: '稍后再看' }] })
  }).then(
    () => undefined,
    (e: unknown) => e,
  )
  expect(err).toBeInstanceOf(EditConflict)
  const candidate = (err as EditConflict).details().candidate!
  expect(candidate.graph.choices.find(c => c.id === 'leave')?.label).toBe('稍后再看')
  expect(readProject(source).graphs[0]).toEqual(manual)
  candidate.base.title = manual.title
  const result = applyAssistantChanges(source, candidate.base, candidate.graph)
  expect(result.saved.title).toBe('助手标题')
  expect(saveGraph(source, result.undo.base, result.undo.graph)).toEqual(manual)
})
it('discards a late model reply after its authoring request is cancelled', async () => {
  const base = readProject(source).graphs[0]!,
    controller = new AbortController()
  await expect(
    assistActivity(
      source,
      { provider: 'dsh', key: base.key, prompt: '改标题' },
      async () => {
        controller.abort()
        return '{"title":"迟到的标题"}'
      },
      controller.signal,
    ),
  ).rejects.toThrow()
  expect(readProject(source).graphs[0]).toEqual(base)
})
it('applies the assistant patch to the selected activity, preserves concurrent text, and undoes only its batch', async () => {
  const original = readProject(source).graphs[0]!
  const result = await assistActivity(
    source,
    { provider: 'codex', key: original.key, selected: 'leave', prompt: '增加另一种求助', expected: original },
    async (_provider, prompt) => {
      expect(prompt).toContain('character:companion')
      const manual = structuredClone(original)
      manual.choices[0]!.label = '拆开信封'
      saveGraph(source, original, manual)
      return JSON.stringify({
        choices: [
          {
            id: 'ask-again',
            label: '问阿林',
            condition: { kind: 'present', ref: 'character:companion' },
            speech: '你认得这封信吗？',
          },
        ],
      })
    },
  )
  expect(result.changed).toEqual(['ask-again'])
  expect(result.saved.choices[0]?.label).toBe('拆开信封')
  const undone = saveGraph(source, result.undo.base, result.undo.graph)
  expect(undone.choices.map(c => c.id)).not.toContain('ask-again')
  expect(undone.choices[0]?.label).toBe('拆开信封')
  await expect(
    assistActivity(source, { provider: 'claude', key: original.key, prompt: '增加选项' }, async () =>
      JSON.stringify({ choices: [{ id: 'bad', label: '不存在的人', condition: { kind: 'present', ref: 'missing' } }] }),
    ),
  ).rejects.toThrow('引用不存在')
  expect(readProject(source).graphs[0]).toEqual(undone)
})
it('merges independently edited fields, protects divergent edits, and reopens generated choices in an exported source', async () => {
  const initial = readProject(source).graphs[0]!,
    mine = structuredClone(initial),
    other = structuredClone(initial)
  mine.choices[1]!.label = '请教阿林'
  other.choices[1]!.result = '玩家开口求助。'
  saveGraph(source, initial, mine)
  const merged = saveGraph(source, initial, other)
  expect(merged.choices[1]).toMatchObject({ label: '请教阿林', result: '玩家开口求助。' })
  other.choices[1]!.label = '另一个版本'
  expect(() => saveGraph(source, initial, other)).toThrow('ask-alin/label')
  const reordered = saveGraph(source, merged, { ...merged, choices: [...merged.choices].reverse() })
  expect(reordered.choices.map(c => c.id)).toEqual([...merged.choices].reverse().map(c => c.id))
  const exported = join(temp, 'export')
  await exportProject(source, exported)
  expect(readProject(exported).graphs).toEqual([reordered])
  expect((await compileWorldPackSource(exported, [])).packId).toBe('pack:porch-note')
  const script = join(source, 'scripts/activities/read-note.js')
  writeFileSync(script, readFileSync(script, 'utf8') + '\n// 手工调整\n')
  await expect(exportProject(source, join(temp, 'manual'))).rejects.toThrow('手写脚本')
})
it('runs the exported option in the official host, showing it only in the authorized scene', async () => {
  const near = await playActivity(source, 'read-note', {}, 'ask-alin')
  expect(near.checks.find(c => c.id === 'ask-alin')?.available).toBe(true)
  expect(
    near.lines?.some(
      line => line.kind === 'speech' && line.actorId === 'character:player' && line.text.includes('能帮我'),
    ),
  ).toBe(true)
  const far = await playActivity(source, 'read-note', { 'character:companion': 'scene:library' })
  expect(far.checks.find(c => c.id === 'ask-alin')?.available).toBe(false)
  await expect(
    playActivity(source, 'read-note', { 'character:companion': 'scene:library' }, 'ask-alin'),
  ).rejects.toThrow()
}, 60_000)
it('checks actual custody and rejects a saved choice made after leaving the observer scene', async () => {
  const sim = await LensSimulation.open(source)
  try {
    const start = async () =>
      sim.step({
        kind: 'activity',
        request: { activityKey: 'read-note', activityId: null, revision: 0, operation: 'start', parameters: {} },
      })
    const activity = async () => (await sim.state()).activities!.find(a => a.activityKey === 'read-note')!
    await start()
    const early = await activity()
    expect(JSON.stringify(early.options)).not.toContain('activity:open-note')
    await sim.step({
      kind: 'activity',
      request: {
        activityKey: 'read-note',
        activityId: String(early.id),
        revision: Number(early.revision),
        operation: 'leave',
        parameters: {},
      },
    })
    const daily = await sim.state()
    await sim.step({
      kind: 'action',
      action: matchAction({ interact: 'status:take', target: 'entity:opener' }, daily.availableActions ?? []),
    })
    await start()
    const before = await activity()
    expect(JSON.stringify(before.options)).toContain('activity:open-note')
    const state = await sim.state()
    await sim.step({ kind: 'action', action: matchAction({ move: 'location:library' }, state.availableActions ?? []) })
    expect(JSON.stringify((await activity()).options)).not.toContain('activity:ask-alin')
    const request = {
      activityKey: 'read-note',
      activityId: String(before.id),
      revision: Number(before.revision),
      operation: 'ask-alin',
      parameters: {},
    }
    let committed = false
    try {
      const trace = await sim.step({ kind: 'activity', request })
      committed = trace.lines.some(
        line => line.kind === 'speech' || (line.kind === 'activity' && line.text.includes('开口求助')),
      )
    } catch (error) {
      expect(String(error)).toMatch(/活动|操作|失效|条件/)
    }
    expect(committed).toBe(false)
    expect((await activity()).game).toMatchObject({ active: true })
  } finally {
    await sim.close()
  }
}, 60_000)
