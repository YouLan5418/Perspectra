import {
  ACTIVITY_MANAGEMENT_OPERATIONS,
  isMechanismOperation,
  type AutonomousRole,
  type WorldJsonObject,
} from '@harness-world/contracts'

/** Mechanisms declare policies; registered NPC identities and finite world/action bounds stay mandatory. */
export function validateAutonomyRoles(
  roles: readonly AutonomousRole[],
  catalog: {
    readonly characterIds: readonly string[]
    readonly locationIds: readonly string[]
    readonly targetIds: readonly string[]
    readonly definitionIds: readonly string[]
  },
  playerId: string,
): readonly AutonomousRole[] {
  if (!Array.isArray(roles) || roles.length > 8 || new Set(roles.map(role => role.characterId)).size !== roles.length)
    throw new TypeError('自主角色声明无效')
  const strings = (value: unknown): value is string[] =>
    Array.isArray(value) &&
    value.every(item => typeof item === 'string' && item.trim()) &&
    new Set(value).size === value.length
  for (const role of roles as readonly AutonomousRole[]) {
    const known = (id: string) => catalog.definitionIds.includes(id) || isMechanismOperation(id)
    const trigger = (value: unknown): boolean => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return false
      const row = value as Record<string, unknown>
      if ('activityKey' in row)
        return (
          typeof row.activityKey === 'string' &&
          /^[a-z][a-z0-9-]{0,40}$/u.test(row.activityKey) &&
          typeof row.operation === 'string' &&
          /^[a-z][a-z0-9-]*$/u.test(row.operation) &&
          !ACTIVITY_MANAGEMENT_OPERATIONS.has(row.operation)
        )
      return (
        ['speak', 'move', 'interact'].includes(String(row.actionType)) &&
        (row.definitionId === undefined ||
          (row.actionType === 'interact' && typeof row.definitionId === 'string' && known(row.definitionId)))
      )
    }
    if (
      !Array.isArray(role.triggers) ||
      role.triggers.length < 1 ||
      role.triggers.length > 32 ||
      !role.triggers.every(trigger) ||
      !strings(role.interactions) ||
      role.interactions.some(id => !known(id))
    )
      throw new TypeError('自主机制返回了无效触发或操作声明')
    if (
      !catalog.characterIds.includes(role.characterId) ||
      role.characterId === playerId ||
      !Number.isSafeInteger(role.everyPlayerTurns) ||
      role.everyPlayerTurns < 1 ||
      role.everyPlayerTurns > 100 ||
      !Number.isSafeInteger(role.opportunities) ||
      role.opportunities < 1 ||
      role.opportunities > 100 ||
      !Array.isArray(role.triggers) ||
      !strings(role.interactions) ||
      !strings(role.locationIds) ||
      !role.locationIds.length ||
      role.locationIds.some(id => !catalog.locationIds.includes(id)) ||
      (role.targetIds !== undefined &&
        (!strings(role.targetIds) || role.targetIds.some(id => !catalog.targetIds.includes(id))))
    )
      throw new TypeError('自主机制返回了未授权角色、地点、目标或无效机会')
  }
  return structuredClone(roles)
}
/** Upper bound for autonomous effects, checked before and after the ordinary world rulebook. */
export function autonomousActionAllowed(
  role: AutonomousRole,
  locationId: string | null,
  actionType: string,
  parameters: WorldJsonObject,
): boolean {
  if (actionType === 'speak') return true
  if (!role.locationIds.includes(locationId ?? '')) return false
  if (actionType === 'move') return role.locationIds.includes(String(parameters.locationId))
  const definition = parameters.definitionRef as WorldJsonObject | undefined,
    target = parameters.targetRef as WorldJsonObject | undefined
  return (
    actionType === 'interact' &&
    role.interactions.includes(String(definition?.id)) &&
    (role.targetIds === undefined || role.targetIds.includes(String(target?.id)))
  )
}
