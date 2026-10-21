/** Model-authored fields only: excludes headers, opaque signatures and provider configuration. */
export interface InspectedResponse {
  content: string[]
  thinking: { kind: 'text' | 'summary'; text: string }[]
  thinkingStatus: 'provided' | 'not_provided'
  toolCalls: { id?: string; name: string; arguments: unknown }[]
  finishReason: string | null
  omitted?: string
}
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
export function inspectResponse(value: unknown): InspectedResponse {
  const root = record(value),
    choice = record(Array.isArray(root.choices) ? root.choices[0] : undefined)
  const message = record(choice.message ?? root.message)
  const candidate = record(Array.isArray(root.candidates) ? root.candidates[0] : undefined)
  const result: InspectedResponse = {
    content: [],
    thinking: [],
    thinkingStatus: 'not_provided',
    toolCalls: [],
    finishReason: null,
  }
  const text = (value: unknown) => {
    if (typeof value === 'string' && value.length) result.content.push(value)
  }
  const thought = (value: unknown, kind: 'text' | 'summary' = 'text') => {
    if (typeof value === 'string' && value.length) result.thinking.push({ kind, text: value })
  }
  text(message.content)
  thought(message.reasoning_content ?? message.thinking ?? message.reasoning)
  for (const value of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
    const call = record(value),
      fn = record(call.function)
    if (typeof fn.name === 'string')
      result.toolCalls.push({
        ...(typeof call.id === 'string' ? { id: call.id } : {}),
        name: fn.name,
        arguments: fn.arguments ?? null,
      })
  }
  for (const value of Array.isArray(root.content) ? root.content : []) {
    const block = record(value)
    if (block.type === 'text') text(block.text)
    if (block.type === 'thinking') thought(block.thinking)
    if (block.type === 'tool_use' && typeof block.name === 'string')
      result.toolCalls.push({
        ...(typeof block.id === 'string' ? { id: block.id } : {}),
        name: block.name,
        arguments: block.input ?? null,
      })
  }
  for (const value of Array.isArray(record(candidate.content).parts)
    ? (record(candidate.content).parts as unknown[])
    : []) {
    const part = record(value),
      call = record(part.functionCall)
    if (part.thought === true) thought(part.text, 'summary')
    else text(part.text)
    if (typeof call.name === 'string') result.toolCalls.push({ name: call.name, arguments: call.args ?? null })
  }
  const reason = choice.finish_reason ?? root.stop_reason ?? candidate.finishReason ?? root.done_reason
  if (typeof reason === 'string') result.finishReason = reason
  result.thinkingStatus = result.thinking.length ? 'provided' : 'not_provided'
  if (JSON.stringify(result).length > 1_000_000)
    return {
      content: [],
      thinking: [],
      thinkingStatus: result.thinkingStatus,
      toolCalls: [],
      finishReason: result.finishReason,
      omitted: '响应超过检查器保留上限；正文和思考未保留。',
    }
  return result
}
