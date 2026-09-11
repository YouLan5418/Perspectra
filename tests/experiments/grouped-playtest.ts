import { SubmitActionsValidator } from '@harness-world/agents'
import {
  createStepManifestationSchema,
  type CharacterId,
  type SubmitActionsV4,
  type SubmitActionsV5,
  type WorldJsonObject,
} from '@harness-world/contracts'
import { byteHash, type ExperimentActionReference, type ExperimentMessage } from './compact-context.ts'

export function groupedPlaytestRequest(input: readonly ExperimentMessage[], actorId: CharacterId, version: 4 | 5, reaction: boolean, references: readonly ExperimentActionReference[]) {
  const action = (type: 'speak' | 'move' | 'take' | 'interact', parameters: object) => ({ type: 'object', additionalProperties: false,
    required: ['actionId', 'actorId', 'actionType', 'actionVersion', 'parameters'],
    properties: { actionId: { type: 'string', minLength: 1 }, actorId: { type: 'string', const: actorId },
      actionType: { type: 'string', const: type }, actionVersion: { type: 'integer', const: 1 }, parameters, manifestation: createStepManifestationSchema(type) } })
  const schema = { type: 'object', additionalProperties: false, required: ['schemaVersion', 'decision', 'actions'], properties: {
    schemaVersion: { type: 'integer', const: version }, decision: { type: 'string', enum: ['act', 'abstain'] },
    actions: { type: 'array', maxItems: 2, items: { oneOf: [
      action('speak', { type: 'object', additionalProperties: false, required: ['text'], properties: { text: { type: 'string', minLength: 1, maxLength: 1000 } } }),
      action('move', { type: 'object', additionalProperties: false, required: ['locationId'], properties: { locationId: { type: 'string', enum: references.filter(value => value.kind === 'location').map(value => value.source) } } }),
      version === 5 ? action('interact', { type: 'object', additionalProperties: false, required: ['targetId', 'interactionId', 'arguments'], properties: {
        targetId: { type: 'string' }, interactionId: { type: 'string' }, arguments: { type: 'object', additionalProperties: false, properties: { recipientId: { type: 'string' } } },
      } }) : action('take', { type: 'object', additionalProperties: false, required: ['entityId'], properties: { entityId: { type: 'string' } } }),
    ] } },
    ...(!reaction ? { reflection: { type: 'object', additionalProperties: false, required: ['operations'], properties: { operations: { type: 'array', maxItems: 4, items: { type: 'object' } } } } } : {}),
  } }
  const contract = `只扮演 ${actorId}，只返回符合此 JSON Schema 的对象，不输出思维过程：${JSON.stringify(schema)}。每个 actionId 在本次输出内唯一，使用完整 ID，不使用 L1/E1/R1 等短引用。最多一次 speak 加一次 move/${version === 5 ? 'interact' : 'take'}，按数组顺序执行；前步失败会跳过后步。可只提交一步或 abstain+空数组，不能重复无新意义的对白。组内不能获取新知识，不替其他角色决定反应。没有表现时省略 manifestation；填写时 independent 与 onSuccess 合计至少一码且不得重复。表现仅用闭合码，声音只能放在 speak.onSuccess，slow_walk 只能放在 move.onSuccess。${version === 5 ? 'interact 参数从 affordances.interactions 选择；give 只转移持有关系，不表示对方同意。' : ''}Reflection 如不确定完整正式操作格式应省略，不能使用旧短引用格式。公开地点：${JSON.stringify(references.filter(value => value.kind === 'location').map(value => ({ locationId: value.source, name: value.label })))}`
  const messages = input.map(message => ({ role: message.role === 'developer' ? 'system' as const : message.role, content: message.content }))
  messages.splice(2, 0, { role: 'system', content: contract })
  return { schema, renderer: 'grouped-playtest/v2', mode: 'full', messages, references: [], actionReferences: references,
    sourceMessagesHash: byteHash(JSON.stringify(input)), renderedMessagesHash: byteHash(JSON.stringify(messages)) }
}

export function groupedPlaytestProposal(value: unknown, actorId: CharacterId, participantId: string, version: 4 | 5, reaction: boolean): SubmitActionsV4 | SubmitActionsV5 {
  const validator = new SubmitActionsValidator()
  const authorization = { actorId, participantId, allowedActionTypes: ['speak', 'move', version === 5 ? 'interact' : 'take'], maxActions: 2, maxReflectionOperations: reaction ? 0 : 4, correlationId: 'grouped-playtest' }
  if (version === 5) validator.validateV5(value, authorization)
  else validator.validateV4(value, authorization)
  return value as SubmitActionsV4 | SubmitActionsV5
}

/** An explicit player command for the grouped protocols. `actionType` stays a literal union so it
 * remains assignable to the shared {@link UtilityIntentResult} action shape. */
export interface GroupedPlayerCommand {
  readonly actionType: 'speak' | 'interact'
  readonly parameters: WorldJsonObject
}

/** Explicit player commands avoid routing v8 actions through the legacy take translator. */
export function groupedPlayerCommand(text: string, version: 4 | 5): GroupedPlayerCommand | undefined {
  if (text.startsWith('/say ')) return { actionType: 'speak', parameters: { text: text.slice(5) } }
  if (version !== 5) return undefined
  const parts = text.trim().split(/\s+/u)
  if (parts[0] === '/take') throw new TypeError('v8 请使用 /interact <物品ID> <交互ID> [收件角色ID]')
  if (parts[0] !== '/interact') return undefined
  if (parts.length !== 3 && parts.length !== 4) throw new TypeError('/interact <物品ID> <交互ID> [收件角色ID]')
  return {
    actionType: 'interact',
    parameters: {
      targetId: parts[1]!, interactionId: parts[2]!,
      arguments: parts.length === 4 ? { recipientId: parts[3]! } : {},
    },
  }
}
