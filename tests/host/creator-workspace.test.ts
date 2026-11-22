import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { editorCommand } from '../../apps/host/src/editor/commands.ts'
import { worldRecords, saveRecord, queryRecords } from '../../apps/host/src/editor/world-records.ts'
import { createWorld, assistRecord } from '../../apps/host/src/editor/workspace.ts'
import { exportProject } from '../../apps/host/src/editor/export.ts'
import { LensSimulation } from '../../apps/host/src/simulation/simulation.ts'
import { EditConflict } from '../../apps/host/src/editor/project.ts'
let temp: string, source: string
beforeEach(() => {
  temp = mkdtempSync(join(tmpdir(), 'perspectra-workbench-test-'))
  source = join(temp, 'source')
})
afterEach(() => rmSync(temp, { recursive: true, force: true }))
it('changes only a selected speaking style in Sweet Days, exports the original assets and opens a fresh game', async () => {
  const original = 'examples/world-packs/model-girls-sweet-days'
  cpSync(original, source, { recursive: true })
  const npc = worldRecords(source).records.find(r => r.kind === 'character' && r.values.controllerClass === 'scripted')!
  const result = saveRecord(source, {
    kind: 'character',
    id: npc.id,
    base: npc.values,
    values: { 'portrayal.speakingStyle': '温和，使用短句。' },
  })
  expect(result.changes.map(c => c.field)).toEqual(['portrayal.speakingStyle'])
  const { directory } = await exportProject(source, join(temp, 'export'))
  const originalJson = JSON.parse(readFileSync(join(original, npc.file), 'utf8'))
  originalJson.characters.find((r: { characterId: string }) => r.characterId === npc.id).portrayal.speakingStyle =
    '温和，使用短句。'
  expect(JSON.parse(readFileSync(join(directory, npc.file), 'utf8'))).toEqual(originalJson)
  for (const file of readdirSync(directory, { recursive: true, withFileTypes: true })) {
    if (!file.isFile()) continue
    const exported = join(file.parentPath, file.name)
    if (exported === join(directory, npc.file)) continue
    expect(readFileSync(exported).equals(readFileSync(join(original, exported.slice(directory.length + 1))))).toBe(true)
  }
  const sim = await LensSimulation.open(directory)
  try {
    expect((await sim.state()).error).toBe(false)
  } finally {
    await sim.close()
  }
}, 60000)
it('creates the opening with stable references, adds records even without an entity file, and reopens it', async () => {
  await createWorld(source, { title: '门廊', player: '来客', companion: '阿林', location: '门廊' })
  await expect(
    createWorld(source, { title: '覆盖', player: '来客', companion: '阿林', location: '门廊' }),
  ).rejects.toThrow('已存在')
  const m = join(source, 'worldpack.source.json'),
    doc = JSON.parse(readFileSync(m, 'utf8'))
  doc.entityFiles = []
  writeFileSync(m, JSON.stringify(doc))
  const data = worldRecords(source),
    npc = data.records.find(r => r.name === '阿林')!
  const location = saveRecord(source, { kind: 'location', base: null, values: { name: '书房' } }).saved
  const item = saveRecord(source, {
    kind: 'item',
    base: null,
    values: { name: '钥匙', kind: 'key', locationId: location.id },
  }).saved
  const extra = saveRecord(source, {
    kind: 'character',
    base: null,
    values: { displayName: '老张', controllerClass: 'scripted', initialLocationId: location.id },
  }).saved
  saveRecord(source, {
    kind: 'scene',
    base: null,
    values: { lifecycle: 'active', locationId: location.id, participantIds: [extra.id] },
  })
  expect(queryRecords(source, { kind: 'character', field: 'initialLocationId' })).toContainEqual({
    id: location.id,
    name: '书房',
  })
  const refs = queryRecords(source, { operation: 'references', kind: 'location', id: location.id })
  expect(refs.map(r => r.id)).toContain(item.id)
  expect(queryRecords(source, { kind: 'slot', field: 'characterId' }).map(r => r.id)).toContain(npc.id)
  expect(() =>
    saveRecord(source, { kind: 'item', id: item.id, base: item.values, values: { locationId: 'missing' } }),
  ).toThrow('引用')
  const exported = await exportProject(source, join(temp, 'export'))
  expect(worldRecords(exported.directory).records).toEqual(worldRecords(source).records)
  const sim = await LensSimulation.open(exported.directory)
  try {
    expect((await sim.state()).error).toBe(false)
  } finally {
    await sim.close()
  }
}, 60000)
it('merges different fields and returns the complete AI candidate on a conflicting field', async () => {
  await createWorld(source, { title: '新作', player: '访客', companion: '阿林', location: '门廊' })
  const npc = worldRecords(source).records.find(r => r.name === '阿林')!
  const body = { kind: npc.kind, id: npc.id, base: npc.values }
  await editorCommand(source, { operation: 'record-save', ...body, values: { pronouns: '她' } })
  const result = await assistRecord(source, { ...body, prompt: '改写人设', provider: 'codex' }, undefined, async () =>
    JSON.stringify({ 'portrayal.summary': '喜欢去门廊' }),
  )
  expect(result.saved.values.pronouns).toBe('她')
  saveRecord(source, result.undo)
  expect(worldRecords(source).records.find(r => r.id === npc.id)?.values['portrayal.summary']).toBe(
    npc.values['portrayal.summary'],
  )
  const err = await assistRecord(source, { ...body, prompt: '改名', provider: 'codex' }, undefined, async () => {
    saveRecord(source, { ...body, values: { displayName: '阿玲' } })
    return JSON.stringify({ displayName: '阿琳', pronouns: '她本人' })
  }).catch((e: unknown) => e)
  expect(err).toBeInstanceOf(EditConflict)
  expect((err as EditConflict).recordCandidate?.values.pronouns).toBe('她本人')
  const candidate = (err as EditConflict).recordCandidate!
  const accepted = saveRecord(source, {
    ...body,
    base: { ...candidate.base, displayName: '阿玲' },
    values: candidate.values,
    withUndo: true,
  })
  expect(accepted.saved.values.displayName).toBe('阿琳')
  expect(saveRecord(source, accepted.undo!).saved.values).toMatchObject({ displayName: '阿玲', pronouns: '她' })
})
