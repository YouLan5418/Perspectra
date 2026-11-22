import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { runEditorCli } from '../../apps/host/src/editor/cli.ts'
import { saveActivityPage, importActivityPageFile } from '../../apps/host/src/editor/activity-pages.ts'
import { playRpg } from '../../apps/host/src/editor/rpg-play.ts'
import { rpgBook, saveRpg } from '../../apps/host/src/editor/rpg.ts'
import { createWorld } from '../../apps/host/src/editor/workspace.ts'
import { EditConflict, manifestFile } from '../../apps/host/src/editor/project.ts'
import { loadPackWeb } from '../../apps/host/src/runtime/pack-frontend.ts'

let temp: string, pack: string
beforeEach(() => {
  temp = mkdtempSync(join(tmpdir(), 'creator-rpg-test-'))
  pack = join(temp, 'pack')
})
afterEach(() => rmSync(temp, { recursive: true, force: true }))
const cast = (target: string) => ({ operation: 'skill', arguments: { skill: '火球术', target } })
const mana = (snapshot: Awaited<ReturnType<typeof playRpg>>['initial']) =>
  snapshot.status?.find(s => s.key === 'rpg-mp')?.value
function request(name: string, body: unknown) {
  const file = join(temp, name + '.json')
  writeFileSync(file, JSON.stringify(body))
  return file
}
it('enables an encounter in a new workbench pack, plays it to victory and preserves an existing undeclared file', async () => {
  await createWorld(pack, { title: '城门', player: '玩家', companion: '阿林', location: '城门' })
  const original = readFileSync(join(pack, manifestFile)),
    file = join(pack, 'rpg.json')
  writeFileSync(file, 'null')
  await expect(saveRpg(pack, { operation: 'rpg-enable', location: 'location:start' })).rejects.toThrow('配置对象')
  expect(readFileSync(file, 'utf8')).toBe('null')
  expect(readFileSync(join(pack, manifestFile))).toEqual(original)
  rmSync(file)
  await runEditorCli(['rpg-enable', pack, request('enable', { location: 'location:start' })])
  const book = rpgBook(pack)
  expect(book.plugins.map(p => p.id).sort()).toEqual(['official-dice', 'official-rpg'])
  const result = (await runEditorCli([
    'rpg-play',
    pack,
    request('trial', { location: 'location:start', turns: [cast('守卫'), cast('守卫')] }),
  ])) as Awaited<ReturnType<typeof playRpg>>
  expect(result.steps.map(s => s.after.phase)).toEqual(['fighting', 'victory'])
  expect([mana(result.initial), ...result.steps.map(s => mana(s.after))]).toEqual([8, 6, 4])
}, 60000)

it('edits only the chosen skill in a custom RPG path, checks conflicts and reopens the exported encounter and stage', async () => {
  cpSync('examples/world-packs/hill-ruins', pack, { recursive: true })
  const m = JSON.parse(readFileSync(join(pack, manifestFile), 'utf8')),
    file = 'content/ruins.json'
  mkdirSync(join(pack, 'content'))
  renameSync(join(pack, 'rpg.json'), join(pack, file))
  m.assetFiles[m.assetFiles.indexOf('rpg.json')] = file
  m.plugins['official-rpg'].config = file
  writeFileSync(join(pack, manifestFile), JSON.stringify(m, null, 2))
  const key = 'rpg-map-ruin-1',
    location = 'location:ruin-1',
    page = { html: 'activities/ruins.html', css: 'activities/ruins.css' }
  importActivityPageFile(pack, {
    path: page.html,
    text: '<h1 data-activity-title></h1><div data-activity-actions></div>',
  })
  importActivityPageFile(pack, { path: page.css, text: 'h1 { color: navy; }' })
  await saveActivityPage(pack, { key, page, base: null })
  const body = { location, scenes: { 'character:cheng': 'scene:ruin-1' }, turns: [cast('遗迹守卫')] }
  await expect(playRpg(pack, { location, scenes: { 'character:player': 'scene:living-room' } })).rejects.toThrow(
    '未进入所选地图',
  )
  const original = await playRpg(pack, body)
  expect([mana(original.initial), mana(original.steps[0]!.after)]).toEqual([8, 5])
  const book = (await runEditorCli(['gameplay', pack])) as ReturnType<typeof rpgBook>
  expect(book.file).toBe(file)
  expect(book.activities.find(a => a.key === key)?.page).toEqual(page)
  const config = structuredClone(book.config!)
  config.skills!.find(s => s.id === 'fire')!.cost.mp = 4
  const edit = { file, base: book.config, config }
  await runEditorCli(['rpg-save', pack, request('save', edit)])
  await expect(saveRpg(pack, { ...edit, operation: 'rpg-save', config: book.config })).rejects.toBeInstanceOf(
    EditConflict,
  )
  const broken = structuredClone(config)
  broken.maps![0]!.enemies = ['unknown-enemy']
  await expect(saveRpg(pack, { file, base: config, config: broken })).rejects.toThrow()
  expect(rpgBook(pack).config).toEqual(config)
  const exported = join(temp, 'export')
  await runEditorCli(['export', pack, exported])
  expect(rpgBook(exported).config).toEqual(config)
  expect(rpgBook(exported).activities.find(a => a.key === key)?.page).toEqual(page)
  expect(existsSync(join(exported, 'rpg.json'))).toBe(false)
  for (const path of [
    manifestFile,
    'scripts/status.js',
    'frontend/' + page.html,
    'frontend/' + page.css,
    'frontend/activity-pages.json',
  ])
    expect(readFileSync(join(exported, path))).toEqual(readFileSync(join(pack, path)))
  expect((await loadPackWeb(exported))?.activityPages?.[key]?.css).toBe(page.css)
  const trial = await playRpg(exported, body)
  expect([mana(trial.initial), mana(trial.steps[0]!.after)]).toEqual([8, 4])
  expect(trial.steps[0]!.results.join(' ')).toMatch(/玩家使用火球术，遗迹守卫生命 36 → 20/)
}, 60000)
