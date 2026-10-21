import Ajv from 'ajv'
import type { ChatCall } from '@harness-world/provider-chat'
import type { WorldJsonObject, WorldJsonValue } from '@harness-world/contracts'
import { InvalidCharacterOutputError } from '@harness-world/application'

/** Shared schema-only retry; ordinary turns reserve its call, activities retain their existing handling.
 * Execution and permissions are still validated by the turn. */
export async function decideWithFormatRetry(
  call: ChatCall,
  decide: (call: ChatCall) => Promise<WorldJsonValue>,
  signal: AbortSignal,
  schema: WorldJsonObject = call.schema,
  reserveRetry?: () => boolean,
): Promise<WorldJsonValue> {
  const validate = new Ajv({ strict: false, allErrors: true }).compile(schema)
  signal.throwIfAborted()
  const first = await decide(call)
  signal.throwIfAborted()
  if (validate(first)) return first
  if (reserveRetry !== undefined && !reserveRetry())
    throw new InvalidCharacterOutputError('角色输出格式无效，剩余预算不足以修正；本次未执行操作。')
  // No invalid dialogue is published or appended to the visible context. Only field diagnostics are returned.
  const issues = (validate.errors ?? []).map(e => ({
    path: e.instancePath,
    keyword: e.keyword,
    ...(e.keyword === 'additionalProperties' ? { field: e.params.additionalProperty } : {}),
    ...(e.keyword === 'type' ? { expectedType: e.params.type } : {}),
  }))
  const chosen = first !== null && typeof first === 'object' && !Array.isArray(first) ? (first as WorldJsonObject) : {}
  const branches = Array.isArray(schema.oneOf) ? (schema.oneOf as WorldJsonObject[]) : []
  const selected = branches.filter(branch => {
    const properties = branch.properties as WorldJsonObject | undefined
    return (
      (properties?.decision as WorldJsonObject | undefined)?.const === chosen.decision &&
      (chosen.decision !== 'perform' ||
        (properties?.actionType as WorldJsonObject | undefined)?.const === chosen.actionType)
    )
  })
  // The local gateway flattens root unions. On correction expose only the model's chosen legal branch,
  // never delete fields from its payload or grant a new action. The result still gets full validation.
  let retrySchema = selected.length === 1 ? selected[0]! : call.schema
  if (selected.length === 1 && chosen.decision === 'perform') {
    const properties = retrySchema.properties as WorldJsonObject
    const parameters = properties.parameters as WorldJsonObject
    const choices = Array.isArray(parameters.oneOf) ? (parameters.oneOf as WorldJsonObject[]) : []
    const proposed = chosen.parameters as WorldJsonObject | undefined
    const matches = choices.filter(choice => {
      const fields = choice.properties as WorldJsonObject
      const target = fields.targetRef as WorldJsonObject,
        definition = fields.definitionRef as WorldJsonObject
      return (
        (fields.bindingId as WorldJsonObject).const === proposed?.bindingId &&
        ((target.properties as WorldJsonObject).id as WorldJsonObject).const ===
          (proposed?.targetRef as WorldJsonObject | undefined)?.id &&
        ((definition.properties as WorldJsonObject).id as WorldJsonObject).const ===
          (proposed?.definitionRef as WorldJsonObject | undefined)?.id
      )
    })
    if (matches.length === 1) retrySchema = { ...retrySchema, properties: { ...properties, parameters: matches[0]! } }
  }
  // Some local gateways stringify numeric const values. Equal numeric bounds express the same
  // constraint without converting any model output; the original schema remains the validator.
  const numericBounds = (value: WorldJsonValue): WorldJsonValue => {
    if (Array.isArray(value)) return value.map(numericBounds)
    if (value === null || typeof value !== 'object') return value
    const result = Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, numericBounds(item)]),
    ) as WorldJsonObject
    if (typeof result.const === 'number') {
      const { const: fixed, ...fields } = result
      return { ...fields, minimum: fixed, maximum: fixed }
    }
    return result
  }
  const revised: ChatCall = {
    ...call,
    schema: numericBounds(retrySchema) as WorldJsonObject,
    messages: [
      ...call.messages,
      {
        role: 'system',
        content:
          (validate.errors?.some(
            issue =>
              (issue.instancePath.includes('/addresseeIds') && issue.keyword === 'enum') ||
              (issue.keyword === 'additionalProperties' && issue.params.additionalProperty === 'addresseeIds'),
          )
            ? '指定收件人不在当前可交流范围，上一次表达没有发表，也没有传达给对方。只能使用当前场景列出的收件人。\n'
            : '') +
          '上一次返回不符合本次工具 JSON schema。请重新选择一个合法分支；perform 只含 decision、actionType、parameters；对白属于 publish。' +
          'integer/number 字段必须返回 JSON 数值，不能用带引号的字符串代替；尤其 definitionRef.version 和 arguments.revision。' +
          '不改变上下文、可用操作或剩余预算，不预先声称执行成功。格式错误：' +
          JSON.stringify(issues),
      },
    ],
  }
  const second = await decide(revised)
  signal.throwIfAborted()
  if (!validate(second)) throw new InvalidCharacterOutputError('角色输出格式修正后仍无效；本次未执行操作。')
  return second
}
