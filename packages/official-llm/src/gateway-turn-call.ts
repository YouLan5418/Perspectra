// JSON Schema conditionals use a data property named `then`, not a Promise method.
/* oxlint-disable unicorn/no-thenable */
import type { WorldJsonObject, WorldJsonValue } from '@harness-world/contracts'
import { characterTurnCall } from '@harness-world/provider-chat'

/** Equal bounds avoid this gateway returning a single numeric const or enum as a string. Host validation stays strict. */
function equalBounds(value: WorldJsonValue): WorldJsonValue {
  if (Array.isArray(value)) return value.map(equalBounds)
  if (value === null || typeof value !== 'object') return value
  const { const: constant, enum: choices, ...fields } = value as WorldJsonObject
  const only = Array.isArray(choices) && choices.length === 1 ? choices[0] : constant
  if (typeof only === 'number') return { ...fields, minimum: only, maximum: only }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, equalBounds(item as WorldJsonValue)]))
}

/**
 * During an activity (a vote, a round of a game) the arguments carry a revision that changes every step, so the
 * tool cannot be stable anyway; there the author's argument schema still guides the model.
 */
function activityArguments(context: WorldJsonObject): WorldJsonObject | undefined {
  if (context.activity === undefined) return undefined
  const affordances = Array.isArray(context.affordances) ? (context.affordances as WorldJsonObject[]) : []
  const choices = (affordances.find(entry => entry.actionType === 'interact')?.interactions ?? []) as WorldJsonObject[]
  if (!Array.isArray(choices) || choices.length === 0 || choices.some(c => c.argumentSchema === undefined))
    return undefined
  const schemas = choices.map(choice => choice.argumentSchema as WorldJsonObject)
  return {
    type: 'object',
    additionalProperties: false,
    required: ((schemas[0]!.required as string[] | undefined) ?? []).filter(field =>
      schemas.every(schema => Array.isArray(schema.required) && (schema.required as string[]).includes(field)),
    ),
    properties: equalBounds(Object.assign({}, ...schemas.map(schema => schema.properties))),
  }
}

/**
 * Local OpenAI/Anthropic gateways can treat a root oneOf as only its first choice. Host validation stays strict.
 *
 * The tool comes before every message, so it must not change between steps or rounds, or the provider cannot reuse
 * the cached contract and history behind it. It therefore lists the same fields whatever the character may do now:
 * where she can go, what she can use and whom she can address are in context.affordances and context.scene, the step's
 * limits are in turnInstructions, and the host and rulebook reject anything outside them.
 */
export function gatewayTurnCall(request: Parameters<typeof characterTurnCall>[0]) {
  const prepared = characterTurnCall(request)
  const maximum = Number(request.context.publicationCharacters ?? 2000)
  const expression = request.context.expressionPolicy as WorldJsonObject | undefined
  const speechAllowed = expression?.speech !== 'none'
  const narrationAllowed = expression?.narration !== false
  const expressible = speechAllowed || narrationAllowed
  const publish = (prepared.schema.oneOf as WorldJsonObject[]).find(
    branch => ((branch.properties as WorldJsonObject).decision as WorldJsonObject | undefined)?.const === 'publish',
  )
  // Offered whenever the host allows it at all, not only on steps that may still perform: the host refuses a
  // `before` without perform, and turnInstructions says when this step cannot perform.
  const beforeSchema =
    publish !== undefined && request.canExpressBeforeAction === true
      ? (() => {
          const { decision: _decision, ...properties } = publish.properties as WorldJsonObject
          return { ...publish, required: ['segments'], properties }
        })()
      : undefined
  return {
    ...prepared,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['decision'],
      allOf: [
        {
          if: { properties: { decision: { const: 'publish' } } },
          then: { required: ['segments'], allOf: publish?.allOf ?? [] },
        },
        {
          if: { properties: { decision: { const: 'perform' } } },
          then: {
            required: ['actionType', 'parameters'],
            allOf: [
              {
                if: { properties: { actionType: { const: 'move' } } },
                then: { properties: { parameters: { required: ['locationId'] } } },
              },
              {
                if: { properties: { actionType: { const: 'interact' } } },
                then: {
                  properties: { parameters: { required: ['targetRef', 'bindingId', 'definitionRef', 'arguments'] } },
                },
              },
            ],
          },
        },
        ...(beforeSchema === undefined
          ? []
          : [{ if: { required: ['before'] }, then: { properties: { decision: { const: 'perform' } } } }]),
      ],
      properties: {
        ...(beforeSchema === undefined ? {} : { before: beforeSchema }),
        decision: {
          type: 'string',
          enum: ['abstain', ...(expressible ? ['publish'] : []), 'perform'],
          description: 'publish 需要有序 segments；perform 需要 actionType 和 parameters。',
        },
        ...(expressible
          ? {
              scope: {
                type: 'string',
                enum: ['scene_public', 'direct', 'private', 'self'],
                description: 'publish 的受众。direct/private 需非空 addresseeIds；scene_public/self 不指定接收者。',
              },
              segments: {
                type: 'array',
                minItems: 1,
                maxItems: maximum,
                description: `按发生顺序交替或重复 speech/narration；文本合计最多 ${maximum} 字符。固定对白选项一次最多一个 speech 片段。`,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['type', 'text'],
                  properties: {
                    type: {
                      type: 'string',
                      enum: [...(speechAllowed ? ['speech'] : []), ...(narrationAllowed ? ['narration'] : [])],
                    },
                    text: { type: 'string', minLength: 1, maxLength: maximum },
                    ...(Array.isArray(request.context.expressions) && request.context.expressions.length
                      ? { expression: { type: 'string', enum: request.context.expressions } }
                      : {}),
                  },
                },
              },
              addresseeIds: {
                type: 'array',
                uniqueItems: true,
                items: { type: 'string' },
                description: '只填 context.scene.people 中除你以外的角色 characterId。',
              },
            }
          : {}),
        actionType: { type: 'string', enum: ['move', 'interact'] },
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            locationId: {
              type: 'string',
              description:
                'move 时填写 context.affordances 中 move 选项列出的目的地 locationId，不要填写 destinationId。',
            },
            targetRef: {
              type: 'object',
              additionalProperties: false,
              required: ['kind', 'id'],
              properties: { kind: { type: 'string' }, id: { type: 'string' } },
            },
            bindingId: { type: 'string' },
            definitionRef: {
              type: 'object',
              additionalProperties: false,
              required: ['id', 'version'],
              properties: { id: { type: 'string' }, version: { type: 'integer' } },
            },
            arguments: activityArguments(request.context) ?? {
              type: 'object',
              description: '按该选项的 argumentSchema 填写；没有参数时为 {}。',
            },
          },
          description:
            'move 只填 locationId；interact 复制 context.affordances 中同一个选项的 targetRef、bindingId、definitionRef 和 arguments。',
        },
      },
    },
  }
}
