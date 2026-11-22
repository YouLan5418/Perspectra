import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, afterEach, expect, it } from 'vitest'
import { runEditorCli } from '../../apps/host/src/editor/cli.ts'
import { itemUses } from '../../apps/host/src/editor/item-uses.ts'
import { saveItemActions } from '../../apps/host/src/editor/item-actions.ts'
import { EditConflict, manifest } from '../../apps/host/src/editor/project.ts'
import { rpgBook } from '../../apps/host/src/editor/rpg.ts'
import type { playExit } from '../../apps/host/src/editor/rpg-exit-play.ts'
import { createWorld } from '../../apps/host/src/editor/workspace.ts'
import { saveRule } from '../../apps/host/src/editor/rules.ts'
let tmp: string, pack: string
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'creator-item-route-'))
  pack = join(tmp, 'pack')
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))
const id = 'entity:silver-key',
  none = { take: false, drop: false, give: false },
  take = { ...none, take: true }
it('links authored activity conditions, individual page elements and event holder audiences', () => {
  cpSync('examples/world-packs/porch-note', pack, { recursive: true })
  const opener = 'entity:opener'
  saveRule(pack, { kind: 'variable', base: null, row: { key: 'seen', label: '已读', type: 'boolean', initial: false } })
  saveRule(pack, {
    kind: 'event',
    base: null,
    row: {
      id: 'opened',
      type: 'note.opened@1',
      observation: '便笺展开了。',
      location: 'location:start',
      round: 1,
      set: { key: 'seen', value: true },
      audience: { anyOf: ['scene', { holds: opener }] },
    },
  })
  const refs = itemUses(pack, opener).uses
  expect(refs).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ section: 'rules', id: 'opened', field: 'audience' }),
      expect.objectContaining({ section: 'activity', id: 'read-note', choice: 'open-note', field: 'condition' }),
      expect.objectContaining({ section: 'pages', id: 'read-note', field: 'letter' }),
      expect.objectContaining({ section: 'pages', id: 'read-note', field: 'open-note' }),
    ]),
  )
})
function cli(command: string, body: unknown, source = pack) {
  const file = join(tmp, 'request.json')
  writeFileSync(file, JSON.stringify(body))
  return runEditorCli([command, source, file])
}
function createKey(location: string) {
  return cli('record-save', {
    kind: 'item',
    id,
    base: null,
    values: { name: '银钥匙', kind: '钥匙', locationId: location },
  })
}
it('replaces a vault drop and lock with a new item, reports a missing take operation and plays the exported route', async () => {
  cpSync('examples/world-packs/hill-ruins', pack, { recursive: true })
  await createKey('location:vault')
  const original = 'entity:iron-key',
    location = 'location:ruin-1',
    to = 'location:ruin-2'
  const keyUses = (item: string) =>
    itemUses(pack, item)
      .uses.filter(u => u.section === 'gameplay')
      .map(u => u.field)
  expect(keyUses(original)).toEqual(['drops/' + original, 'exit/' + to])
  const book = rpgBook(pack),
    config = structuredClone(book.config!),
    map = config.maps!.find(m => m.locationId === location)!
  map.drops![map.drops!.indexOf(original)] = id
  map.exits![0]!.requires = { holds: id }
  await cli('rpg-save', { file: book.file, base: book.config, config })
  expect(keyUses(original)).toEqual([])
  expect(keyUses(id)).toEqual(['drops/' + id, 'exit/' + to])
  const route = { location, to, scenes: { 'character:cheng': 'scene:ruin-1' } }
  const failed = (await cli('rpg-exit-play', route)) as Awaited<ReturnType<typeof playExit>>
  expect(failed.passed).toBe(false)
  expect(failed.checks.at(-1)).toMatchObject({ step: '拾取钥匙', passed: false })
  const iron = itemUses(pack, original).actions.allowed
  await cli('item-actions-save', { id, base: none, allowed: take })
  expect(() => saveItemActions(pack, { id, base: none, allowed: { ...none, give: true } })).toThrow(EditConflict)
  expect(itemUses(pack, original).actions.allowed).toEqual(iron)
  const dest = join(tmp, 'export')
  await runEditorCli(['export', pack, dest])
  const report = (await cli('item-uses', { id }, dest)) as ReturnType<typeof itemUses>
  expect(report.actions.allowed).toEqual(take)
  const trial = (await cli('rpg-exit-play', route, dest)) as Awaited<ReturnType<typeof playExit>>
  expect(trial).toMatchObject({ item: id, passed: true, to })
  expect(trial.checks.map(c => c.step)).toEqual([
    '空手尝试通行',
    '战斗胜利并掉落钥匙',
    '胜利后未拾取',
    '拾取钥匙',
    '持有但未开锁',
    '使用钥匙开锁',
    '开锁后通行',
  ])
  expect(trial.checks.every(c => c.passed)).toBe(true)
}, 60000)
it('installs the item template once in a fresh pack and keeps custom script source intact', async () => {
  await createWorld(pack, { title: '新世界', player: '玩家', location: '庭院', companion: '小禾' })
  await createKey('location:start')
  expect(itemUses(pack, id).actions.mode).toBe('new')
  await cli('item-actions-save', { id, base: none, allowed: take })
  await cli('item-actions-save', { id, base: take, allowed: none })
  expect(manifest(pack).assetFiles.filter(p => p === 'scripts/status.js')).toHaveLength(1)
  const file = join(pack, 'scripts/status.js'),
    custom = readFileSync(file, 'utf8').replace('物品规则模板', '作者的规则')
  writeFileSync(file, custom)
  expect(itemUses(pack, id).actions.mode).toBe('custom')
  expect(() => saveItemActions(pack, { id, base: none, allowed: take })).toThrow('包内状态脚本')
  expect(readFileSync(file, 'utf8')).toBe(custom)
})
