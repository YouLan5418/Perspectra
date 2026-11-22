import { cpSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { trpgBook, saveTrpg, modeCandidates } from '../../apps/host/src/editor/trpg.ts'
import { exportProject } from '../../apps/host/src/editor/export.ts'
import { createWorld } from '../../apps/host/src/editor/workspace.ts'
import { EditConflict } from '../../apps/host/src/editor/project.ts'
import { rpgBook, saveRpg } from '../../apps/host/src/editor/rpg.ts'
import { LensSimulation } from '../../apps/host/src/simulation/simulation.ts'
let temp: string, root: string
beforeEach(() => {
  temp = mkdtempSync(join(tmpdir(), 'creator-modes-'))
  root = join(temp, 'pack')
})
afterEach(() => rmSync(temp, { recursive: true, force: true }))
it('enables the official TRPG and its dice dependency on a new pack, exports, and opens it in the real Host', async () => {
  await createWorld(root, { title: '夜班', player: '访客', companion: '同伴', location: '前厅' })
  const b = await saveTrpg(root, { operation: 'trpg-enable' })
  expect(b.enabled).toBe(true)
  const list = modeCandidates(root, { mode: 'trpg', path: ['hosts', '0'] }).options!
  expect(list.map(r => r.id)).toEqual(['character:companion'])
  const scenario = {
    id: 'night',
    title: '夜班',
    opening: '灯亮了',
    truth: '只有主持知道',
    endings: ['找到钥匙'],
    content: [
      { kind: 'place', name: '前厅', description: '亮着灯', public: true },
      { kind: 'place', name: '暗室', description: '上锁', public: false },
      { kind: 'item', name: '钥匙', description: '铜制', location: '前厅', public: true },
    ],
  }
  const config = { ...b.config, hosts: [list[0]!.id], scenarios: [scenario] }
  expect(
    modeCandidates(root, { mode: 'trpg', config, path: ['scenarios', '0', 'content', '2', 'location'] }).options?.map(
      r => r.id,
    ),
  ).toEqual(['前厅'])
  const saved = await saveTrpg(root, { operation: 'trpg-save', file: b.file, base: b.config, config })
  await expect(saveTrpg(root, { operation: 'trpg-save', file: b.file, base: b.config, config })).rejects.toBeInstanceOf(
    EditConflict,
  )
  const invalid = structuredClone(config)
  invalid.scenarios[0]!.content[2]!.location = '暗室'
  await expect(
    saveTrpg(root, { operation: 'trpg-save', file: b.file, base: saved.config, config: invalid }),
  ).rejects.toThrow()
  expect(trpgBook(root).config).toEqual(config)
  const { directory } = await exportProject(root, join(temp, 'out'))
  const manifest = JSON.parse(readFileSync(join(directory, 'worldpack.source.json'), 'utf8'))
  expect(Object.keys(manifest.plugins)).toEqual(expect.arrayContaining(['official-trpg', 'official-dice']))
  const sim = await LensSimulation.open(directory)
  try {
    expect((await sim.state()).activities?.some(a => a.activityKey === 'trpg')).toBe(true)
  } finally {
    await sim.close()
  }
})
it('edits the file selected by an existing TRPG pack and preserves its private scenario and other fields', async () => {
  cpSync('examples/world-packs/rainy-manor', root, { recursive: true })
  const mfile = join(root, 'worldpack.source.json'),
    m = JSON.parse(readFileSync(mfile, 'utf8'))
  renameSync(join(root, 'trpg.json'), join(root, 'campaign.json'))
  m.plugins['official-trpg'].config = 'campaign.json'
  m.assetFiles = m.assetFiles.map((f: string) => (f === 'trpg.json' ? 'campaign.json' : f))
  writeFileSync(mfile, JSON.stringify(m))
  const b = trpgBook(root),
    config = { ...b.config, themes: ['末班车'] }
  const saved = await saveTrpg(root, { operation: 'trpg-save', file: b.file, base: b.config, config })
  expect(saved.file).toBe('campaign.json')
  expect(saved.config).toEqual(config)
})
it('enumerates draft combat states and unit resources for skill effects and validates their saved references', async () => {
  cpSync('examples/world-packs/hill-ruins', root, { recursive: true })
  const b = rpgBook(root),
    config = structuredClone(b.config!)
  config.combatStatuses = {
    burn: { name: '灼烧', turns: 2, timing: 'round-end', polarity: 'negative', tick: { kind: 'damage', amount: 2 } },
  }
  config.battleValues = {
    shared: {},
    attributes: {},
    resources: { guard: { label: '防护', initial: 4, min: 0, max: 5 } },
  }
  config.skills![0]!.effects = [
    { kind: 'status', status: 'burn' },
    { kind: 'value', scope: 'target', key: 'guard', delta: -1 },
    { kind: 'shield', amount: 2, turns: 2 },
    { kind: 'cleanse', polarity: 'negative' },
  ]
  for (const [path, id] of [
    [['skills', '0', 'effects', '0', 'status'], 'burn'],
    [['skills', '0', 'effects', '1', 'key'], 'guard'],
  ] as const)
    expect(modeCandidates(root, { mode: 'rpg', config, path }).options?.map(r => r.id)).toEqual([id])
  expect(
    (await saveRpg(root, { operation: 'rpg-save', file: b.file, base: b.config, config })).config?.skills?.[0]?.effects,
  ).toEqual(config.skills![0]!.effects)
})
