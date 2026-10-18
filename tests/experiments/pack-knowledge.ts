import type { WorldJsonObject } from '@harness-world/contracts'
import type { CompiledWorldPackV5 } from '@harness-world/world-pack'
import { packJsonAsset } from './pack-json-asset.ts'

/** Sized for imported Tavern lorebooks: hundreds of entries, long keyword lists, and entries near 40k characters. */
const MAX_ENTRIES = 4096, MAX_KEYWORDS = 256, MAX_KEYWORD_LENGTH = 512, MAX_CHARACTERS = 65536, MAX_CONFIG_BYTES = 1024 * 1024
interface KnowledgeEntry { documentId: string; keywords: string[]; constant: boolean; priority: number }
/** Author knowledge is separate from lived memory. Match only the receiver's authorized context. */
export class PackKnowledge {
  private constructor(readonly pack: CompiledWorldPackV5, readonly entries: readonly KnowledgeEntry[], readonly maximumCharacters: number) {}
  static parse(value: unknown, pack: CompiledWorldPackV5): PackKnowledge {
    const root = value as {maximumCharacters: number; entries: KnowledgeEntry[]}
    if (!root || typeof root !== 'object' || Object.keys(root).sort().join(',') !== 'entries,maximumCharacters'
      || !Number.isSafeInteger(root.maximumCharacters) || root.maximumCharacters < 100 || root.maximumCharacters > MAX_CHARACTERS
      || !Array.isArray(root.entries) || root.entries.length > MAX_ENTRIES) throw new TypeError('知识配置无效')
    for (const entry of root.entries) {
      if (!entry || typeof entry !== 'object' || Object.keys(entry).some(key => !['documentId','keywords','constant','priority'].includes(key))
        || typeof entry.documentId !== 'string' || typeof entry.constant !== 'boolean' || !Number.isSafeInteger(entry.priority)
        || !Array.isArray(entry.keywords) || entry.keywords.length > MAX_KEYWORDS || entry.keywords.some(key => typeof key !== 'string' || !key.trim() || key.length > MAX_KEYWORD_LENGTH)
        || (!entry.constant && !entry.keywords.length)) throw new TypeError('知识条目无效')
      const document = pack.content.documents.find(row => row.documentId === entry.documentId)
      if (!document || !['world_context','portrayal'].includes(document.usage) || !['public','character_private'].includes(document.audience))
        throw new TypeError('知识只能引用公开或角色私有的设定文档')
    }
    if (new Set(root.entries.map(row => row.documentId)).size !== root.entries.length) throw new TypeError('知识条目重复')
    return new PackKnowledge(pack, root.entries, root.maximumCharacters)
  }
  static load(root: string, pack: CompiledWorldPackV5): PackKnowledge | undefined {
    const value = packJsonAsset(root, pack, 'knowledge.json', MAX_CONFIG_BYTES)
    return value === undefined ? undefined : this.parse(value, pack)
  }
  select(context: WorldJsonObject): WorldJsonObject {
    const actor = String((context.character as WorldJsonObject).characterId)
    // No global transcript, other characters' cognition, or previous injected knowledge in scan text.
    const scan = JSON.stringify({character: context.character, scene: context.scene, locationId: context.locationId,
      observations: context.observations, selfObservations: context.selfObservations, stimulus: context.stimulus,
      memories: context.memories, recallEvidence: context.recallEvidence}).toLocaleLowerCase()
    let remaining = this.maximumCharacters
    const entries: WorldJsonObject[] = []
    for (const entry of [...this.entries].sort((a, b) => b.priority - a.priority || a.documentId.localeCompare(b.documentId))) {
      const document = this.pack.content.documents.find(row => row.documentId === entry.documentId)!
      if (document.audience !== 'public' && !document.characterIds.some(id => id === actor)) continue
      if (!entry.constant && !entry.keywords.some(key => scan.includes(key.toLocaleLowerCase()))) continue
      const text = this.pack.content.markdown.find(row => row.path === document.contentRef)!.text
      // Whole entries only: do not silently turn a truncated rule or secret into different content.
      if (text.length > remaining) continue
      entries.push({documentId: document.documentId, content: text}); remaining -= text.length
    }
    return {source: 'author_setting', instruction: '这些是作者提供且你有权获知的设定，不是你新近亲历的事件。结合人设、已有记忆和对话历史自主理解与表达，不预先规定你的情绪、态度或行动；重要状态仍以实际执行结果为准。', entries}
  }
}
