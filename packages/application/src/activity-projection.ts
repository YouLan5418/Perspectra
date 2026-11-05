import {
  checkExpressionPolicy,
  parseExpressionSegments,
  type ActivityOperation,
  type ActivityPolicy,
  type ActivityState,
  type WorldJsonObject,
} from '@harness-world/contracts'
import type { ActionAffordance } from '@harness-world/kernel'
import { activityExact as exact, activityObject as object, type ActivityStateRules } from './activity-state.ts'

/** Choices bound to the exact activity and revision they were offered from, so a late answer cannot act on newer state. */
export function activityOperationOptions(
  state: ActivityState,
  policy: ActivityPolicy,
  operations: readonly ActivityOperation[],
  actorId: string,
): WorldJsonObject[] {
  return operations
    .filter(op => policy.operations.includes(op.id) && (!op.requiresTurn || state.game.turn === actorId))
    .map(op => ({
      label: op.label,
      targetRef: { kind: 'character', id: actorId },
      bindingId: state.id,
      definitionRef: { id: 'activity:' + op.id, version: 1 },
      arguments: { activityId: state.id, revision: state.revision },
      argumentSchema: {
        ...op.schema,
        required: ['activityId', 'revision', ...((op.schema.required as string[]) ?? [])],
        properties: {
          ...object(op.schema.properties ?? {}),
          activityId: { const: state.id, type: 'string' },
          revision: { const: state.revision, type: 'integer' },
        },
      },
    }))
}

/** What a participant may do under the activity's policy. One interact entry: wire builders select a single
 * affordance per action type. */
export function filterActivityAffordances(
  base: readonly ActionAffordance[],
  policy: ActivityPolicy,
  options: readonly WorldJsonObject[],
  canPerform: boolean,
): ActionAffordance[] {
  const result: ActionAffordance[] = base.flatMap(a =>
    a.actionType === 'move'
      ? policy.move && canPerform
        ? [a]
        : []
      : a.actionType === 'interact'
        ? [
            {
              ...a,
              interactions: canPerform
                ? (a.interactions ?? []).filter(i => policy.interactions.includes(String(object(i.definitionRef).id)))
                : [],
            },
          ]
        : a.actionType === 'speak' && (policy.speech !== 'none' || policy.narration)
          ? [a]
          : [],
  )
  if (options.length) result.push({ actionType: 'interact', actionVersion: 2, interactions: [...options] })
  const interactions = result.filter(a => a.actionType === 'interact').flatMap(a => a.interactions ?? [])
  return [
    ...result.filter(a => a.actionType !== 'interact'),
    ...(interactions.length ? [{ actionType: 'interact', actionVersion: 2, interactions }] : []),
  ]
}

export function checkActivityExpression(policy: ActivityPolicy, parameters: WorldJsonObject): void {
  if (
    (!policy.narration && Object.hasOwn(parameters, 'narration')) ||
    (policy.speech === 'none' && Object.hasOwn(parameters, 'speech')) ||
    (policy.speech === 'choices' &&
      Object.hasOwn(parameters, 'speech') &&
      !policy.speechChoices.includes(String(parameters.speech)))
  )
    throw new TypeError('当前表达不在创作者许可内')
}

/** A character's decision during its activity turn; a mixed output is refused whole. */
export function validateActivityDecision(
  decision: WorldJsonObject,
  policy: ActivityPolicy,
  publicationCharacters: number,
): void {
  if (decision.decision === 'publish') {
    if (Object.keys(decision).some(k => !['decision', 'segments', 'scope', 'addresseeIds'].includes(k)))
      throw new TypeError('非法混合输出整包拒绝')
    checkExpressionPolicy(parseExpressionSegments(decision.segments, publicationCharacters), policy)
  } else if (decision.decision === 'perform') {
    if (Object.keys(decision).sort().join(',') !== 'actionType,decision,parameters')
      throw new TypeError('非法混合输出整包拒绝')
  }
}

/** The shape of a mechanism's operation result. An author refusal is an answer; a malformed result is a fault. */
export function parseActivityOperationResult(
  value: unknown,
  rules: ActivityStateRules,
  state: ActivityState,
):
  | { readonly rejected: string }
  | {
      readonly next: ActivityState
      readonly description: string
      readonly audience: 'participants' | 'self'
      readonly status?: unknown
      readonly playerExpression?: unknown
    } {
  const resolved = object(value)
  if (Object.hasOwn(resolved, 'rejectReason')) {
    exact(resolved, ['rejectReason'])
    if (
      typeof resolved.rejectReason !== 'string' ||
      !resolved.rejectReason.trim() ||
      resolved.rejectReason.length > 2000
    )
      throw new TypeError('活动拒绝说明无效')
    return { rejected: resolved.rejectReason }
  }
  exact(resolved, [
    'game',
    'description',
    'audience',
    ...['playerExpression', 'status'].filter(k => Object.hasOwn(resolved, k)),
  ])
  if (
    typeof resolved.description !== 'string' ||
    resolved.description.length > 2000 ||
    !['participants', 'self'].includes(String(resolved.audience))
  )
    throw new TypeError('游戏结果无效')
  return {
    next: { ...state, revision: state.revision + 1, game: rules.game(resolved.game, state.participants) },
    description: resolved.description,
    audience: resolved.audience as 'participants' | 'self',
    ...(Object.hasOwn(resolved, 'status') ? { status: resolved.status } : {}),
    ...(Object.hasOwn(resolved, 'playerExpression') ? { playerExpression: resolved.playerExpression } : {}),
  }
}

/** Scheduling may read hidden state, but only an activation of a current participant leaves the script. */
export function parseActivityPlan(
  value: unknown,
  state: ActivityState | undefined,
  playerId: string,
): string | undefined {
  const plan = object(value)
  if (plan.kind === 'wait') {
    exact(plan, ['kind'])
    return undefined
  }
  exact(plan, ['kind', 'characterId'])
  if (
    plan.kind !== 'activate' ||
    typeof plan.characterId !== 'string' ||
    plan.characterId === playerId ||
    !state?.game.active ||
    !state.participants.includes(plan.characterId)
  )
    throw new TypeError('调度请求了未授权角色')
  return plan.characterId
}
