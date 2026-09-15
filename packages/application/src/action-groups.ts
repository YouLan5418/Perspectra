import { compareWorldText, type ActionGroupBinding, type ActionRequest, type StepManifestation, type WorldJsonObject } from '@harness-world/contracts'
import type { RulebookResolution } from '@harness-world/kernel'

interface GroupOrderedAction {
  readonly participantId: string
  readonly proposalOrdinal: number
  readonly actionId: string
  readonly actionGroup?: ActionGroupBinding
}

/** A group's first step supplies its global sort key; original ordinals order its steps. */
export function sortActionGroups<T extends GroupOrderedAction>(items: readonly T[], compare: (left: T, right: T) => number): T[] {
  const anchors = new Map(items.filter(item => item.proposalOrdinal === 0).map(item => [item.participantId, item]))
  return [...items].sort((left, right) => {
    if (left.participantId === right.participantId && left.actionGroup !== undefined) return left.proposalOrdinal - right.proposalOrdinal
    const a = left.actionGroup === undefined ? left : anchors.get(left.participantId)!
    const b = right.actionGroup === undefined ? right : anchors.get(right.participantId)!
    return compare(a, b) || compareWorldText(a.participantId, b.participantId)
  })
}

/** Closed vocabulary is rendered only after adjudication. Never inspect or execute free text. */
export { stepManifestation } from '@harness-world/kernel'

/**
 * The model protocol keeps a step manifestation beside the Action, while the frozen interaction
 * contract carries it inside the request that the definition adjudicates. Bridge the two only for
 * that Rulebook call: the durable Action Group remains the source representation, and the definition's
 * locked performance policy gets the final say before any manifestation fact can be emitted.
 */
export function bindFrozenInteractionPerformance(
  action: ActionRequest,
  performance: StepManifestation | null,
): ActionRequest {
  if (action.actionType !== 'interact' || performance === null) return action
  const parameters = action.parameters
  if (parameters === null || typeof parameters !== 'object' || Array.isArray(parameters)) return action
  return { ...action, parameters: { ...(parameters as WorldJsonObject), performance } }
}

/** The set belongs to a single deterministic candidate fold, never to durable idempotency. */
export function resolveGroupAction(
  action: ActionRequest,
  participantId: string,
  grouped: boolean,
  stopped: Set<string>,
  resolve: (action: ActionRequest) => RulebookResolution,
): { readonly resolution: RulebookResolution; readonly skipped: boolean } {
  if (grouped && stopped.has(participantId)) return {
    resolution: { status: 'rejected', events: [], reason: 'PREVIOUS_ACTION_REJECTED', observationScope: { scope: 'self' } }, skipped: true,
  }
  const resolution = resolve(action)
  if (grouped && resolution.status === 'rejected') stopped.add(participantId)
  return { resolution, skipped: false }
}
