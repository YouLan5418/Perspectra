import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { runEditorCli } from '../../apps/host/src/editor/cli.ts'
import type { rpgBook } from '../../apps/host/src/editor/rpg.ts'
import { createWorld } from '../../apps/host/src/editor/workspace.ts'
import type { playRpgItem } from '../../apps/host/src/editor/rpg-item-play.ts'
let tmp: string, pack: string
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'creator-rpg-items-'))
  pack = join(tmp, 'pack')
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))
function cli(cmd: string, body: unknown, source = pack) {
  const req = join(tmp, 'request.json')
  writeFileSync(req, JSON.stringify(body))
  return runEditorCli([cmd, source, req])
}
async function play(body: unknown, source = pack) {
  return (await cli('rpg-item-play', body, source)) as Awaited<ReturnType<typeof playRpgItem>>
}
it('configures the existing chest potion, checks restoration and the cap, and compares the same single strike on an exported pack', async () => {
  cpSync('examples/world-packs/hill-ruins', pack, { recursive: true })
  const book = (await runEditorCli(['gameplay', pack])) as ReturnType<typeof rpgBook>,
    config = structuredClone(book.config!)
  expect(book.slots).toEqual(['weapon'])
  const id = 'entity:potion-2'
  config.consumables![id] = { restore: { hp: 20, mp: 3 } }
  await cli('rpg-save', { file: book.file, base: book.config, config })
  const exported = join(tmp, 'export')
  await runEditorCli(['export', pack, exported])
  const source = readFileSync(join(exported, book.file))
  const potion = await play({ kind: 'consumable', id, initial: { hp: 15, mp: 7 } }, exported)
  expect(potion).toMatchObject({
    kind: 'consumable',
    spent: expect.stringContaining('已用完'),
    reason: expect.any(String),
    values: [
      { key: 'hp', before: 15, after: 35, max: 40 },
      { key: 'mp', before: 7, after: 8, max: 8 },
    ],
  })
  await expect(play({ kind: 'consumable', id, initial: { hp: 42 } }, exported)).rejects.toThrow('起始数值超出范围')
  const gear = await play(
    { kind: 'equipment', id: 'entity:iron-sword', location: 'location:ruin-1', skill: 'strike' },
    exported,
  )
  expect(gear).toMatchObject({
    kind: 'equipment',
    without: { target: 'golem', before: 36, after: 28, damage: 8 },
    withGear: { target: 'golem', before: 36, after: 25, damage: 11 },
    difference: 3,
  })
  expect(readFileSync(join(exported, book.file))).toEqual(source)
}, 60000)
it('supports a new slot and item on the same on-enter encounter as the player, and reports a missing compatible slot', async () => {
  await createWorld(pack, { title: '练武场', player: '玩家', companion: '阿林', location: '庭院' })
  const location = 'location:start',
    id = 'entity:sword'
  await cli('record-save', {
    kind: 'item',
    id,
    base: null,
    values: { name: '短剑', kind: '武器', locationId: location },
  })
  const base = { take: false, drop: false, give: false }
  await cli('item-actions-save', { id, base, allowed: { ...base, take: true } })
  const book = (await cli('rpg-enable', { location })) as ReturnType<typeof rpgBook>,
    config = structuredClone(book.config!)
  config.equipment = { [id]: { slot: '右手', attack: 4 } }
  await cli('rpg-save', { file: book.file, base: book.config, config })
  const request = { id, kind: 'equipment', location, skill: 'strike' }
  await expect(play(request)).rejects.toThrow('槽位')
  const next = structuredClone(config)
  next.characters[book.player]!.slots = ['右手']
  const edited = (await cli('rpg-save', { file: book.file, base: config, config: next })) as ReturnType<typeof rpgBook>
  expect(edited.slots).toEqual(['右手'])
  expect(await play(request)).toMatchObject({ kind: 'equipment', difference: 4 })
}, 60000)
