import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { fields } from '../../packages/world-pack/src/editor-fields.ts'
import { editorCommand } from '../../apps/host/src/editor/commands.ts'
import { EditConflict } from '../../apps/host/src/editor/project.ts'
import * as sourceFiles from '../../apps/host/src/editor/source-files.ts'
import { saveRecord, saveLocationOpening, worldRecords } from '../../apps/host/src/editor/world-records.ts'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'perspectra-opening-records-'))
  cpSync('examples/world-packs/porch-note', root, { recursive: true })
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
})

function record(id: string) {
  return worldRecords(root).records.find(r => r.id === id)!
}
const slotId = 'slot:player',
  player = 'character:player',
  companion = 'character:companion'

it('edits opening members through a location, reuses or creates the scene and preserves character locations', async () => {
  const start = record('scene:start'),
    library = record('scene:library')
  const select = (locationId: string, scene: typeof start | null, participantIds: string[]) =>
    saveLocationOpening(root, { locationId, sceneId: scene?.id ?? null, base: scene?.values ?? null, participantIds })
  expect(() => select('location:library', library, [companion])).toThrow('另一个启用的场景')
  const out = await editorCommand(root, {
    operation: 'location-opening-save',
    locationId: 'location:start',
    sceneId: start.id,
    base: start.values,
    participantIds: [player],
  })
  expect(out).toMatchObject({ scene: { id: start.id, values: { participantIds: [player] } } })
  expect(() => select('location:start', start, [])).toThrow(EditConflict)
  select('location:library', library, [companion])
  expect(record(library.id).values).toMatchObject({ lifecycle: 'active', participantIds: [companion] })
  expect(record(companion).values.initialLocationId).toBe('location:start')
  select('location:library', record(library.id), [])
  expect(record(library.id).values).toMatchObject({ lifecycle: 'created', participantIds: [] })
  const place = saveRecord(root, { kind: 'location', base: null, values: { name: '楼梯' } }).saved
  expect(select(place.id, null, []).scene).toBeNull()
  const added = select(place.id, null, [companion]).scene!
  expect(record(added.id).values).toMatchObject({
    locationId: place.id,
    lifecycle: 'active',
    participantIds: [companion],
  })
  expect(() => select(place.id, null, [companion])).toThrow(EditConflict)
})

it('reports every non-closed binding and never chooses one on behalf of the author', async () => {
  const first = record('scene:start'),
    locationId = 'location:start'
  const add = (id: string, lifecycle: string, place: string) =>
    saveRecord(root, { kind: 'scene', id, base: null, values: { lifecycle, locationId: place, participantIds: [] } })
      .saved
  const second = add('scene:second', 'created', locationId)
  const third = add('scene:third', 'created', locationId)
  add('scene:closed', 'closed', locationId)
  add('scene:remote', 'created', '')
  expect(await editorCommand(root, { operation: 'records' })).toMatchObject({
    sceneBindingIssues: [
      {
        locationId,
        locationName: '门廊',
        scenes: [
          { id: first.id, lifecycle: 'active' },
          { id: second.id, lifecycle: 'created' },
          { id: third.id, lifecycle: 'created' },
        ],
      },
    ],
  })
  const path = join(root, first.file),
    before = readFileSync(path)
  expect(() =>
    saveLocationOpening(root, { locationId, sceneId: first.id, base: first.values, participantIds: [player] }),
  ).toThrow('多个未关闭场景')
  expect(readFileSync(path)).toEqual(before)
  saveRecord(root, { kind: 'scene', id: third.id, base: third.values, values: { lifecycle: 'closed' } })
  saveRecord(root, { kind: 'scene', id: second.id, base: second.values, values: { locationId: '' } })
  expect(worldRecords(root).sceneBindingIssues).toEqual([])
  expect(
    saveLocationOpening(root, { locationId, sceneId: first.id, base: first.values, participantIds: [player] }).scene
      ?.id,
  ).toBe(first.id)
})

it('selects one player through the slot, including characters in separate files, and supports undo', async () => {
  const charactersPath = join(root, 'characters.json')
  const doc = JSON.parse(readFileSync(charactersPath, 'utf8'))
  const companionFile = 'other-characters.json'
  writeFileSync(join(root, companionFile), JSON.stringify({ ...doc, characters: doc.characters.splice(1) }))
  writeFileSync(charactersPath, JSON.stringify(doc))
  const manifestPath = join(root, 'worldpack.source.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifest.characterFiles.push(companionFile)
  writeFileSync(manifestPath, JSON.stringify(manifest))
  expect(fields.character.map(f => f.key)).not.toContain('controllerClass')
  const created = saveRecord(root, { kind: 'character', base: null, values: { displayName: '新人' } }).saved
  expect(created.values.controllerClass).toBe('scripted')
  expect(() =>
    saveRecord(root, {
      kind: 'character',
      id: created.id,
      base: created.values,
      values: { controllerClass: 'manual' },
    }),
  ).toThrow('玩家开局')
  expect(await editorCommand(root, { operation: 'candidates', kind: 'slot', field: 'characterId' })).toContainEqual({
    id: companion,
    name: '阿林',
  })
  const base = record(slotId).values
  const change = saveRecord(root, {
    kind: 'slot',
    id: slotId,
    base,
    values: { characterId: companion },
    withUndo: true,
  })
  expect(record(slotId).values.characterId).toBe(companion)
  expect(record(player).values.controllerClass).toBe('scripted')
  expect(record(companion).values.controllerClass).toBe('manual')
  expect(() => saveRecord(root, { kind: 'slot', id: slotId, base, values: { characterId: created.id } })).toThrow(
    EditConflict,
  )
  saveRecord(root, change.undo!)
  expect(record(slotId).values.characterId).toBe(player)
  expect(record(player).values.controllerClass).toBe('manual')
  expect(record(companion).values.controllerClass).toBe('scripted')
})

it('restores the exact source bytes if a role write fails after the slot was changed', () => {
  const slot = record(slotId)
  const before = [slot.file, record(companion).file].map(
    file => [join(root, file), readFileSync(join(root, file))] as const,
  )
  const write = sourceFiles.writeAtomic
  let count = 0
  vi.spyOn(sourceFiles, 'writeAtomic').mockImplementation((...args) => {
    if (++count === 3) throw Error('模拟写入失败')
    write(...args)
  })
  expect(() =>
    saveRecord(root, { kind: 'slot', id: slotId, base: slot.values, values: { characterId: companion } }),
  ).toThrow('模拟写入失败')
  for (const [file, original] of before) expect(readFileSync(file)).toEqual(original)
})

it('keeps the old player when a TRPG character sheet or host still needs the proposed player as an NPC', () => {
  const pack = join(root, 'manor')
  cpSync('examples/world-packs/rainy-manor', pack, { recursive: true })
  const slot = worldRecords(pack).records.find(r => r.kind === 'slot')!
  const select = () =>
    saveRecord(pack, { kind: 'slot', id: slot.id, base: slot.values, values: { characterId: 'character:aru' } })
  expect(select).toThrow('AI 角色卡和主持人')
  const path = join(pack, 'trpg.json'),
    config = JSON.parse(readFileSync(path, 'utf8'))
  delete config.characters['character:aru']
  writeFileSync(path, JSON.stringify(config))
  expect(select).toThrow('主持人')
  expect(worldRecords(pack).records.find(r => r.id === slot.id)?.values).toEqual(slot.values)
})

it('reports both ends of a mismatch only for participants in active scenes with a location', async () => {
  expect(worldRecords(root).openingLocationIssues).toEqual([])
  function update(id: string, values: Record<string, string | string[]>) {
    const r = record(id)
    return saveRecord(root, { kind: r.kind, id, base: r.values, values })
  }
  expect(() => update(companion, { initialLocationId: ['location:start', 'location:library'] })).toThrow('初始地点')
  update(companion, { initialLocationId: 'location:library' })
  const issue = {
    characterId: companion,
    characterName: '阿林',
    initialLocation: '书房',
    sceneId: 'scene:start',
    sceneLocation: '门廊',
  }
  expect(await editorCommand(root, { operation: 'records' })).toMatchObject({ openingLocationIssues: [issue] })
  update(companion, { initialLocationId: '' })
  expect(worldRecords(root).openingLocationIssues).toMatchObject([{ ...issue, initialLocation: '未指定' }])
  update('scene:start', { participantIds: [player] })
  update('scene:library', { participantIds: [companion] })
  expect(worldRecords(root).openingLocationIssues).toEqual([])
  update('scene:library', { lifecycle: 'active', locationId: '' })
  expect(worldRecords(root).openingLocationIssues).toEqual([])
  update('scene:library', { locationId: 'location:library' })
  update(companion, { initialLocationId: 'location:library' })
  expect(worldRecords(root).openingLocationIssues).toEqual([])
})
