import type {
  ActionAffordance,
  RulebookResolution as RuleResolution,
  RulebookResolutionContext as RuleContext,
} from '@harness-world/kernel'
import type { SeamProvider } from './world.ts'

export type {
  ActionAffordance,
  RulebookResolution as RuleResolution,
  RulebookResolutionContext as RuleContext,
} from '@harness-world/kernel'
type AffordanceContext = Omit<RuleContext, 'action' | 'actionId'>

/** One layer of rules around the official ones. It sees speech, moves and core interactions by players and
 * characters, in or out of an activity; status operations, activity operations and messages have their own rules
 * and do not pass through. Refusing a character's speech counts as a failed round for that character. Rules decide
 * synchronously and must be deterministic: regeneration relies on the same input giving the same answer. A
 * resolution can only carry events the trunk already knows. */
export interface RulesInstance {
  resolve?(context: RuleContext, next: (context: RuleContext) => RuleResolution): RuleResolution
  affordances?(
    context: AffordanceContext,
    next: (context: AffordanceContext) => readonly ActionAffordance[],
  ): readonly ActionAffordance[]
  close?(): void | Promise<void>
}
/** `ctx.rules`: any number of layers, the first registered outermost. Wrap `register` in `ctx.effect()`. */
export interface RulesApi {
  register(provider: SeamProvider<RulesInstance>): () => void
  readonly providers: readonly SeamProvider<RulesInstance>[]
}
