import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { runEditorCli } from '../../apps/host/src/editor/cli.ts'
import { rpgBook } from '../../apps/host/src/editor/rpg.ts'
import { createWorld } from '../../apps/host/src/editor/workspace.ts'

let tmp: string, pack: string
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'creator-rpg-journey-'))
  pack = join(tmp, 'pack')
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))
function command(op: string, body: unknown, source = pack) {
  const file = join(tmp, 'request.json')
  writeFileSync(file, JSON.stringify(body))
  return runEditorCli([op, source, file])
}
const home = 'location:living-room',
  bedroom = 'location:bedroom',
  ruin = 'location:ruin-1'
const player = 'character:player',
  cheng = 'character:cheng'
it('edits an imported pack, then checks the actual defeat restore and retreat separately after export', async () => {
  cpSync('examples/world-packs/hill-ruins', pack, { recursive: true })
  const book = rpgBook(pack),
    config = structuredClone(book.config!)
  config.defeat = { to: home, restore: { hp: 100, mp: 0 } }
  config.retreat = 'back'
  await command('rpg-save', { file: book.file, base: book.config, config })
  const exported = join(tmp, 'export')
  await runEditorCli(['export', pack, exported])
  const original = readFileSync(join(exported, book.file))
  const play = (body: unknown) => command('rpg-journey-play', body, exported)
  await expect(play({ kind: 'rest', location: bedroom })).resolves.toMatchObject({
    available: true,
    values: [
      { key: 'hp', before: 20, after: 40, max: 40 },
      { key: 'mp', before: 4, after: 8, max: 8 },
    ],
  })
  await expect(play({ kind: 'rest', location: home })).resolves.toMatchObject({ available: false })
  const before = config.characters
  await expect(play({ kind: 'defeat', location: ruin })).resolves.toMatchObject({
    phase: 'defeat',
    destination: home,
    participants: expect.arrayContaining(
      [player, cheng].map(id => ({
        id,
        location: home,
        values: [
          expect.objectContaining({ key: 'hp', after: before[id]!.stats.hp }),
          expect.objectContaining({ key: 'mp', after: 0 }),
        ],
      })),
    ),
  })
  await expect(play({ kind: 'retreat', location: ruin })).resolves.toMatchObject({
    phase: 'fled',
    destination: home,
    participants: expect.arrayContaining([
      expect.objectContaining({
        id: player,
        location: home,
        values: [
          expect.objectContaining({ key: 'hp', before: 40, after: 40 }),
          expect.objectContaining({ key: 'mp', before: 8, after: 8 }),
        ],
      }),
    ]),
  })
  expect(readFileSync(join(exported, book.file))).toEqual(original)
}, 60000)
it('waits for a faster companion to act before the player retreats', async () => {
  cpSync('examples/world-packs/hill-ruins', pack, { recursive: true })
  const book = rpgBook(pack),
    config = structuredClone(book.config!)
  config.characters[cheng]!.speed = 99
  config.maps![0]!.scripted = []
  await command('rpg-save', { file: book.file, base: book.config, config })
  await expect(command('rpg-journey-play', { kind: 'retreat', location: ruin })).resolves.toMatchObject({
    phase: 'fled',
    destination: ruin,
  })
}, 30000)
it('allows a configured companion to lead the player and checks the second move after leaving', async () => {
  cpSync('examples/world-packs/hill-ruins', pack, { recursive: true })
  const book = rpgBook(pack),
    config = structuredClone(book.config!)
  config.party = { leader: cheng, lockDuringBattle: false }
  await command('rpg-save', { file: book.file, base: book.config, config })
  const play = (member: string) => command('rpg-journey-play', { kind: 'party', member, from: home, to: bedroom })
  await expect(play(player)).resolves.toMatchObject({
    leader: cheng,
    member: player,
    joined: [player],
    followed: bedroom,
    left: [],
    stayed: bedroom,
  })
  await expect(play('character:aru')).rejects.toThrow('已配置 RPG 数值')
}, 30000)
it('accepts just a return destination on a new pack and validates the dependency before saving', async () => {
  await createWorld(pack, { title: '旅舍', player: '旅人', companion: '同伴', location: '大厅' })
  const start = 'location:start'
  await command('rpg-enable', { location: start })
  const book = rpgBook(pack),
    config = structuredClone(book.config!)
  config.defeat = { to: start }
  config.party = { leader: book.player }
  config.rest = { label: '小憩', locations: [start], restore: 'full' }
  await command('rpg-save', { file: book.file, base: book.config, config })
  expect(rpgBook(pack).config).toEqual(config)
  await expect(command('rpg-journey-play', { kind: 'rest', location: start })).resolves.toMatchObject({
    available: true,
  })
  const broken = structuredClone(config)
  delete broken.defeat
  broken.retreat = 'back'
  await expect(command('rpg-save', { file: book.file, base: config, config: broken })).rejects.toThrow(/defeat/)
  expect(rpgBook(pack).config).toEqual(config)
}, 30000)
