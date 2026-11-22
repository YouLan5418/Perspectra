import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { runEditorCli } from '../../apps/host/src/editor/cli.ts'
import { rpgBook } from '../../apps/host/src/editor/rpg.ts'
import type { playRpgCue } from '../../apps/host/src/editor/rpg-cue-play.ts'
import { createWorld } from '../../apps/host/src/editor/workspace.ts'

let tmp: string, pack: string
const ruin = 'location:ruin-1',
  actor = 'character:cheng'
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'creator-cues-'))
  pack = join(tmp, 'pack')
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))
function cli(op: string, body: unknown, source = pack) {
  const file = join(tmp, 'request.json')
  writeFileSync(file, JSON.stringify(body))
  return runEditorCli([op, source, file])
}
const play = async (body: unknown, source = pack) =>
  (await cli('rpg-cue-play', body, source)) as Awaited<ReturnType<typeof playRpgCue>>
it('moves only the second fireball, exposes the new flow and proves its cast and speech in round two after export', async () => {
  cpSync('examples/world-packs/hill-ruins', pack, { recursive: true })
  const book = rpgBook(pack),
    config = structuredClone(book.config!),
    map = config.maps![0]!
  const before = await play({ location: ruin, index: 1 })
  expect(before.history.map(r => [r.index, r.phase, r.round])).toEqual([
    [0, 'encounter', 1],
    [1, 'fighting', 1],
  ])
  await expect(
    cli('rpg-cue-candidates', { location: ruin, characterId: actor, when: 'turn', skill: 'fire' }),
  ).resolves.toMatchObject({
    actors: [{ id: actor, name: '澄' }],
    enemies: [{ id: 'golem', name: '遗迹守卫' }],
    skills: expect.arrayContaining([expect.objectContaining({ id: 'fire' })]),
  })
  await expect(
    cli('rpg-cue-candidates', { location: ruin, characterId: actor, when: 'turn', skill: 'heal' }),
  ).resolves.toMatchObject({ enemies: [] })
  const old = structuredClone(map.scripted![1]!)
  map.scripted![1]!.round = 2
  await cli('rpg-save', { file: book.file, base: book.config, config })
  const exported = join(tmp, 'export')
  await runEditorCli(['export', pack, exported])
  const source = readFileSync(join(exported, book.file))
  expect(rpgBook(exported).config).toEqual(config)
  expect(rpgBook(exported).activities[0]!.cues).toMatchObject([
    { when: 'encounter', actor: '澄' },
    { when: 'turn', round: 2, skill: '火球术', target: '遗迹守卫' },
  ])
  const previousExit = process.exitCode
  try {
    await expect(cli('rpg-cue-play', { location: ruin, index: 1, expected: old }, exported)).resolves.toMatchObject({
      error: expect.stringContaining('字段已更改'),
      current: { round: 2 },
    })
    expect(process.exitCode).toBe(1)
  } finally {
    process.exitCode = previousExit
  }
  const result = await play({ location: ruin, index: 1, expected: map.scripted![1] }, exported)
  expect(result.played).toBe(true)
  expect(result.history).toMatchObject([
    {
      index: 0,
      phase: 'encounter',
      actor,
      description: expect.stringContaining('火球术'),
      speech: '小心，它的护甲很硬！',
    },
    {
      index: 1,
      phase: 'fighting',
      round: 2,
      actor,
      description: expect.stringContaining('遗迹守卫生命 36 → 22'),
      speech: '再来一发！',
    },
  ])
  expect(readFileSync(join(exported, book.file))).toEqual(source)
}, 60000)
it('checks a spoken entry and victory, and never credits an unavailable second skill', async () => {
  cpSync('examples/world-packs/hill-ruins', pack, { recursive: true })
  const book = rpgBook(pack),
    config = structuredClone(book.config!),
    map = config.maps![0]!
  config.characters[actor]!.stats.mp = 3
  map.scripted!.push({ when: 'enemy-defeated', characterId: actor, say: '石门开了。' })
  await cli('rpg-save', { file: book.file, base: book.config, config })
  const miss = await play({ location: ruin, index: 1 })
  expect(miss.played).toBe(false)
  expect(miss.reason).toContain('魔力不足')
  expect(miss.history.map(r => r.index)).toEqual([0])
  await expect(play({ location: ruin, index: 2 })).resolves.toMatchObject({
    played: true,
    history: expect.arrayContaining([expect.objectContaining({ index: 2, phase: 'aftermath', speech: '石门开了。' })]),
  })
  await expect(play({ location: 'location:ruin-2', index: 0 })).resolves.toMatchObject({
    played: true,
    history: [{ phase: 'enter', speech: '这里好像很久没人来过了。' }],
  })
}, 60000)
it('resolves an authored skill and target by their chosen IDs even when display names collide', async () => {
  cpSync('examples/world-packs/hill-ruins', pack, { recursive: true })
  const book = rpgBook(pack),
    config = structuredClone(book.config!),
    map = config.maps![0]!
  config.skills!.find(s => s.id === 'strike')!.name = '两种招式同名'
  config.skills!.find(s => s.id === 'fire')!.name = '两种招式同名'
  config.enemies!.twin = structuredClone(config.enemies!.golem!)
  map.enemies!.push('twin')
  map.scripted![0]!.target = 'twin'
  await cli('rpg-save', { file: book.file, base: book.config, config })
  await expect(play({ location: ruin, index: 0 })).resolves.toMatchObject({
    played: true,
    history: [{ skill: 'fire', target: { id: 'twin', before: 50, after: 36 }, speech: '小心，它的护甲很硬！' }],
  })
}, 30000)
it('authors a first non-player performance on a fresh pack and filters peaceful-map candidates', async () => {
  await createWorld(pack, { title: '新旅舍', player: '来客', companion: '店主', location: '大厅' })
  const location = 'location:start'
  await cli('rpg-enable', { location })
  const book = rpgBook(pack),
    config = structuredClone(book.config!)
  const npc = book.characters.find(c => c.id !== book.player)!.id,
    map = config.maps![0]!
  config.characters[npc] = structuredClone(config.characters[book.player]!)
  delete map.enemies
  map.scripted = [{ when: 'enter', characterId: npc, say: '欢迎。' }]
  await cli('rpg-save', { file: book.file, base: book.config, config })
  await expect(cli('rpg-cue-candidates', { location, when: 'enter', characterId: npc })).resolves.toMatchObject({
    triggers: ['enter'],
    skills: [],
    enemies: [],
  })
  await expect(play({ location, index: 0 })).resolves.toMatchObject({
    played: true,
    history: [{ actor: npc, speech: '欢迎。' }],
  })
}, 30000)
