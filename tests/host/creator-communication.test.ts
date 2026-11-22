import { cpSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, afterEach, it, expect } from 'vitest'
import { communicationBook, saveCommunication } from '../../apps/host/src/editor/communication.ts'
import { modeCandidates } from '../../apps/host/src/editor/trpg.ts'
import { EditConflict } from '../../apps/host/src/editor/project.ts'
import { exportProject } from '../../apps/host/src/editor/export.ts'
import { createWorld } from '../../apps/host/src/editor/workspace.ts'
import { LensSimulation } from '../../apps/host/src/simulation/simulation.ts'
let temp: string, root: string
const player = 'character:player',
  mate = 'character:companion',
  third = 'character:friend'
beforeEach(() => {
  temp = mkdtempSync(join(tmpdir(), 'creator-contacts-'))
  root = join(temp, 'source')
})
afterEach(() => rmSync(temp, { recursive: true, force: true }))
it('starts a new directory with no implied contacts and rejects stale, duplicate and unknown contacts without saving', async () => {
  await createWorld(root, { title: '电台', player: '访客', companion: '阿林', location: '门廊' })
  expect(communicationBook(root).enabled).toBe(false)
  const b = await saveCommunication(root, { operation: 'communication-enable' })
  expect(b.config).toEqual({ medium: '短信', contacts: {} })
  const save = (config: unknown) => saveCommunication(root, { file: b.file, base: b.config, config })
  for (const values of [[player], [mate, mate], ['character:missing']])
    await expect(save({ medium: '短信', contacts: { [player]: values } })).rejects.toThrow()
  expect(
    modeCandidates(root, {
      mode: 'communication',
      path: ['contacts', player, '1'],
      config: { contacts: { [player]: [mate] } },
    }).options,
  ).toEqual([])
  expect((await save({ medium: '电台', contacts: { [mate]: [player] } })).config).toEqual({
    medium: '电台',
    contacts: { [mate]: [player] },
  })
  await expect(save(b.config)).rejects.toBeInstanceOf(EditConflict)
})
it('edits a declared custom file and delivers a cross-scene message only to its participants in an exported world', async () => {
  cpSync('examples/world-packs/cross-scene-sms', root, { recursive: true })
  const mf = join(root, 'worldpack.source.json'),
    m = JSON.parse(readFileSync(mf, 'utf8'))
  m.plugins['official-communication'].config = 'radio.json'
  m.assetFiles = m.assetFiles.map((f: string) => (f === 'communication.json' ? 'radio.json' : f))
  renameSync(join(root, 'communication.json'), join(root, 'radio.json'))
  writeFileSync(mf, JSON.stringify(m))
  const b = communicationBook(root)
  expect(b.file).toBe('radio.json')
  await saveCommunication(root, {
    file: b.file,
    base: b.config,
    config: { medium: '电台', contacts: { [player]: [mate] } },
  })
  const out = await exportProject(root, join(temp, 'out')),
    sim = await LensSimulation.open(out.directory)
  try {
    const send = (recipientId: string) =>
      sim.previewRuntime.submit('/message ' + JSON.stringify({ recipientId, text: '柜号八七九' }))
    await expect(send(third)).rejects.toThrow()
    await send(mate)
    const seen = sim.perceived()
    expect(seen[mate]?.join(' ')).toContain('柜号八七九')
    expect(seen[third]?.join(' ')).not.toContain('柜号八七九')
    expect(sim.events().some(e => e.eventType === 'character.speak' && JSON.stringify(e.data).includes('电台'))).toBe(
      true,
    )
  } finally {
    await sim.close()
  }
})
