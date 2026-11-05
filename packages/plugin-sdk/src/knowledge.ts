import type { WorldJsonObject } from '@harness-world/contracts'
import type { SeamProvider } from './world.ts'

export interface KnowledgeContent {
  readonly documents: readonly {
    readonly documentId: string
    readonly usage: string
    readonly audience: string
    readonly characterIds: readonly string[]
    readonly contentRef: string
  }[]
  readonly markdown: readonly { readonly path: string; readonly text: string }[]
}
export interface KnowledgeSource {
  readonly configuration: unknown
  readonly content: KnowledgeContent
}
export interface KnowledgeInstance {
  select(context: WorldJsonObject): WorldJsonObject | undefined
  close?(): void | Promise<void>
}
export interface KnowledgeSlotApi {
  register(provider: SeamProvider<KnowledgeInstance>): () => void
  readonly current: SeamProvider<KnowledgeInstance> | undefined
}
