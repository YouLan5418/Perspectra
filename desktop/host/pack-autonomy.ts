import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'
import {
  brandId,
  type CharacterId,
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
import type { WorldStore } from '@harness-world/store-sqlite'
import type { CompiledWorldPackV5 } from '@harness-world/world-pack'

type Trigger =
  | { actionType: 'speak' | 'move' | 'interact'; definitionId?: string }
  | { activityKey: string; operation: string }
export interface AutonomousRole {
  characterId: CharacterId
  triggers: Trigger[]
  everyPlayerTurns: number
  opportunities: number
  interactions: string[]
  locationIds: string[]
  targetIds?: string[]
}
function object(value: unknown): WorldJsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('自主配置需要对象')
  return value as WorldJsonObject
}
function exact(value: WorldJsonObject, required: string[], optional: string[] = []): void {
  if (
    required.some(key => !Object.hasOwn(value, key)) ||
    Object.keys(value).some(key => ![...required, ...optional].includes(key))
  )
    throw new TypeError('自主配置字段无效')
}
function strings(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.some(v => typeof v !== 'string' || !v.trim()) ||
    new Set(value).size !== value.length
  )
    throw new TypeError('自主配置需要不重复的字符串列表')
  return value as string[]
}
function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 100)
    throw new TypeError('自主频率和机会必须为 1–100 的整数')
  return value
}
const management = new Set(['start', 'retry', 'suspend', 'resume', 'abandon'])

/** Declarative package asset; no script, new manifest version or durable scheduling queue. */
export class PackAutonomy {
  private constructor(readonly roles: readonly AutonomousRole[]) {}
  static parse(value: unknown, pack: CompiledWorldPackV5, playerId: string): PackAutonomy {
    const root = object(value)
    exact(root, ['characters'])
    if (!Array.isArray(root.characters) || root.characters.length > 8) throw new TypeError('自主角色最多 8 个')
    const characters = new Set(pack.content.characters.map(c => c.characterId as string))
    const locations = new Set(pack.content.locations.map(l => l.locationId))
    const targets = new Set([...characters, ...pack.content.entities.map(e => e.entityId as string)])
    const definitions = new Set(pack.interactions.definitions.map(d => d.ref.id))
    // Activity and author status operations are named by their own scripts, not by the interaction catalog.
    const knownDefinition = (id: string) => definitions.has(id) || /^(activity|status):[a-z][a-z0-9-]*$/u.test(id)
    const roles = root.characters.map(entry => {
      const row = object(entry)
      exact(
        row,
        ['characterId', 'triggers', 'everyPlayerTurns', 'opportunities', 'interactions', 'locationIds'],
        ['targetIds'],
      )
      if (typeof row.characterId !== 'string' || row.characterId === playerId || !characters.has(row.characterId))
        throw new TypeError('自主角色必须是已声明 NPC')
      if (!Array.isArray(row.triggers) || !row.triggers.length || row.triggers.length > 32)
        throw new TypeError('自主触发列表无效')
      const triggers: Trigger[] = row.triggers.map(value => {
        const trigger = object(value)
        if (Object.hasOwn(trigger, 'activityKey')) {
          exact(trigger, ['activityKey', 'operation'])
          if (
            typeof trigger.activityKey !== 'string' ||
            !/^[a-z][a-z0-9-]{0,40}$/u.test(trigger.activityKey) ||
            typeof trigger.operation !== 'string' ||
            !/^[a-z][a-z0-9-]*$/u.test(trigger.operation) ||
            management.has(trigger.operation)
          )
            throw new TypeError('自主触发需要实际活动操作')
          return { activityKey: trigger.activityKey, operation: trigger.operation }
        }
        exact(trigger, ['actionType'], ['definitionId'])
        if (
          !['speak', 'move', 'interact'].includes(String(trigger.actionType)) ||
          (trigger.definitionId !== undefined &&
            (trigger.actionType !== 'interact' ||
              typeof trigger.definitionId !== 'string' ||
              !knownDefinition(trigger.definitionId)))
        )
          throw new TypeError('自主触发交互无效')
        return {
          actionType: trigger.actionType as 'speak' | 'move' | 'interact',
          ...(trigger.definitionId === undefined ? {} : { definitionId: String(trigger.definitionId) }),
        }
      })
      const interactions = strings(row.interactions),
        locationIds = strings(row.locationIds)
      if (
        interactions.some(id => !knownDefinition(id)) ||
        !locationIds.length ||
        locationIds.some(id => !locations.has(id))
      )
        throw new TypeError('自主交互或地点未声明')
      const targetIds = row.targetIds === undefined ? undefined : strings(row.targetIds)
      if (targetIds?.some(id => !targets.has(id))) throw new TypeError('自主目标未声明')
      return {
        characterId: brandId(row.characterId, 'CharacterId'),
        triggers,
        everyPlayerTurns: integer(row.everyPlayerTurns),
        opportunities: integer(row.opportunities),
        interactions,
        locationIds,
        ...(targetIds === undefined ? {} : { targetIds }),
      }
    })
    if (new Set(roles.map(r => r.characterId)).size !== roles.length) throw new TypeError('自主角色重复')
    return new PackAutonomy(roles)
  }
  static load(packPath: string, pack: CompiledWorldPackV5, playerId: string): PackAutonomy | undefined {
    const entry = 'autonomy.json',
      lock = pack.assets.find(a => a.path === entry)
    if (!lock) return undefined
    const filename = resolve(packPath, entry)
    if (
      !lstatSync(filename).isFile() ||
      relative(realpathSync(packPath), realpathSync(filename)) !== entry.split('/').join(sep)
    )
      throw new TypeError('自主配置必须是包内普通文件')
    const bytes = readFileSync(filename)
    if (
      bytes.length > 65536 ||
      bytes.length !== lock.size ||
      'sha256:' + createHash('sha256').update(bytes).digest('hex') !== lock.contentHash
    )
      throw new TypeError('自主配置与编译包不一致')
    return PackAutonomy.parse(JSON.parse(bytes.toString('utf8')), pack, playerId)
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
    const actions = events.filter(
      e =>
        e.eventType === 'action.resolved' &&
        object(e.data).sourceRole === 'player' &&
        object(e.data).actorId === playerId &&
        object(e.data).accepted === true,
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
      const request = object(record.request)
      if (record.action === undefined && typeof request.operation === 'string')
        return { definitionRef: { id: 'status:' + request.operation } }
      return record.action === undefined ? {} : object(object(record.action).parameters)
    }
    return this.roles.filter(role => {
      const matched = new Map<string, number>()
      for (const event of actions) {
        if (managementTransactions.has(event.transactionId)) continue
        const data = object(event.data),
          update = activity.get(String(data.actionId))
        const operation = update?.operation
        if (typeof operation === 'string' && management.has(operation)) continue
        const matches = role.triggers.some(trigger => {
          if ('activityKey' in trigger)
            return (
              update !== undefined &&
              (update.activityKey ?? 'default') === trigger.activityKey &&
              operation === trigger.operation
            )
          if (trigger.actionType !== data.actionType) return false
          if (trigger.definitionId === undefined) return true
          if (update && typeof operation === 'string') return trigger.definitionId === 'activity:' + operation
          return (parameters(event).definitionRef as WorldJsonObject | undefined)?.id === trigger.definitionId
        })
        if (matches) matched.set(event.transactionId, Math.max(matched.get(event.transactionId) ?? 0, event.seq))
      }
      return (
        [...matched.values()].some((seq, index) => seq > afterSeq && (index + 1) % role.everyPlayerTurns === 0) &&
        currentCharacterLifecycle(events, role.characterId) === 'active' &&
        role.locationIds.includes(currentLocation(events, role.characterId) ?? '')
      )
    })
  }
  /** A role-specific resolver for autonomous activations only; the base still adjudicates every effect. */
  rulebooks(base: RulebookResolver): RulebookRegistry {
    const forRole = (actor: string) => this.roles.find(r => r.characterId === actor)
    const allowedInteraction = (role: AutonomousRole, option: WorldJsonObject) => {
      const definition = option.definitionRef as WorldJsonObject | undefined
      const target = option.targetRef as WorldJsonObject | undefined
      return (
        role.interactions.includes(String(definition?.id)) &&
        (role.targetIds === undefined || role.targetIds.includes(String(target?.id)))
      )
    }
    const resolver: RulebookResolver = {
      affordances: context => {
        const role = forRole(context.characterId)
        if (!role) throw new TypeError('未声明自主角色')
        const inRange = role.locationIds.includes(currentLocation(context.events, context.characterId) ?? '')
        return base.affordances(context).flatMap((action): ActionAffordance[] => {
          if (action.actionType === 'speak') return [action]
          if (!inRange) return []
          if (action.actionType === 'move') {
            const destinations = (action.destinations ?? []).filter(d => role.locationIds.includes(d.locationId))
            return destinations.length ? [{ ...action, destinations }] : []
          }
          if (action.actionType === 'interact') {
            const interactions = (action.interactions ?? []).filter(option => allowedInteraction(role, option))
            return interactions.length ? [{ ...action, interactions }] : []
          }
          return []
        })
      },
      resolve: context => {
        const role = forRole(context.characterId),
          action = context.action
        if (!role) throw new TypeError('未声明自主角色')
        if (action.actionType !== 'speak') {
          const inRange = role.locationIds.includes(currentLocation(context.events, context.characterId) ?? '')
          const parameters = object(action.parameters)
          const allowed =
            inRange &&
            (action.actionType === 'move'
              ? role.locationIds.includes(String(parameters.locationId))
              : action.actionType === 'interact' && allowedInteraction(role, parameters))
          if (!allowed) return { status: 'rejected', reason: '本次自主处理不允许此交互、目标或地点', events: [] }
        }
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
