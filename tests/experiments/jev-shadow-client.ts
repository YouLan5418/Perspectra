import { holderCriteria, type HolderAnswer, type HolderQuestion } from './jev-shadow.ts'

const record = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('invalid Jev response')
  return value as Record<string, unknown>
}
const optionalNumber = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null

export function holderRequest(question: HolderQuestion): Record<string, unknown> {
  return { model: 'typesafe/jev-1.13', state: {
    target: question.item, items: question.items, characters: question.characters,
    publication: question.publication,
  }, questions: { item_holder: { type: 'choice',
    instructions: '只解释 publication 中对 target 的持有宣称，不判断世界真假。'
      + 'actorId 是表达者；speech 是角色对白，可以说谎；narration 是客观叙述，里面引用的对白和思想仍属于角色陈述。'
      + 'items 是显式物品名称和别名，characters 是全部可选角色。同名物品不能唯一定位时选 UNCERTAIN。'
      + '只有 narration 客观确认当前持有者时才选 holder 或 GROUND。仅有意图、递出但未确认接收、历史回忆不算当下持有事实。',
    criteria: holderCriteria(question.characters),
  } } }
}

export function parseHolderAnswer(input: unknown, question: HolderQuestion): HolderAnswer {
  const body = record(input), answer = record(record(body.answers).item_holder)
  const labels = Object.keys(holderCriteria(question.characters))
  const probabilities = record(answer.probabilities)
  if (answer.type !== 'choice' || typeof answer.choice !== 'string' || !labels.includes(answer.choice)
    || labels.some(label => typeof probabilities[label] !== 'number'
      || !Number.isFinite(probabilities[label]) || (probabilities[label] as number) < 0 || (probabilities[label] as number) > 1)
    || Math.abs(labels.reduce((sum, label) => sum + (probabilities[label] as number), 0) - 1) > 0.02
    || typeof body.model !== 'string') throw new TypeError('invalid Jev choice response')
  const usage = body.usage === undefined ? {} : record(body.usage)
  return { choice: answer.choice,
    probabilities: Object.fromEntries(labels.map(label => [label, probabilities[label] as number])),
    confidence: optionalNumber(answer.confidence), model: body.model,
    inputTokens: optionalNumber(usage.input_tokens), outputTokens: optionalNumber(usage.output_tokens),
    costUsd: optionalNumber(usage.cost) }
}

/** One bounded call; a failed shadow request is evidence, not a reason to retry the main turn. */
export function createHolderClassifier(apiKey: string): (question: HolderQuestion) => Promise<HolderAnswer> {
  if (!apiKey.trim()) throw new TypeError('OPENROUTER_JEV_KEY unavailable in this process')
  return async question => {
    let response: Response
    try {
      response = await fetch('https://openrouter.ai/api/alpha/decisions', {
        method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(holderRequest(question)), signal: AbortSignal.timeout(5_000),
      })
    } catch { throw new Error('Jev transport failed') }
    if (!response.ok) throw new Error(`Jev HTTP ${response.status}`)
    return parseHolderAnswer(await response.json(), question)
  }
}
