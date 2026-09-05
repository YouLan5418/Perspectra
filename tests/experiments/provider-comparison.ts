import { object, type ExperimentMessage, type ExperimentOutputMode } from './compact-context.ts'

export type ComparisonVariant = 'original' | 'ownership_clear' | 'turn_taking'
export type ComparisonProvider = 'ollama' | 'deepseek'

const speechOutputContract = '只返回 JSON 对象，格式为 {"decision":"act"或"abstain","text":"中文角色对白"}。只说一句角色对白，最长500字；沉默时 text 必须为空。不输出思维过程。'
const actionOutputContract = '只返回 JSON 对象，格式为 {"decision":"act"或"abstain","actions":[{"actionType":"speak|move|take","parameters":{...}}],"reflection":[{"recordRef":"R编号","changes":{...}}]}。最多两个动作，只能选择 affordances 中出现的动作。speak 参数只能是 {"text":"中文角色对白"}；move 必须用 affordances.parameterDomains 中的 {"locationRef":"L编号"}；take 必须用其中的 {"entityRef":"E编号"}。不要猜测或输出内部 ID。不要输出 actorId 或 actionId，它们由宿主填写。reflection 可省略或为空，最多更新 current_self_state 中一个已有 R 编号记录，不能创建记录：subjective-claim 只可改 stance/confidencePermille，relationship-attitude 只可改 intensityPermille/confidencePermille，character-goal 只可改 priorityPermille/status（status 仅 active/blocked）；数值每次最多变化 200。来源与状态校验由宿主填写。没有有意义的动作时返回 {"decision":"abstain","actions":[]}。不输出思维过程。'
const ownershipContract = '身份归属提醒：你只扮演 character_anchor 指定的角色。近期记录可能同时包含自己和别人的发言；请按每条记录中的 characterId、actorId 或 speakerId 区分说话者。别人的第一人称经历不等于你的经历，不要把别人的发言复制成自己的回答。观察者听到了某句话，只代表听到了该说法，并不自动证明说法为真。以当前角色自己的目标、情绪和立场回应；不得替其他角色发言。'
const turnTakingContract = (mode: ExperimentOutputMode) => `发言时机：被调用只表示有机会行动，不代表必须说话。先对照近期记录：只有你有尚未说过的新信息、需要回答且尚未回答的问题、尚未表达的异议，或明确的新意图时才行动。若只是重复自己的意思、同义改写、附和对方或再次告别，而没有新的交流作用，返回 ${mode === 'speech_only' ? '{"decision":"abstain","text":""}' : '{"decision":"abstain","actions":[]}'}。双方已说清楚或结束话题时，不要为了响应而继续。不要编造新事实来满足新信息要求，也不要省略对直接问题的必要回答。有实际交流作用的强调、犹豫或争执仍可表达；判断交流作用而非仅看字面相似。只返回既定 JSON，不输出判断过程。`

export function comparisonMessages(
  input: readonly ExperimentMessage[],
  variant: ComparisonVariant,
  outputMode: ExperimentOutputMode = 'speech_only',
) {
  // Both vendors receive identical message bytes. DeepSeek does not expose developer role.
  const messages = input.map(message => ({
    role: message.role === 'developer' ? 'system' as const : message.role,
    content: message.content,
  }))
  messages.splice(2, 0, { role: 'system', content: outputMode === 'speech_only' ? speechOutputContract : actionOutputContract })
  if (variant === 'ownership_clear' || variant === 'turn_taking') messages.splice(3, 0, { role: 'system', content: ownershipContract })
  if (variant === 'turn_taking') messages.splice(4, 0, { role: 'system', content: turnTakingContract(outputMode) })
  return messages
}

export function comparisonResponse(provider: ComparisonProvider, raw: unknown) {
  const response = object(raw)
  const message = provider === 'ollama' ? object(response.message)
    : object(object((response.choices as unknown[])[0]).message)
  if (typeof message.content !== 'string') throw new TypeError('provider returned no content')
  const finishReason = provider === 'ollama' ? response.done_reason : object((response.choices as unknown[])[0]).finish_reason
  if (finishReason !== 'stop') throw new TypeError('provider response was not complete')
  return {
    content: message.content,
    // Do not persist raw vendor objects, headers, credentials, or reasoning content.
    model: response.model,
    usage: provider === 'ollama'
      ? { promptTokens: response.prompt_eval_count, completionTokens: response.eval_count }
      : { promptTokens: object(response.usage).prompt_tokens,
        completionTokens: object(response.usage).completion_tokens,
        cacheHitTokens: object(response.usage).prompt_cache_hit_tokens,
        cacheMissTokens: object(response.usage).prompt_cache_miss_tokens },
  }
}
