import type { KnowledgeSource } from '@harness-world/plugin-sdk'
import type { CompiledWorldPackV5 } from '@harness-world/world-pack'
import { packJsonAsset } from './pack-json-asset.ts'

/** Asset verification belongs to the host; the mechanism receives only its declared materials. */
export function loadKnowledgeSource(root: string, pack: CompiledWorldPackV5): KnowledgeSource | undefined {
  const configuration = packJsonAsset(root, pack, 'knowledge.json', 1024 * 1024)
  if (configuration === undefined) return undefined
  return {
    configuration,
    content: {
      documents: pack.content.documents.map(({ documentId, usage, audience, characterIds, contentRef }) => ({
        documentId,
        usage,
        audience,
        characterIds: [...characterIds],
        contentRef,
      })),
      markdown: pack.content.markdown.map(({ path, text }) => ({ path, text })),
    },
  }
}
