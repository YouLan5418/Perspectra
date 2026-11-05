import type { WorldJsonObject } from '@harness-world/contracts'
import type { SeamProvider } from './world.ts'

export interface CommunicationSource {
  readonly config: unknown
}
export interface CommunicationInstance {
  readonly definition: unknown
  readonly instruction: string
  parameters(recipientId: string, text: string): WorldJsonObject
  options(input: {
    readonly actorId: string
    readonly recipientIds: readonly string[]
    readonly publicationCharacters: number
  }): readonly WorldJsonObject[]
  prepare(input: {
    readonly actorId: string
    readonly recipientId: string
    readonly text: string
    readonly publicationCharacters: number
  }): unknown
  describeDelivery(status: 'accepted' | 'rejected'): string
  close?(): void | Promise<void>
}
export interface CommunicationSlotApi {
  register(provider: SeamProvider<CommunicationInstance>): () => void
  readonly current: SeamProvider<CommunicationInstance> | undefined
}
