import type { MemoryRequest } from './memory.ts'
import type { WorldJsonObject, WorldJsonValue } from '@harness-world/contracts'
import type { SeamProvider } from './world.ts'

/** One model call: the messages to send and the JSON Schema the answer must meet. Hand it back unchanged in
 * `send`; the host's calls carry an extra inspection field for the request log. */
export interface LlmCall {
  readonly messages: readonly { readonly role: string; readonly content: string }[]
  readonly schema: WorldJsonObject
}
/** How characters reach a model. Only `send` is required. */
export interface LlmInstance {
  /** Send one call and return the parsed answer. The host validates it and retries once on bad format, so hand
   * back text you cannot parse; throw only when the call itself failed. Honor `signal`: when it fires the host
   * stops waiting, and anything the call is still doing is yours to stop. */
  send(characterId: string, call: LlmCall, request: MemoryRequest, signal: AbortSignal): Promise<unknown>
  /** Replace the default prompt for this decision. Without it the host's default call is sent as is. */
  prepare?(characterId: string, request: MemoryRequest, signal: AbortSignal): Promise<LlmCall>
  /** Extra text that counts against the character's context budget, such as a preset prompt. */
  promptText?(characterId: string): string
  /** Reshape what the player reads, such as preset display rules. */
  display?<T>(view: T): Promise<T>
  dispatch?(request: WorldJsonValue, profile: WorldJsonObject, signal: AbortSignal): Promise<WorldJsonValue>
  close?(): void | Promise<void>
}
/** Settings from the player's selected portrayal preset, never connection credentials. */
export interface LlmGenerationSettings {
  readonly temperature?: number
  readonly topP?: number
  readonly frequencyPenalty?: number
  readonly presencePenalty?: number
  readonly maxOutputTokens?: number
  readonly stop?: readonly string[]
}
export interface LlmTransportCall extends LlmCall {
  readonly generation: LlmGenerationSettings
}
export interface LlmTransportResponse {
  readonly value: unknown
  readonly httpStatus?: number
}
/** Character decisions only. Encoding, endpoint and its credentials belong to the adapter. */
export interface LlmTransportInstance {
  readonly model: string
  /** native keeps root alternatives; gateway uses the existing flattened gateway schema. */
  readonly schemaMode: 'native' | 'gateway'
  send(characterId: string, call: LlmTransportCall, signal: AbortSignal): Promise<LlmTransportResponse>
  close?(): void | Promise<void>
}
/** `ctx.llm`: replaces how characters reach a model. Wrap `register` in `ctx.effect()`. */
export interface LlmSlotApi {
  /** Throws when another plugin already holds the seam. */
  register(provider: SeamProvider<LlmInstance>): () => void
  registerTransport(provider: SeamProvider<LlmTransportInstance>): () => void
  readonly currentTransport: SeamProvider<LlmTransportInstance> | undefined
  readonly current: SeamProvider<LlmInstance> | undefined
}
