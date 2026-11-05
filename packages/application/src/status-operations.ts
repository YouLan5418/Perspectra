import type { StatusOperation, WorldJsonObject } from '@harness-world/contracts'
import type { RulebookEvent, RulebookResolution } from '@harness-world/kernel'
import {
  statusData,
  statusExact as exact,
  statusObject as object,
  statusStrings as strings,
  statusText as text,
} from './status-state.ts'

const OPERATION_PREFIX = 'status:'

/** The author's policy result: the operations an actor may perform, some narrowed to listed items. */
export interface StatusOffers {
  readonly operations: readonly string[]
  readonly targets?: Readonly<Record<string, readonly string[]>>
}

/** Checks a mechanism's policy against the declared operations; a malformed one throws, it never widens an offer. */
export function parseStatusOffers(result: unknown, operations: readonly StatusOperation[]): StatusOffers {
  if (result === null) return { operations: operations.map(op => op.id) }
  const policy = object(result, '状态操作许可')
  exact(policy, ['operations'], ['targets'])
  const offered = strings(policy.operations, '状态操作许可')
  if (offered.some(id => !operations.some(op => op.id === id))) throw new TypeError('状态许可包含未声明的操作')
  if (policy.targets === undefined) return { operations: offered }
  const narrowed = object(policy.targets, '状态许可物品')
  const targets: Record<string, readonly string[]> = {}
  for (const [id, value] of Object.entries(narrowed)) {
    const op = operations.find(o => o.id === id)
    if (op?.targets === undefined) throw new TypeError('只能为作用于物品的操作列出物品：' + id)
    const ids = strings(value, '状态许可物品')
    if (ids.some(entity => !op.targets!.includes(entity)))
      throw new TypeError('状态许可列出了操作没有声明的物品：' + id)
    targets[id] = ids
  }
  return { operations: offered, targets }
}

/** Whether this actor may attempt this operation now. A refusal names the actor's own mistake and no status value.
 * The policy and the scene are read only when the cheaper checks have passed. */
export function admitStatusOperation(input: {
  readonly operations: readonly StatusOperation[]
  readonly operationId: string
  readonly targetId: string | undefined
  readonly parameters: unknown
  readonly actorId: string
  readonly playerId: string
  /** The foreground activity this actor takes part in. */
  readonly activityKey: string | undefined
  readonly characterIds: readonly string[]
  validArguments(operationId: string, parameters: unknown): boolean
  offers(): StatusOffers
  sceneIds(): readonly string[]
  isReachable(entityId: string, sceneIds: readonly string[]): boolean
}): { readonly op: StatusOperation; readonly sceneIds: readonly string[] } | { readonly rejected: string } {
  const { targetId, actorId, activityKey } = input
  const op = input.operations.find(o => o.id === input.operationId)
  if (!op) return { rejected: '没有这个状态操作，什么都没有发生。' }
  if (
    (op.targets === undefined) !== (targetId === undefined) ||
    (targetId !== undefined && !op.targets!.includes(targetId))
  )
    return { rejected: '这个操作不能对这件物品进行，什么都没有发生。' }
  if (op.activities && (activityKey === undefined || !op.activities.includes(activityKey)))
    return { rejected: '这个操作只能在指定活动中进行，什么都没有发生。' }
  if (!input.validArguments(op.id, input.parameters)) return { rejected: '操作缺少有效的必要信息，什么都没有发生。' }
  const parameters = input.parameters as Record<string, unknown>
  if (op.actors === 'player' ? actorId !== input.playerId : op.actors === 'npc' && actorId === input.playerId)
    return { rejected: '你不能进行这个操作，什么都没有发生。' }
  const offers = input.offers()
  if (
    !offers.operations.includes(op.id) ||
    (targetId !== undefined && offers.targets?.[op.id] !== undefined && !offers.targets[op.id]!.includes(targetId))
  )
    return { rejected: '当前已知条件不允许这个操作，什么都没有发生。' }
  const sceneIds = input.sceneIds()
  for (const name of op.characterParameters) {
    if (!Object.hasOwn(parameters, name)) continue
    const id = parameters[name]
    if (typeof id !== 'string' || !input.characterIds.includes(id))
      return { rejected: '操作指定的角色不存在，什么都没有发生。' }
    if (!sceneIds.includes(id)) return { rejected: '操作指定的角色不在你当前的场景里，什么都没有发生。' }
  }
  if (targetId !== undefined && !input.isReachable(targetId, sceneIds))
    return { rejected: '这件物品不在你够得着的地方，什么都没有发生。' }
  return { op, sceneIds }
}

/** The shape of a mechanism's operation result. An author refusal is an answer; a malformed result is a fault. */
export function parseStatusOperationResult(value: unknown):
  | { readonly rejected: string }
  | {
      readonly changes: unknown[]
      readonly reveals: unknown[]
      readonly description: string
      readonly audience: unknown
      readonly items?: unknown
    } {
  const result = object(value, '状态操作结果')
  if (Object.hasOwn(result, 'rejectReason')) {
    exact(result, ['rejectReason'])
    return { rejected: text(result.rejectReason, '状态操作拒绝说明') }
  }
  exact(result, ['changes', 'reveals', 'description', 'audience'], ['items'])
  if (typeof result.description !== 'string' || result.description.length > 2000)
    throw new TypeError('状态操作结果描述无效')
  if (!Array.isArray(result.changes) || !Array.isArray(result.reveals)) throw new TypeError('状态变化或告知必须是列表')
  return result as {
    changes: unknown[]
    reveals: unknown[]
    description: string
    audience: unknown
    items?: unknown
  }
}

/** Who may see a result: only the actor, the actor's scene, or named characters inside that scene. */
export function statusObservationScope(
  audience: unknown,
  actorId: string,
  sceneIds: readonly string[],
): NonNullable<RulebookResolution['observationScope']> {
  if (audience === 'self') return { scope: 'direct', recipientIds: [actorId] }
  if (audience === 'scene') return { scope: 'scene_public' }
  const named = object(audience, '结果接收者')
  exact(named, ['characters'])
  const recipientIds = strings(named.characters, '结果接收者')
  if (recipientIds.some(id => !sceneIds.includes(id))) throw new TypeError('结果接收者不在当前场景')
  return { scope: 'direct', recipientIds }
}

/** The choices one actor sees: the actors rule, activity scoping and, for items, what it can reach. */
export function statusOperationChoices(input: {
  readonly operations: readonly StatusOperation[]
  readonly offers: StatusOffers
  readonly activityKey: string | undefined
  readonly actorId: string
  readonly playerId: string
  isReachable(entityId: string): boolean
  entityName(entityId: string): string | undefined
}): WorldJsonObject[] {
  const { offers, activityKey, actorId, playerId } = input
  return input.operations
    .filter(
      op =>
        offers.operations.includes(op.id) &&
        (!op.activities || (activityKey !== undefined && op.activities.includes(activityKey))) &&
        (op.actors === 'any' || (op.actors === 'player') === (actorId === playerId)),
    )
    .flatMap(op => {
      const offer = (targetRef: WorldJsonObject, name?: string) => ({
        // "{item}" in the author's label names the item; otherwise several items are told apart by a suffix.
        label:
          name === undefined
            ? op.label
            : op.label.includes('{item}')
              ? op.label.replaceAll('{item}', name)
              : op.targets!.length > 1
                ? op.label + ' · ' + name
                : op.label,
        targetRef,
        bindingId: 'status',
        definitionRef: { id: OPERATION_PREFIX + op.id, version: 1 },
        arguments: {},
        argumentSchema: op.schema,
      })
      if (op.targets === undefined) return [offer({ kind: 'character', id: actorId })]
      // Offered only for what the actor holds or what lies where it is, narrowed by the author's policy.
      const narrowed = offers.targets?.[op.id]
      return op.targets
        .filter(id => input.isReachable(id) && (narrowed === undefined || narrowed.includes(id)))
        .map(id => offer({ kind: 'entity', id }, input.entityName(id)))
    })
}

/** Which round the player has reached, from committed events. Multiple player actions in one transaction are one
 * input; NPC actions and hook commits do not count, and a round whose hook returned nothing or failed still does. */
export function statusRoundNumber(
  events: readonly (RulebookEvent & { readonly seq: number; readonly transactionId: string })[],
  turnStartSeq: number,
  pause: boolean,
): { readonly round: number; readonly turnCommits: number } {
  // Counting starts from the latest recorded round, so a turn of several commits counted there stays one.
  const base = events.findLast(e => e.eventType === 'status.updated' && statusData(e).source.kind === 'round')
  const since = base === undefined ? 0 : base.seq,
    baseSource = base === undefined ? undefined : statusData(base).source
  const recorded = baseSource?.kind === 'round' ? baseSource.round : 0
  const player = events.filter(
    e => e.seq > since && e.eventType === 'action.resolved' && object(e.data).sourceRole === 'player',
  )
  const playerRounds = new Set(player.filter(e => e.seq <= turnStartSeq).map(e => e.transactionId))
  // This turn is one round however many commits it took, such as a line said with an action.
  const thisTurn = new Set(player.filter(e => e.seq > turnStartSeq).map(e => e.transactionId))
  // A quick activity action starts and executes in two host commits for one player request.
  const starts = new Map<string, (typeof events)[number]>()
  for (const event of events) {
    if (event.seq <= since || event.eventType !== 'activity.updated') continue
    const data = object(event.data)
    if (typeof data.requestId !== 'string') continue
    if (data.operation === 'start') starts.set(data.requestId, event)
    else {
      const start = starts.get(data.requestId + ':start')
      if (start && object(object(start.data).state).id === object(data.state).id) {
        playerRounds.delete(start.transactionId)
        thisTurn.delete(start.transactionId)
      }
    }
  }
  return {
    round: recorded + playerRounds.size + (pause ? 1 : Math.min(thisTurn.size, 1)),
    turnCommits: thisTurn.size,
  }
}
