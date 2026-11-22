import { officialPackPlugins } from '../official-pack-metadata.ts'
import { pluginBook, saveModeSource } from './mode-source.ts'
const communication = officialPackPlugins.find(p => p.id === 'official-communication')!
export const communicationBook = (source: string) => pluginBook(source, communication)
export function saveCommunication(source: string, body: Record<string, unknown>) {
  return saveModeSource(
    source,
    body,
    communication,
    communicationBook,
    () => ({ medium: '短信', contacts: {} }),
    body.operation === 'communication-enable',
  )
}
