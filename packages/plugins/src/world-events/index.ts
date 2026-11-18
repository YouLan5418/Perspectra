import { parseEventBook, type ContentGenerator } from '@perspectra/sdk'

/** Selected content proposes stable author rule IDs. The host independently reads the locked declarations. */
export const officialWorldEvents: ContentGenerator = {
  id: 'official-world-events',
  version: '1',
  dataVersion: 1,
  configFile: 'world-events.json',
  validateConfig(raw, pack) {
    try {
      parseEventBook(raw, pack)
      return []
    } catch (error) {
      return [{ path: 'world-events.json', message: String(error) }]
    }
  },
  generate(raw, pack) {
    return { worldEventRules: parseEventBook(raw, pack).rules.map(rule => rule.id) }
  },
}
