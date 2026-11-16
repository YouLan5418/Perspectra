import type { CharacterId } from './ids.ts'
import type { WorldJsonObject, WorldJsonValue } from './world-json.ts'

export interface CommunicationDefinition {
  readonly medium: string
  readonly contacts: Readonly<Record<string, readonly string[]>>
}

/** Structural registration boundary; the core additionally checks the actual world's character IDs. */
export function parseCommunicationDefinition(value: unknown): CommunicationDefinition {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError('COMMUNICATION_DEFINITION_INVALID')
  const row = value as Record<string, unknown>
  if (
    Object.keys(row).some(key => !['medium', 'contacts'].includes(key)) ||
    typeof row.medium !== 'string' ||
    !row.medium.trim() ||
    row.medium.length > 40 ||
    !row.contacts ||
    typeof row.contacts !== 'object' ||
    Array.isArray(row.contacts)
  )
    throw new TypeError('COMMUNICATION_DEFINITION_INVALID')
  const contacts: Record<string, readonly string[]> = {}
  for (const [actor, recipients] of Object.entries(row.contacts)) {
    if (
      !actor ||
      !Array.isArray(recipients) ||
      recipients.some(id => typeof id !== 'string' || !id || id === actor) ||
      new Set(recipients).size !== recipients.length
    )
      throw new TypeError('COMMUNICATION_CONTACTS_INVALID')
    Object.defineProperty(contacts, actor, {
      value: [...recipients],
      enumerable: true,
      configurable: true,
      writable: true,
    })
  }
  return { medium: row.medium, contacts }
}
/** everyPlayerTurns on a trigger counts that condition alone; without it the role's own interval applies. */
export type AutonomyTrigger =
  | { actionType: 'speak' | 'move' | 'interact'; definitionId?: string; everyPlayerTurns?: number }
  | { activityKey: string; operation: string; everyPlayerTurns?: number }
export interface AutonomousRole {
  characterId: CharacterId
  triggers: AutonomyTrigger[]
  everyPlayerTurns: number
  opportunities: number
  interactions: string[]
  locationIds: string[]
  targetIds?: string[]
}
export const ACTIVITY_MANAGEMENT_OPERATIONS: ReadonlySet<string> = new Set([
  'start',
  'retry',
  'suspend',
  'resume',
  'abandon',
])
export const MESSAGE_DEFINITION_ID = 'experiment:message'
export function isMessageAction(value: WorldJsonValue | undefined): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as WorldJsonObject
  const definition = record.definitionRef
  return (
    record.bindingId === MESSAGE_DEFINITION_ID ||
    !!(
      definition &&
      typeof definition === 'object' &&
      !Array.isArray(definition) &&
      (definition as WorldJsonObject).id === MESSAGE_DEFINITION_ID
    )
  )
}
export function isMechanismOperation(id: string): boolean {
  return id === MESSAGE_DEFINITION_ID || /^(activity|status):[a-z][a-z0-9-]*$/u.test(id)
}
export function activityOperationId(operation: string): string {
  return 'activity:' + operation
}
export function statusOperationId(operation: string): string {
  return 'status:' + operation
}
export function messageParameters(recipientId: string, text: string): WorldJsonObject {
  return {
    targetRef: { kind: 'character', id: recipientId },
    bindingId: MESSAGE_DEFINITION_ID,
    definitionRef: { id: MESSAGE_DEFINITION_ID, version: 1 },
    arguments: { text },
  }
}
