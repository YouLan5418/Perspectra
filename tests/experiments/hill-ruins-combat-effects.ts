import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { RpgConfig } from '../../packages/official-rpg/src/config.ts'

// Make a fresh playable variant without changing the example pack or its existing Lens scenarios.
const source = fileURLToPath(new URL('../../examples/world-packs/hill-ruins/', import.meta.url))
const pack = join(mkdtempSync(join(tmpdir(), 'hill-ruins-combat-effects-')), 'pack')
cpSync(source, pack, { recursive: true, filter: path => basename(path) !== '.perspectra-lens' })
const read = (name: string) => JSON.parse(readFileSync(join(pack, name), 'utf8'))
const write = (name: string, value: unknown) =>
  writeFileSync(join(pack, name), JSON.stringify(value, null, 2) + '\n')

const sourceManifest = read('worldpack.source.json')
sourceManifest.packId = 'pack:hill-ruins-combat-effects'
write('worldpack.source.json', sourceManifest)

const armorId = 'entity:fireproof-armor'
const entities = read('entities.json')
entities.entities.push({
  entityId: armorId,
  locationId: 'location:living-room',
  name: '抗火护甲',
  kind: '挂在客厅衣架上的护甲，内衬刻着抵御火焰的符文',
})
write('entities.json', entities)

const itemScript = join(pack, 'scripts', 'status.js')
const items = readFileSync(itemScript, 'utf8')
const itemOptions = 'const noItemInput ='
if (!items.includes(itemOptions)) throw new Error('山脚遗迹物品模板已变化，请检查实验包的护甲操作')
writeFileSync(
  itemScript,
  items.replace(
    itemOptions,
    `for (const targets of Object.values(ITEM_RULES)) targets.push(${JSON.stringify(armorId)})\n${itemOptions}`,
  ),
)

const rpg = read('rpg.json') as RpgConfig
rpg.combatStatuses = { burn: { name: '灼烧', turns: 3, damage: 3, element: 'fire' } }
const fire = rpg.skills.find(skill => skill.id === 'fire')!
Object.assign(fire, { power: 10, element: 'fire', inflicts: 'burn' })
rpg.skills.push({ ...fire, id: 'golem-fire', name: '守卫火球', scope: 'all', cost: {} })
rpg.enemies.golem!.skills = ['golem-fire']
rpg.enemies.golem!.attack = 4
rpg.maps.find(map => map.locationId === 'location:ruin-1')!.scripted = []
for (const character of Object.values(rpg.characters)) character.slots.push('armor')
rpg.equipment[armorId] = { slot: 'armor', attack: 0, defense: 2, speed: 0, resistances: { fire: 20 } }
write('rpg.json', rpg)

const world = read('world.json')
world.title = '山脚遗迹 · 灼烧与抗火实验'
write('world.json', world)
process.stdout.write(pack + '\n')
