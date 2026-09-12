import { WorldError, type CharacterContextBundle } from '@harness-world/contracts'
import { contextProfile, type CharacterContextAssembly, type CharacterContextRequest } from './context-v2.ts'
import type { RenderedProviderRequest } from './provider-request.ts'

export interface BudgetedCharacterContext {
  readonly assembly: CharacterContextAssembly
  readonly rendered: RenderedProviderRequest
}

/** True only for the Provider byte-budget refusal that dropping Tier 3/4 content can still resolve. */
function isProviderBudgetExceeded(error: unknown): boolean {
  return error instanceof WorldError
    && error.envelope.category === 'provider'
    && error.envelope.errorCode === 'CONTEXT_WINDOW_EXCEEDED'
}

/**
 * Split a total drop count into the drops the frozen trim priority prescribes. Tier 4 content goes first,
 * and within it the earliest history goes before the most recent: the long-term digest covers the Rounds
 * furthest back, then long-term Recall, and only then whole recent Interaction Tail blocks, which are Tier 3.
 */
function splitBudgetTrim(
  dropped: number,
  digestItems: number,
  recallItems: number,
  tailBlocks: number,
): { readonly digestItems: number; readonly recallItems: number; readonly tailBlocks: number } {
  const digestDrops = Math.min(dropped, digestItems)
  const recallDrops = Math.min(dropped - digestDrops, recallItems)
  return {
    digestItems: digestDrops,
    recallItems: recallDrops,
    tailBlocks: Math.min(dropped - digestDrops - recallDrops, tailBlocks),
  }
}

/**
 * Assemble a Character Context and render it within the Model Profile byte budget.
 *
 * The untrimmed request is rendered first, so a request that already fits stays byte-identical to the
 * pre-trim behaviour. Only when the Provider refuses an over-budget request are Tier 3/4 items given up, one
 * at a time and fewest first; every drop reaches the durable exclusions as `budget_trimmed`. Content no drop
 * can shrink still fails closed with the original refusal.
 */
export class CharacterContextBudgetPlanner {
  constructor(
    private readonly assemble: (request: CharacterContextRequest) => CharacterContextAssembly,
    private readonly render: (bundle: CharacterContextBundle) => RenderedProviderRequest,
  ) {}

  plan(request: CharacterContextRequest): BudgetedCharacterContext {
    const selectedProfile = contextProfile(request.contextProfileId)
    const digestItems = request.digest?.length ?? 0
    const recallItems = Math.min(request.recall.memories.length, selectedProfile.recallResults)
    const tailBlocks = Math.min(request.tail.blocks.length, selectedProfile.recentInteractionBlocks)
    const maximumDrops = digestItems + recallItems + tailBlocks
    for (let dropped = 0; ; dropped += 1) {
      const assembly = this.assemble(dropped === 0
        ? request
        : { ...request, budgetTrim: splitBudgetTrim(dropped, digestItems, recallItems, tailBlocks) })
      try {
        return { assembly, rendered: this.render(assembly.bundle) }
      } catch (error: unknown) {
        if (!isProviderBudgetExceeded(error) || dropped >= maximumDrops) throw error
      }
    }
  }
}
