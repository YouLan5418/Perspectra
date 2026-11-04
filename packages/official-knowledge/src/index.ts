import type { KnowledgeInstance, SeamProvider } from '@harness-world/plugin-sdk'
import { KnowledgeSelection } from './selection.ts'
export { KnowledgeSelection } from './selection.ts'

export const officialKnowledgeProvider: SeamProvider<KnowledgeInstance> = {
  id: 'official-knowledge',
  version: '1.0.0',
  open: async world => {
    const source = world.knowledgeSource
    const selection = source === undefined ? undefined : KnowledgeSelection.parse(source.configuration, source.content)
    return { select: context => selection?.select(context) }
  },
}
