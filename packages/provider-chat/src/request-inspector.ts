import type { ChatMessage } from './wire.ts'
export interface MessageSource {
  source: string
  name: string
  original?: string
  macroExpanded?: boolean
}
export interface CallInspection {
  characterId: string
  continuation: boolean
  sources: MessageSource[]
}
export interface InspectedRequest {
  id: number
  characterId: string
  continuation: boolean
  model: string
  startedAt: string
  status: 'pending' | 'ok' | 'failed'
  durationMs?: number
  body: Record<string, unknown> | null
  omitted?: string
  messages: { role: string; content: string; source: MessageSource; estimatedTokens: number }[]
  contextParts: { name: string; content: string; estimatedTokens: number }[]
  estimatedBodyTokens: number
  estimatedToolTokens: number
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number }
}
export interface InspectorSnapshot { enabled: boolean; requests: InspectedRequest[] }
/** Local approximation; deliberately distinct from provider usage. */
export function estimateRequestTokens(text: string): number {
  let ascii = 0, other = 0
  for (const char of text) { if (char.codePointAt(0)! < 128) ascii++; else other++ }
  return Math.ceil(ascii / 3 + other)
}
/** Opt-in volatile snapshots only. Never receives headers, credentials, or provider response text. */
export class RequestInspector {
  #enabled = false
  #next = 0
  #requests: InspectedRequest[] = []
  configure(enabled: boolean): InspectorSnapshot { this.#enabled = enabled; this.#requests = []; return this.snapshot() }
  snapshot(): InspectorSnapshot { return structuredClone({ enabled: this.#enabled, requests: this.#requests }) }
  begin(body: Record<string, unknown>, info?: CallInspection, logicalMessages?: readonly ChatMessage[], model?: string): number | undefined {
    if (!this.#enabled || !info) return undefined
    const serialized = JSON.stringify(body)
    const id = ++this.#next
    const request: InspectedRequest = { id, characterId: info.characterId, continuation: info.continuation,
      model: model ?? String(body.model), startedAt: new Date().toISOString(), status: 'pending', body: null,
      messages: [], contextParts: [], estimatedBodyTokens: estimateRequestTokens(serialized),
      estimatedToolTokens: estimateRequestTokens(JSON.stringify(body.tools ?? body.format ?? {})) }
    // Retain at most four calls, each <= 1M UTF-16 characters. Oversized requests are explicit omissions.
    if (serialized.length > 1_000_000) request.omitted = '请求超过检查器保留上限；正文未捕获。'
    else {
      request.body = structuredClone(body)
      const messages = logicalMessages ?? body.messages as { role: string; content: string }[]
      request.messages = messages.map((message, i) => ({ ...message,
        source: structuredClone(info.sources[i] ?? {source:'core',name:'宿主消息'}), estimatedTokens: estimateRequestTokens(message.content) }))
      for (const [index, message] of messages.entries()) {
        if (info.sources[index]?.source !== 'context') continue
        try {
          const context = JSON.parse(message.content).context as Record<string, unknown> | undefined
          if (!context || typeof context !== 'object') continue
          for (const [name, value] of Object.entries(context)) {
            const content = JSON.stringify(value)
            request.contextParts.push({ name, content, estimatedTokens: estimateRequestTokens(content) })
          }
        } catch { /* Plain prompt messages have no structured context parts. */ }
      }
    }
    this.#requests.push(request)
    if (this.#requests.length > 4) this.#requests.shift()
    return id
  }
  finish(id: number | undefined, status: 'ok' | 'failed', durationMs: number, response?: unknown): void {
    const request = this.#requests.find(r => r.id === id)
    if (!request) return
    request.status = status; request.durationMs = durationMs
    const root = response as Record<string, unknown> | undefined
    const usage = (root?.usage ?? root?.usageMetadata) as Record<string, unknown> | undefined
    const finite = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
    const input = finite(usage?.prompt_tokens ?? usage?.input_tokens ?? usage?.promptTokenCount ?? root?.prompt_eval_count)
    const output = finite(usage?.completion_tokens ?? usage?.output_tokens ?? usage?.candidatesTokenCount ?? root?.eval_count)
    const total = finite(usage?.total_tokens ?? usage?.totalTokenCount)
    if (input !== undefined || output !== undefined || total !== undefined) request.usage = {
      ...(input === undefined ? {} : {inputTokens:input}), ...(output === undefined ? {} : {outputTokens:output}), ...(total === undefined ? {} : {totalTokens:total}) }
  }
}
