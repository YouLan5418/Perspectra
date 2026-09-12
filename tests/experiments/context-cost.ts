/**
 * Context cost accounting: what one provider call actually costs, and why.
 *
 * A Character Context is twelve messages, and the only part a Provider can reuse is the run of messages
 * that are byte-identical to the same character's previous call. Everything after that first difference
 * has to be paid for again. This component locates that boundary, measures how much sits after it, and
 * tracks whether the Continuity baseline moved — so a cost discussion can be about numbers.
 *
 * Token counts are estimates. The repository carries no Provider tokenizer, so CJK and other characters
 * are counted at separate per-character rates; treat the numbers as comparable across calls, not exact.
 * When a Provider reports real usage, prefer those figures.
 */

/** A rendered Provider message, as the request carries it. */
export interface ProviderMessageLike {
  readonly role: string
  readonly content: string
}

/**
 * Per-character token rates. A CJK character is close to one token on the models in use here; anything
 * else averages a few characters per token. Calibrate against real usage before treating them as money.
 */
const CJK_TOKENS_PER_CHARACTER = 0.65
const OTHER_TOKENS_PER_CHARACTER = 0.28

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff]/u

/** Estimate the tokens a rendered message costs, splitting CJK from everything else. */
export function estimateTokens(text: string): number {
  let cjk = 0
  let other = 0
  for (const character of text) {
    if (CJK.test(character)) cjk += 1
    else other += 1
  }
  return Math.round(cjk * CJK_TOKENS_PER_CHARACTER + other * OTHER_TOKENS_PER_CHARACTER)
}

/** The segment a message carries, named the way the Context names it. */
export function segmentNameOf(message: ProviderMessageLike, index: number): string {
  if (index === 0) return 'host_protocol'
  if (index === 1) return 'controller_contract'
  try {
    const parsed = JSON.parse(message.content) as { readonly segmentKind?: unknown }
    return typeof parsed.segmentKind === 'string' ? parsed.segmentKind : `message:${index}`
  } catch {
    return `message:${index}`
  }
}

/** The Continuity baseline's watermark, when the message is the continuity segment and carries one. */
function checkpointWatermarkOf(messages: readonly ProviderMessageLike[]): number | null {
  const segment = messages[4]
  if (segment === undefined) return null
  try {
    const parsed = JSON.parse(segment.content) as { readonly content?: { readonly checkpoint?: unknown } }
    const checkpoint = parsed.content?.checkpoint
    if (checkpoint === null || typeof checkpoint !== 'object') return null
    const asOfWorldSeq = (checkpoint as { readonly asOfWorldSeq?: unknown }).asOfWorldSeq
    return Number.isSafeInteger(asOfWorldSeq) ? asOfWorldSeq as number : null
  } catch {
    return null
  }
}

/**
 * The index of the first message that differs from the previous call, which is where a Provider's prefix
 * cache stops being reusable. Everything before it is identical byte for byte.
 */
export function cacheBreakpointIndex(
  previous: readonly ProviderMessageLike[],
  current: readonly ProviderMessageLike[],
): number {
  let index = 0
  while (index < previous.length && index < current.length
    && previous[index]!.content === current[index]!.content) {
    index += 1
  }
  return index
}

export interface ContextCallCost {
  readonly roundId: string
  readonly participantId: string
  readonly tick: number
  /** Every input token this call sends. */
  readonly totalTokens: number
  /** The tokens before the cache breakpoint: what a Provider can reuse from the previous call. */
  readonly cachedTokens: number
  /** The tokens after it: what has to be processed again. */
  readonly missedTokens: number
  readonly hitRate: number
  /** Where the reusable prefix ends, as a message index and the segment it belongs to. */
  readonly breakpointMessageIndex: number
  readonly breakpointSegment: string
  /** Tokens this call has over the same character's previous call. Zero when nothing grew. */
  readonly newTokens: number
  /** The Continuity baseline's watermark, and whether it moved since the previous call. */
  readonly checkpointAsOfWorldSeq: number | null
  readonly checkpointAdvanced: boolean
}

export interface ContextCallInput {
  readonly roundId: string
  readonly participantId: string
  readonly tick: number
  readonly messages: readonly ProviderMessageLike[]
}

/**
 * Track what each character's Context costs call over call.
 *
 * The first call for a character reports no reusable prefix, because there is nothing to reuse yet — its
 * breakpoint is the first message and its hit rate is zero. That is the honest answer, not a miss.
 */
export class ContextCostTracker {
  readonly #history = new Map<string, {
    readonly messages: readonly ProviderMessageLike[]
    readonly totalTokens: number
    readonly checkpointAsOfWorldSeq: number | null
  }>()

  record(call: ContextCallInput): ContextCallCost {
    const totalTokens = call.messages.reduce((sum, message) => sum + estimateTokens(message.content), 0)
    const previous = this.#history.get(call.participantId)
    const breakpointMessageIndex = previous === undefined
      ? 0
      : cacheBreakpointIndex(previous.messages, call.messages)
    const cachedTokens = call.messages
      .slice(0, breakpointMessageIndex)
      .reduce((sum, message) => sum + estimateTokens(message.content), 0)
    const checkpointAsOfWorldSeq = checkpointWatermarkOf(call.messages)
    const cost: ContextCallCost = {
      roundId: call.roundId,
      participantId: call.participantId,
      tick: call.tick,
      totalTokens,
      cachedTokens,
      missedTokens: totalTokens - cachedTokens,
      hitRate: totalTokens === 0 ? 0 : cachedTokens / totalTokens,
      breakpointMessageIndex,
      // A breakpoint at or past the last message means the whole Context was reusable: there is none.
      breakpointSegment: breakpointMessageIndex < call.messages.length
        ? segmentNameOf(call.messages[breakpointMessageIndex]!, breakpointMessageIndex)
        : 'none',
      newTokens: previous === undefined ? totalTokens : Math.max(0, totalTokens - previous.totalTokens),
      checkpointAsOfWorldSeq,
      checkpointAdvanced: previous !== undefined && checkpointAsOfWorldSeq !== null
        && previous.checkpointAsOfWorldSeq !== null
        && checkpointAsOfWorldSeq !== previous.checkpointAsOfWorldSeq,
    }
    this.#history.set(call.participantId, { messages: call.messages, totalTokens, checkpointAsOfWorldSeq })
    return cost
  }

  /** Forget every character's previous call, so the next one is treated as a first call again. */
  reset(): void {
    this.#history.clear()
  }
}

export interface ContextCostSummary {
  readonly calls: number
  readonly totalTokens: number
  readonly cachedTokens: number
  readonly missedTokens: number
  readonly hitRate: number
  readonly medianNewTokens: number
  readonly checkpointRebuilds: number
  readonly breakpointSegments: readonly string[]
}

/** Roll recorded calls into one picture, so a run can be read as a single number. */
export function summarizeContextCost(costs: readonly ContextCallCost[]): ContextCostSummary {
  const totalTokens = costs.reduce((sum, cost) => sum + cost.totalTokens, 0)
  const cachedTokens = costs.reduce((sum, cost) => sum + cost.cachedTokens, 0)
  const news = costs.map(cost => cost.newTokens).sort((left, right) => left - right)
  return {
    calls: costs.length,
    totalTokens,
    cachedTokens,
    missedTokens: totalTokens - cachedTokens,
    hitRate: totalTokens === 0 ? 0 : cachedTokens / totalTokens,
    medianNewTokens: news.length === 0 ? 0 : news[Math.floor(news.length / 2)]!,
    checkpointRebuilds: costs.filter(cost => cost.checkpointAdvanced).length,
    breakpointSegments: [...new Set(costs.map(cost => cost.breakpointSegment))].sort(),
  }
}

/** Estimated cost in CNY for a DeepSeek Flash call at the given prices per million tokens. */
export function estimateCostCny(input: {
  readonly missedTokens: number
  readonly cachedTokens: number
  readonly outputTokens: number
  readonly missedPerMillion?: number
  readonly cachedPerMillion?: number
  readonly outputPerMillion?: number
  readonly offPeak?: boolean
}): number {
  const half = input.offPeak === true ? 0.5 : 1
  const missed = (input.missedPerMillion ?? 2) * half
  const cached = (input.cachedPerMillion ?? 0.04) * half
  const output = (input.outputPerMillion ?? 8) * half
  return (input.missedTokens * missed + input.cachedTokens * cached + input.outputTokens * output) / 1_000_000
}
