import {
  ACTIVITY_MANAGEMENT_OPERATIONS,
  activityOperationId,
  statusOperationId,
  type AutonomousRole,
  type WorldAddress,
  type StoredWorldEvent,
  type WorldJsonObject,
} from '@harness-world/contracts'
import {
  currentCharacterLifecycle,
  currentLocation,
  RulebookRegistry,
  type ActionAffordance,
  type RulebookResolver,
} from '@harness-world/kernel'
import { autonomousActionAllowed, validateAutonomyRoles } from '@harness-world/application'
import type { WorldStore } from '@harness-world/store-sqlite'
import type { AutonomyAction, AutonomyInstance, AutonomySource } from '@harness-world/plugin-sdk'
const management = ACTIVITY_MANAGEMENT_OPERATIONS
function object(value: unknown): WorldJsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('自主配置需要对象')
  return value as WorldJsonObject
}
/** Extract committed action metadata; the selected policy decides frequency, never writes facts. */
export class AutonomyRuntime {
  readonly roles: readonly AutonomousRole[]
  constructor(
    readonly mechanism: AutonomyInstance,
    source: AutonomySource,
    playerId: string,
  ) {
    this.roles = validateAutonomyRoles(mechanism.roles, source, playerId)
  }
  get instruction() {
    return this.mechanism.instruction
  }
  /** Count each matching player transaction once; agent ticks, failed actions and management do not count.
   * Deriving from the committed prefix gives nodes/replays the same frequency without extra storage. */
  due(
    store: WorldStore,
    address: WorldAddress,
    playerId: string,
    afterSeq: number,
    beforeSeq: number,
  ): AutonomousRole[] {
    const events = store.readEvents(address, beforeSeq)
    // A round the player let pass is their turn too, whatever the role's triggers: it is how they yield time.
    const pause = (e: StoredWorldEvent) =>
      e.eventType === 'status.updated' &&
      object(object(e.data).source).kind === 'round' &&
      object(object(e.data).source).pause === true
    const actions = events.filter(
      e =>
        pause(e) ||
        (e.eventType === 'action.resolved' &&
          object(e.data).sourceRole === 'player' &&
          object(e.data).actorId === playerId &&
          object(e.data).accepted === true),
    )
    const activity = new Map(
      events
        .filter(e => e.eventType === 'activity.updated')
        .map(e => [String(object(e.data).actionId), object(e.data)]),
    )
    const managementTransactions = new Set(
      events
        .filter(e => e.eventType === 'activity.updated' && management.has(String(object(e.data).operation)))
        .map(e => e.transactionId),
    )
    const authority = new Map<string, WorldJsonObject>()
    const parameters = (event: StoredWorldEvent): WorldJsonObject => {
      let record = authority.get(event.transactionId)
      if (!record) {
        record = store.readRoundAuthority(address, event.transactionId)?.authority
        if (!record) throw new Error('自主计数缺少已提交行动记录')
        authority.set(event.transactionId, record)
      }
      if (Array.isArray(record.actions)) {
        const action = record.actions.map(object).find(a => a.actionId === object(event.data).actionId)
        if (!action) throw new Error('自主计数找不到玩家行动')
        return object(action.parameters)
      }
      // A player's status operation records its operation name, the definition being status:<operation>.
      // A player's SMS records only its action, with no request.
      const request = record.request === undefined ? {} : object(record.request)
      if (record.action === undefined && typeof request.operation === 'string')
        return { definitionRef: { id: statusOperationId(request.operation) } }
      return record.action === undefined ? {} : object(object(record.action).parameters)
    }
    const records: AutonomyAction[] = actions.flatMap<AutonomyAction>(event => {
      if (pause(event)) return [{ transactionId: event.transactionId, seq: event.seq, pause: true }]
      if (managementTransactions.has(event.transactionId)) return []
      const data = object(event.data),
        update = activity.get(String(data.actionId)),
        operation = update?.operation
      if (typeof operation === 'string' && management.has(operation)) return []
      const needsDefinition = this.roles.some(role =>
        role.triggers.some(
          trigger =>
            'definitionId' in trigger && trigger.definitionId !== undefined && trigger.actionType === data.actionType,
        ),
      )
      const definitionId =
        update && typeof operation === 'string'
          ? activityOperationId(operation)
          : needsDefinition
            ? (parameters(event).definitionRef as WorldJsonObject | undefined)?.id
            : undefined
      return [
        {
          transactionId: event.transactionId,
          seq: event.seq,
          pause: false,
          actionType: String(data.actionType),
          ...(typeof definitionId === 'string' ? { definitionId } : {}),
          ...(update ? { activityKey: String(update.activityKey ?? 'default') } : {}),
          ...(typeof operation === 'string' ? { operation } : {}),
        },
      ]
    })
    const selected = this.mechanism.due({ actions: records, afterSeq })
    if (
      !Array.isArray(selected) ||
      new Set(selected).size !== selected.length ||
      selected.some(id => !this.roles.some(role => role.characterId === id))
    )
      throw new TypeError('自主机制选择了未声明角色')
    return this.roles.filter(
      role =>
        selected.includes(role.characterId) &&
        currentCharacterLifecycle(events, role.characterId) === 'active' &&
        role.locationIds.includes(currentLocation(events, role.characterId) ?? ''),
    )
  }
  /** A role-specific resolver for autonomous activations only; the base still adjudicates every effect. */
  rulebooks(base: RulebookResolver): RulebookRegistry {
    const forRole = (actor: string) => this.roles.find(r => r.characterId === actor)
    const allowed = (
      role: AutonomousRole,
      events: Parameters<RulebookResolver['resolve']>[0]['events'],
      actionType: string,
      parameters: WorldJsonObject,
    ) => {
      const locationId = currentLocation(events, role.characterId) ?? null
      return (
        autonomousActionAllowed(role, locationId, actionType, parameters) &&
        this.mechanism.permits({ characterId: role.characterId, locationId, actionType, parameters })
      )
    }
    const resolver: RulebookResolver = {
      affordances: context => {
        const role = forRole(context.characterId)
        if (!role) throw new TypeError('未声明自主角色')
        const inRange = role.locationIds.includes(currentLocation(context.events, context.characterId) ?? '')
        return base.affordances(context).flatMap((action): ActionAffordance[] => {
          if (action.actionType === 'speak') return allowed(role, context.events, 'speak', {}) ? [action] : []
          if (!inRange) return []
          if (action.actionType === 'move') {
            const destinations = (action.destinations ?? []).filter(d =>
              allowed(role, context.events, 'move', { locationId: d.locationId }),
            )
            return destinations.length ? [{ ...action, destinations }] : []
          }
          if (action.actionType === 'interact') {
            const interactions = (action.interactions ?? []).filter(option =>
              allowed(role, context.events, 'interact', option),
            )
            return interactions.length ? [{ ...action, interactions }] : []
          }
          return []
        })
      },
      resolve: context => {
        const role = forRole(context.characterId),
          action = context.action
        if (!role) throw new TypeError('未声明自主角色')
        if (
          !allowed(
            role,
            context.events,
            action.actionType,
            action.actionType === 'speak' ? {} : object(action.parameters),
          )
        )
          return { status: 'rejected', reason: '本次自主处理不允许此交互、目标或地点', events: [] }
        const result = base.resolve(context)
        if (result.status === 'accepted' && action.actionType !== 'speak') {
          const outside = result.events.some(
            event =>
              event.eventType === 'character.moved' &&
              object(event.data).characterId === role.characterId &&
              !role.locationIds.includes(String(object(event.data).toLocationId)),
          )
          const targetOutside =
            role.targetIds !== undefined &&
            Object.values(result.resolvedRoles ?? {}).some(
              target =>
                target.id !== role.characterId &&
                ['character', 'entity', 'relation'].includes(target.kind) &&
                !role.targetIds!.includes(target.id),
            )
          if (outside || targetOutside)
            return { status: 'rejected', reason: '本次自主交互的结果超出允许范围', events: [] }
        }
        return result
      },
    }
    const registry = new RulebookRegistry()
    registry.register('builtin:speak-move', 2, resolver)
    return registry
  }
}
