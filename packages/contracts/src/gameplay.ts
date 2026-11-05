import type { CharacterId } from './ids.ts'
import type { WorldJsonObject, WorldJsonValue } from './world-json.ts'

export interface CommunicationDefinition {
  readonly medium: string
  readonly contacts: Readonly<Record<string, readonly string[]>>
}
export type AutonomyTrigger =
  | { actionType: 'speak' | 'move' | 'interact'; definitionId?: string }
  | { activityKey: string; operation: string }
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
