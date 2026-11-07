import {
  brandId,
  ACTIVITY_MANAGEMENT_OPERATIONS,
  isMechanismOperation,
  type AutonomousRole,
  type AutonomyTrigger as Trigger,
} from '@harness-world/contracts'
import type { WorldJsonObject } from '@harness-world/contracts'
import type { AutonomyInstance, AutonomySource, SeamProvider } from '@harness-world/plugin-sdk'
export const autonomyInstruction =
  '现在是你自主处理自身目标的机会。依据自己的目标、经历和眼前情况决定是否行动；可以表达或 abstain。没有新消息不代表发生了你不知道的事；但 context.statusChanges 里的变化已经发生，例如时间已经推进，请按现在的时段与处境行动，不要接着已经过去的对话收尾。'
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
const management = ACTIVITY_MANAGEMENT_OPERATIONS
const interval = (trigger: WorldJsonObject) =>
  trigger.everyPlayerTurns === undefined ? {} : { everyPlayerTurns: integer(trigger.everyPlayerTurns) }

/** Declarative package asset; no script, new manifest version or durable scheduling queue. */
export class AutonomyPolicy implements AutonomyInstance {
  readonly instruction = autonomyInstruction
  constructor(readonly roles: readonly AutonomousRole[]) {}
  static parse(value: unknown, source: AutonomySource, playerId: string): AutonomyPolicy {
    const root = object(value)
    exact(root, ['characters'])
    if (!Array.isArray(root.characters) || root.characters.length > 8) throw new TypeError('自主角色最多 8 个')
    const characters = new Set(source.characterIds)
    const locations = new Set(source.locationIds)
    const targets = new Set(source.targetIds)
    const definitions = new Set(source.definitionIds)
    // Activity and author status operations are named by their own scripts, not by the interaction catalog.
    const knownDefinition = (id: string) => definitions.has(id) || isMechanismOperation(id)
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
          exact(trigger, ['activityKey', 'operation'], ['everyPlayerTurns'])
          if (
            typeof trigger.activityKey !== 'string' ||
            !/^[a-z][a-z0-9-]{0,40}$/u.test(trigger.activityKey) ||
            typeof trigger.operation !== 'string' ||
            !/^[a-z][a-z0-9-]*$/u.test(trigger.operation) ||
            management.has(trigger.operation)
          )
            throw new TypeError('自主触发需要实际活动操作')
          return { activityKey: trigger.activityKey, operation: trigger.operation, ...interval(trigger) }
        }
        exact(trigger, ['actionType'], ['definitionId', 'everyPlayerTurns'])
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
          ...interval(trigger),
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
    return new AutonomyPolicy(roles)
  }

  due({ actions, afterSeq }: Parameters<AutonomyInstance['due']>[0]): readonly string[] {
    return this.roles
      .filter(role => {
        // Triggers with their own interval are counted alone; the rest and the player's pause share the role's.
        const groups = new Map<number, Map<string, number>>()
        const count = (group: number, action: (typeof actions)[number]) => {
          const matched = groups.get(group) ?? new Map<string, number>()
          matched.set(action.transactionId, Math.max(matched.get(action.transactionId) ?? 0, action.seq))
          groups.set(group, matched)
        }
        for (const action of actions) {
          if (action.pause) count(-1, action)
          role.triggers.forEach((trigger, index) => {
            const matches =
              'activityKey' in trigger
                ? trigger.activityKey === action.activityKey && trigger.operation === action.operation
                : trigger.actionType === action.actionType &&
                  (trigger.definitionId === undefined || trigger.definitionId === action.definitionId)
            if (matches) count(trigger.everyPlayerTurns === undefined ? -1 : index, action)
          })
        }
        return [...groups].some(([group, matched]) => {
          const every = group === -1 ? role.everyPlayerTurns : role.triggers[group]!.everyPlayerTurns!
          return [...matched.values()].some((seq, index) => seq > afterSeq && (index + 1) % every === 0)
        })
      })
      .map(role => role.characterId)
  }
  permits(input: Parameters<AutonomyInstance['permits']>[0]): boolean {
    const role = this.roles.find(role => role.characterId === input.characterId)
    if (!role) return false
    if (input.actionType === 'speak') return true
    if (!role.locationIds.includes(input.locationId ?? '')) return false
    if (input.actionType === 'move') return role.locationIds.includes(String(input.parameters.locationId))
    const definition = input.parameters.definitionRef as WorldJsonObject | undefined,
      target = input.parameters.targetRef as WorldJsonObject | undefined
    return (
      input.actionType === 'interact' &&
      role.interactions.includes(String(definition?.id)) &&
      (role.targetIds === undefined || role.targetIds.includes(String(target?.id)))
    )
  }
}
export const officialAutonomyProvider: SeamProvider<AutonomyInstance> = {
  id: 'official-autonomy',
  version: '1.0.0',
  open: async world =>
    world.autonomySource
      ? AutonomyPolicy.parse(world.autonomySource.config, world.autonomySource, world.cast.playerId)
      : new AutonomyPolicy([]),
}
