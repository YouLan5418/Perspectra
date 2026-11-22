import { cpSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { worldSetup, saveSetup, setupCandidates } from '../../apps/host/src/editor/world-setup.ts'
import { createWorld } from '../../apps/host/src/editor/workspace.ts'
import { exportProject } from '../../apps/host/src/editor/export.ts'
import { EditConflict } from '../../apps/host/src/editor/project.ts'
import { LensSimulation } from '../../apps/host/src/simulation/simulation.ts'
import { CognitionProjectionRebuilder, WorldStore } from '@perspectra/core/store'
import type { CharacterId } from '@perspectra/sdk/contracts'
import type { ConfigObject, SetupKind } from '@perspectra/world-pack/editor-config'
let temp: string, root: string
const character = 'character:companion',
  player = 'character:player'
beforeEach(() => {
  temp = mkdtempSync(join(tmpdir(), 'creator-setup-'))
  root = join(temp, 'pack')
})
afterEach(() => rmSync(temp, { force: true, recursive: true }))
function read(file: string) {
  return JSON.parse(readFileSync(join(root, file), 'utf8'))
}
function write(file: string, value: unknown) {
  writeFileSync(join(root, file), JSON.stringify(value))
}
function persist(kind: SetupKind, fields: ConfigObject) {
  const b = worldSetup(root, { kind, character })
  return saveSetup(root, { kind, character, file: b.file, base: b.config, config: { ...b.config, ...fields } })
}
it('authors a private fact and observation, selects their intended readers and verifies the exported character views', async () => {
  await createWorld(root, { title: '失物', player: '访客', companion: '阿林', location: '门廊' })
  expect(
    setupCandidates(root, { path: ['initialFacts', '0', 'initialAudience', '0'] }).options?.map(v => v.id),
  ).toContain(character)
  await persist('world', {
    initialFacts: [
      { factId: 'locker', proposition: { text: '柜号八七九', clues: [1, null, true] }, initialAudience: [character] },
    ],
  })
  await persist('portrayal', { drives: [{ key: 'protect', text: '守护失物' }] })
  await persist('memory', { profile: 'deep', attentionTopics: ['失物'] })
  const initial = worldSetup(root, { kind: 'cognition', character })
  const config = {
    ...initial.config,
    observations: [
      { key: 'note', content: '背面写有栀子', epistemicKind: 'direct_observation', basisKeys: ['protect'] },
    ],
    claims: [
      {
        key: 'belief',
        proposition: { text: '柜门曾被打开' },
        stance: 'suspected',
        confidencePermille: 600,
        basisKeys: ['note'],
      },
    ],
  }
  const candidates = (path: string[], actor = character) =>
    setupCandidates(root, { kind: 'cognition', character: actor, config, path }).options?.map(v => v.id)
  expect(candidates(['claims', '0', 'basisKeys', '0'])).toEqual(['note', 'protect'])
  expect(candidates(['observations', '0', 'basisKeys', '0'])).toEqual(['protect'])
  expect(candidates(['claims', '0', 'proposition', 'basisKeys', '0'])).toBeUndefined()
  expect(
    setupCandidates(root, { kind: 'cognition', character: player, path: ['claims', '0', 'basisKeys', '0'] }).options,
  ).toEqual([])
  await persist('cognition', config)
  await expect(
    saveSetup(root, { kind: 'cognition', character, file: initial.file, base: initial.config, config }),
  ).rejects.toBeInstanceOf(EditConflict)
  await expect(persist('cognition', { claims: [{ ...config.claims[0]!, basisKeys: ['foreign'] }] })).rejects.toThrow()
  await expect(
    persist('cognition', { observations: [{ ...config.observations[0]!, basisKeys: ['belief'] }] }),
  ).rejects.toThrow()
  expect(worldSetup(root, { kind: 'cognition', character }).config).toEqual(config)
  const out = await exportProject(root, join(temp, 'out')),
    sim = await LensSimulation.open(out.directory)
  try {
    const store = new WorldStore(join(sim.previewRuntime.dataDirectory, 'world.sqlite'))
    try {
      const address = sim.previewRuntime.address,
        builder = new CognitionProjectionRebuilder(store)
      const view = (id: string) => builder.rebuildCharacterAt(address, id as CharacterId, store.head(address).headSeq)
      const own = view(character),
        other = view(player)
      expect(JSON.stringify(own.claims)).toContain('柜号八七九')
      expect(sim.perceived()[character]?.join(' ')).toContain('背面写有栀子')
      expect(JSON.stringify(other.claims)).not.toContain('柜号八七九')
      expect(sim.perceived()[player]?.join(' ')).not.toContain('背面写有栀子')
    } finally {
      store.close()
    }
  } finally {
    await sim.close()
  }
})
it('edits the declared source for an actor across files and keeps siblings and unlisted files intact', async () => {
  cpSync('examples/world-packs/porch-note', root, { recursive: true })
  const m = read('worldpack.source.json'),
    c = read('cognition.json'),
    [other, selected] = c.characters
  write('cognition.json', { ...c, characters: [other] })
  write('secrets.json', { ...c, characters: [selected] })
  m.cognitionFiles.push('secrets.json')
  m.memoryFiles = []
  write('worldpack.source.json', m)
  write('creator-memory.json', { unlisted: true })
  const before = readFileSync(join(root, 'cognition.json'), 'utf8')
  expect(
    (await persist('cognition', { openLoops: [{ key: 'door', kind: 'question', summary: '谁打开了门？' }] })).file,
  ).toBe('secrets.json')
  expect(readFileSync(join(root, 'cognition.json'), 'utf8')).toBe(before)
  expect(read('secrets.json').characters[0].openLoops).toHaveLength(1)
  expect((await persist('memory', { profile: 'compact' })).file).toBe('creator-memory-2.json')
  expect(read('worldpack.source.json').memoryFiles).toEqual(['creator-memory-2.json'])
  expect(read('creator-memory.json')).toEqual({ unlisted: true })
  await expect(persist('memory', { profile: 'unbounded' })).rejects.toThrow()
  expect(read('creator-memory-2.json').characters).toEqual([{ characterId: character, profile: 'compact' }])
})
