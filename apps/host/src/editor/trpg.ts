import { configCandidates, configObject } from '@perspectra/world-pack/editor-config'
import { officialPackPlugins } from '../official-pack-metadata.ts'
import { communicationBook } from './communication.ts'
import { pluginBook, saveModeSource } from './mode-source.ts'
import { rpgBook } from './rpg.ts'
const descriptor = officialPackPlugins.find(p => p.id === 'official-trpg')!
export const trpgBook = (source: string) => pluginBook(source, descriptor)
export function saveTrpg(source: string, body: Record<string, unknown>) {
  return saveModeSource(
    source,
    body,
    descriptor,
    trpgBook,
    () => ({
      plugin: { id: descriptor.id, version: descriptor.version },
      sheet: {
        stats: [{ key: 'hp', label: '生命', max: 10 }],
        skills: [{ key: 'observe', label: '观察', modifier: 0 }],
        dice: 'd20',
      },
    }),
    body.operation === 'trpg-enable',
  )
}
export function modeCandidates(source: string, body: Record<string, unknown>) {
  const { mode, path, dictionary } = body
  if (
    (mode !== 'rpg' && mode !== 'trpg' && mode !== 'communication') ||
    !Array.isArray(path) ||
    path.some(k => typeof k !== 'string') ||
    (dictionary !== undefined && typeof dictionary !== 'boolean')
  )
    throw new TypeError('请提供玩法和字段路径数组')
  const book =
    mode === 'rpg' ? rpgBook(source) : mode === 'communication' ? communicationBook(source) : trpgBook(source)
  return {
    options: configCandidates(mode, configObject(body.config ?? book.config), book, path, dictionary === true) ?? null,
  }
}
