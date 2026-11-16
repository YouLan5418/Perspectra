import type { CommunicationDefinition, WorldJsonObject } from '@perspectra/sdk/contracts'
import type { SeamProvider } from './world.ts'

export interface CommunicationSource {
  readonly config: unknown
}
export interface CommunicationInstance {
  readonly definition: CommunicationDefinition | undefined
  readonly instruction: string
  /** May only narrow the core's live authorized contacts, using this actor's known state. */
  contacts?(input: {
    readonly actorId: string
    readonly recipientIds: readonly string[]
    readonly knownState: WorldJsonObject
  }): readonly string[]
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
