import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { officialPackPlugins, mapActivityKey, type RpgConfig } from '../official-pack-metadata.ts'
import { manifest, packPath } from './project.ts'
import { worldRecords } from './world-records.ts'
import { cueCandidates, cueFlow, type RpgCue } from './rpg-cues.ts'
import { pageBindings } from './activity-pages.ts'
import { saveModeSource } from './mode-source.ts'

export type RpgSource = Pick<RpgConfig, 'plugin' | 'stats' | 'characters'> &
  Partial<Omit<RpgConfig, 'plugin' | 'stats' | 'characters' | 'equipment' | 'defeat' | 'party'>> & {
    defeat?: { to: string; restore?: Record<string, number> }
    party?: { leader: string; lockDuringBattle?: boolean }
    equipment?: Record<
      string,
      Pick<RpgConfig['equipment'][string], 'slot'> & Partial<Omit<RpgConfig['equipment'][string], 'slot'>>
    >
  }
const descriptor = officialPackPlugins.find(p => p.id === 'official-rpg')!
const json = (root: string, file: string) => JSON.parse(readFileSync(packPath(root, file), 'utf8'))

export function rpgBook(source: string) {
  const root = realpathSync(source),
    m = manifest(root),
    records = worldRecords(root).records
  const plugins = Object.entries(m.plugins ?? {}).map(([id, selection]) => {
    const installed = officialPackPlugins.find(p => p.id === id)
    const file = selection.config ?? installed?.configFile
    return {
      id,
      version: selection.version ?? installed?.version,
      file,
      config: id !== descriptor.id && file && m.assetFiles.includes(file) ? (json(root, file) as unknown) : null,
    }
  })
  const selection = plugins.find(p => p.id === descriptor.id),
    file = selection?.file ?? descriptor.configFile!
  const configExists = existsSync(packPath(root, file))
  const config = (configExists ? json(root, file) : null) as RpgSource | null
  const bindings = selection ? pageBindings(root) : {}
  const locations = records.filter(r => r.kind === 'location').map(({ id, name }) => ({ id, name }))
  const player = String(records.find(r => r.kind === 'slot')?.values.characterId ?? '')
  const characters = records.filter(r => r.kind === 'character').map(({ id, name }) => ({ id, name }))
  return {
    plugins,
    gameplayScript: m.scripts?.gameplay,
    enabled: !!selection,
    configExists,
    ruling: { plugin: descriptor.id, combat: 'packages/plugins/src/rpg/battle.ts' },
    file,
    config,
    slots: [
      ...new Set([
        ...Object.values(config?.characters ?? {}).flatMap(c => c.slots ?? []),
        ...Object.values(config?.equipment ?? {}).map(e => e.slot),
      ]),
    ],
    schema: descriptor.configSchema,
    player,
    characters,
    locations,
    items: records
      .filter(r => r.kind === 'item')
      .map(r => ({ id: r.id, name: r.name, location: String(r.values.locationId) })),
    scenes: records
      .filter(r => r.kind === 'scene')
      .map(r => ({ id: r.id, location: String(r.values.locationId), name: r.name })),
    activities: selection
      ? (config?.maps ?? []).map(map => ({
          key: mapActivityKey(map.locationId),
          location: map.locationId,
          cues: cueFlow(config!, map, characters, player),
          page: bindings[mapActivityKey(map.locationId)] ?? null,
          title: locations.find(l => l.id === map.locationId)?.name ?? map.locationId,
        }))
      : [],
  }
}

export function rpgCueCandidates(source: string, body: Record<string, unknown>) {
  const book = rpgBook(source)
  const map = book.config?.maps?.find(m => m.locationId === body.location)
  if (!book.enabled || !book.config || !map) throw new TypeError('请选择已启用 RPG 的地图')
  return cueCandidates(book.config, map, book.characters, book.player, body as Partial<RpgCue>)
}

function encounter(player: string, location: string): RpgSource {
  return {
    plugin: { id: descriptor.id, version: descriptor.version },
    stats: [
      { key: 'hp', label: '生命' },
      { key: 'mp', label: '魔力' },
    ],
    characters: {
      [player]: { stats: { hp: 32, mp: 8 }, attack: 2, defense: 1, speed: 20, skills: ['strike', 'fire'], slots: [] },
    },
    skills: [
      {
        id: 'strike',
        name: '普通攻击',
        scope: 'one',
        target: 'opponent',
        effects: [{ kind: 'damage', amount: 6 }],
        cost: {},
      },
      {
        id: 'fire',
        name: '火球术',
        scope: 'one',
        target: 'opponent',
        effects: [{ kind: 'damage', amount: 10 }],
        cost: { mp: 2 },
      },
    ],
    enemies: {
      sentinel: {
        name: '守卫',
        hp: 18,
        attack: 1,
        defense: 0,
        speed: 10,
        skills: ['strike'],
        strategy: 'lowest-hp',
        lines: {},
      },
    },
    maps: [
      { locationId: location, narration: { first: '前方出现了一名守卫。' }, enemies: ['sentinel'], engage: 'on-enter' },
    ],
  }
}

export function saveRpg(source: string, body: Record<string, unknown>) {
  return saveModeSource(
    source,
    body,
    descriptor,
    rpgBook,
    book => {
      if (!book.player || !book.locations.some(l => l.id === body.location))
        throw new TypeError('请先配置玩家席位并选择遭遇地点')
      return encounter(book.player, String(body.location))
    },
    body.operation === 'rpg-enable',
  )
}
