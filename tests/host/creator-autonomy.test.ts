import { cpSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, afterEach, it, expect } from 'vitest'
import { autonomyBook, autonomyCandidates, saveAutonomy } from '../../apps/host/src/editor/autonomy.ts'
import { saveGraph, EditConflict } from '../../apps/host/src/editor/project.ts'
import { saveRecord, worldRecords } from '../../apps/host/src/editor/world-records.ts'
import { exportProject } from '../../apps/host/src/editor/export.ts'
import { createWorld } from '../../apps/host/src/editor/workspace.ts'
import { LensSimulation } from '../../apps/host/src/simulation/simulation.ts'
let temp: string, root: string
const npc = 'character:companion'
beforeEach(() => {
  temp = mkdtempSync(join(tmpdir(), 'creator-autonomy-'))
  root = join(temp, 'pack')
})
afterEach(() => rmSync(temp, { recursive: true, force: true }))
it('offers the RPG operation ID used in character affordances and trigger records', async () => {
  const book = await autonomyBook('examples/world-packs/hill-ruins')
  const ids = book.operations.map(op => op.id)
  expect(ids.filter(id => id === 'activity:guard')).toHaveLength(1)
  expect(ids).not.toContain('activity:rpg-map-ruin-1:guard')
})
it('prevents assigning an autonomous role to the player and can repair an imported conflict', async () => {
  await createWorld(root, { title: '值班', player: '访客', companion: '阿林', location: '门廊' })
  const enabled = await saveAutonomy(root, { operation: 'autonomy-enable' })
  await saveAutonomy(root, {
    file: enabled.file,
    base: enabled.config,
    config: {
      characters: [
        {
          characterId: npc,
          triggers: [{ actionType: 'speak' }],
          everyPlayerTurns: 1,
          opportunities: 1,
          interactions: [],
          locationIds: ['location:start'],
        },
      ],
    },
  })
  const rows = worldRecords(root).records,
    actor = rows.find(r => r.id === npc)!,
    slot = rows.find(r => r.kind === 'slot')!
  expect(() =>
    saveRecord(root, { kind: 'slot', id: slot.id, base: slot.values, values: { characterId: npc } }),
  ).toThrow('自主机会')
  const actorsFile = join(root, actor.file),
    actors = JSON.parse(readFileSync(actorsFile, 'utf8'))
  for (const role of actors.characters) role.controllerClass = role.characterId === npc ? 'manual' : 'scripted'
  writeFileSync(actorsFile, JSON.stringify(actors))
  const path = join(root, slot.file),
    slots = JSON.parse(readFileSync(path, 'utf8'))
  slots.playerSlots[0].characterId = npc
  writeFileSync(path, JSON.stringify(slots))
  await expect(exportProject(root, join(temp, 'out'))).rejects.toThrow(/NPC/)
  const book = await autonomyBook(root)
  await saveAutonomy(root, { file: book.file, base: book.config, config: { characters: [] } })
  await expect(exportProject(root, join(temp, 'out'))).resolves.toHaveProperty('directory')
})
it('authors an opportunity on a fresh pack using draft activity operations, then exercises the Host scheduler', async () => {
  await createWorld(root, { title: '晨班', player: '访客', companion: '阿林', location: '门廊' })
  const { records } = worldRecords(root),
    scene = records.find(r => r.kind === 'scene')!,
    actor = records.find(r => r.id === npc)!
  saveRecord(root, { kind: 'location', id: 'location:other', base: null, values: { name: '茶水间' } })
  saveRecord(root, {
    kind: 'scene',
    id: scene.id,
    base: scene.values,
    values: { participantIds: ['character:player'] },
  })
  saveRecord(root, { kind: 'character', id: npc, base: actor.values, values: { initialLocationId: 'location:other' } })
  saveRecord(root, {
    kind: 'scene',
    id: 'scene:other',
    base: null,
    values: { lifecycle: 'active', locationId: 'location:other', participantIds: [npc] },
  })
  saveGraph(root, null, {
    key: 'tea',
    title: '泡茶',
    opening: '水开了',
    choices: [
      { id: 'pour', label: '倒茶', condition: { kind: 'always' }, result: '茶已经倒好。', speech: '', next: 'end' },
    ],
  })
  const b = await saveAutonomy(root, { operation: 'autonomy-enable' })
  expect(b.config).toEqual({ characters: [] })
  const role = {
      characterId: npc,
      triggers: [{ activityKey: 'tea', operation: 'pour' }, { actionType: 'speak' }],
      everyPlayerTurns: 1,
      opportunities: 1,
      locationIds: ['location:other'],
      interactions: [],
    },
    config = { characters: [role] }
  const options = async (path: string[]) => (await autonomyCandidates(root, { path, config })).options?.map(v => v.id)
  expect(await options(['characters', '0', 'characterId'])).toEqual([npc])
  expect(await options(['characters', '0', 'triggers', '0', 'operation'])).toEqual(['pour'])
  expect(await options(['characters', '0', 'locationIds', '0'])).toContain('location:start')
  const req = { file: b.file, base: b.config }
  for (const patch of [
    { characterId: 'character:player' },
    { opportunities: 101 },
    { locationIds: ['missing'] },
    { triggers: [{ activityKey: 'tea', operation: 'missing' }] },
  ])
    await expect(saveAutonomy(root, { ...req, config: { characters: [{ ...role, ...patch }] } })).rejects.toThrow()
  expect((await saveAutonomy(root, { ...req, config })).config).toEqual(config)
  await expect(saveAutonomy(root, { ...req, config: b.config })).rejects.toBeInstanceOf(EditConflict)
  const out = await exportProject(root, join(temp, 'out')),
    sim = await LensSimulation.open(out.directory)
  try {
    const step = await sim.step({ kind: 'say', text: '茶要凉了。' })
    expect(step.error).toBeUndefined()
    expect(step.modelInputs?.some(r => r.characterId === npc)).toBe(true)
    expect(JSON.stringify(step.modelInputs?.filter(r => r.characterId === npc))).not.toContain('茶要凉了。')
    expect((await sim.state()).debug).toMatchObject({ autonomy: { autonomousCalls: 1 } })
  } finally {
    await sim.close()
  }
})
it('reads an existing custom file and offers actual status interactions, places and item targets', async () => {
  cpSync('examples/world-packs/autonomy-scheduling', root, { recursive: true })
  const mf = join(root, 'worldpack.source.json'),
    m = JSON.parse(readFileSync(mf, 'utf8'))
  renameSync(join(root, 'autonomy.json'), join(root, 'roles.json'))
  m.plugins['official-autonomy'].config = 'roles.json'
  m.assetFiles = m.assetFiles.map((f: string) => (f === 'autonomy.json' ? 'roles.json' : f))
  writeFileSync(mf, JSON.stringify(m))
  const book = await autonomyBook(root)
  expect(book.file).toBe('roles.json')
  expect(book.operations.map(v => v.id)).toEqual(expect.arrayContaining(['status:take', 'status:drop']))
  const options = await autonomyCandidates(root, { path: ['characters', '0', 'targetIds', '0'] })
  expect(options.options?.map(v => v.id)).toContain('entity:brass-key')
  const config = JSON.parse(JSON.stringify(book.config))
  config.characters[0].opportunities = 2
  expect((await saveAutonomy(root, { file: book.file, base: book.config, config })).config).toEqual(config)
})
