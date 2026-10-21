// JSON Schema conditionals use a data property named `then`, not a Promise method.
/* oxlint-disable unicorn/no-thenable */
import type { WorldJsonObject } from '@harness-world/contracts'
import { characterTurnCall } from '@harness-world/provider-chat'
import type { CharacterTurnRequest } from '@harness-world/application'

/** Local OpenAI/Anthropic gateways can treat a root oneOf as only its first choice. Host validation stays strict. */
export function gatewayTurnCall(request: CharacterTurnRequest) {
  const prepared = characterTurnCall(request)
  const beforeSchema = (prepared.schema.oneOf as WorldJsonObject[])
    .map(branch => (branch.properties as WorldJsonObject).before)
    .find(value => value !== undefined)
  const maximum = Number(request.context.publicationCharacters ?? 2000)
  const expression = request.context.expressionPolicy as WorldJsonObject | undefined
  const speechAllowed = expression?.speech !== 'none'
  const narrationAllowed = expression?.narration !== false
  const canPerform = request.canPerform ?? !request.continuation
  const affordances = Array.isArray(request.context.affordances)
    ? (request.context.affordances as WorldJsonObject[])
    : []
  const move = canPerform ? affordances.find(entry => entry.actionType === 'move') : undefined
  const interact = canPerform ? affordances.find(entry => entry.actionType === 'interact') : undefined
  const destinations = Array.isArray(move?.destinations) ? (move.destinations as WorldJsonObject[]) : []
  const choices = Array.isArray(interact?.interactions) ? (interact.interactions as WorldJsonObject[]) : []
  const actionTypes = [...(move === undefined ? [] : ['move']), ...(choices.length === 0 ? [] : ['interact'])]
  const people = (request.context.scene as WorldJsonObject | undefined)?.people
  const actorId = (request.context.character as WorldJsonObject | undefined)?.characterId
  const addressees = Array.isArray(people)
    ? people.flatMap(person => {
        const id = (person as WorldJsonObject).characterId
        return typeof id === 'string' && id !== actorId ? [id] : []
      })
    : []
  const interactionIds = choices.map(choice => choice.targetRef as WorldJsonObject)
  const definitions = choices.map(choice => choice.definitionRef as WorldJsonObject)
  const versions = [
    ...new Set(definitions.map(ref => ref.version).filter((version): version is number => typeof version === 'number')),
  ]
  const parameterProperties: WorldJsonObject = {
    ...(move === undefined
      ? {}
      : {
          locationId: {
            type: 'string',
            ...(destinations.length === 0
              ? {}
              : {
                  enum: destinations
                    .map(place => place.locationId)
                    .filter((id): id is string => typeof id === 'string'),
                }),
            description: 'move 时填写目的地 locationId，不要填写 destinationId。',
          },
        }),
    ...(choices.length === 0
      ? {}
      : {
          targetRef: {
            type: 'object',
            additionalProperties: false,
            required: ['kind', 'id'],
            properties: {
              kind: {
                type: 'string',
                enum: [
                  ...new Set(interactionIds.map(ref => ref.kind).filter((id): id is string => typeof id === 'string')),
                ],
              },
              id: {
                type: 'string',
                enum: [
                  ...new Set(interactionIds.map(ref => ref.id).filter((id): id is string => typeof id === 'string')),
                ],
              },
            },
          },
          bindingId: {
            type: 'string',
            enum: [
              ...new Set(choices.map(choice => choice.bindingId).filter((id): id is string => typeof id === 'string')),
            ],
          },
          definitionRef: {
            type: 'object',
            additionalProperties: false,
            required: ['id', 'version'],
            properties: {
              id: {
                type: 'string',
                enum: [...new Set(definitions.map(ref => ref.id).filter((id): id is string => typeof id === 'string'))],
              },
              // Equal bounds avoid this gateway returning a singleton numeric enum as a string.
              // Host validation remains strict: no coercion or widening of accepted versions.
              version:
                versions.length === 1
                  ? { type: 'integer', minimum: versions[0]!, maximum: versions[0]! }
                  : { type: 'integer', enum: versions },
            },
          },
          arguments: choices.every(c => c.argumentSchema !== undefined)
            ? {
                type: 'object',
                additionalProperties: false,
                required: (
                  ((choices[0]!.argumentSchema as WorldJsonObject).required as string[] | undefined) ?? []
                ).filter(field =>
                  choices.every(
                    c =>
                      Array.isArray((c.argumentSchema as WorldJsonObject).required) &&
                      ((c.argumentSchema as WorldJsonObject).required as string[]).includes(field),
                  ),
                ),
                properties: Object.assign({}, ...choices.map(c => (c.argumentSchema as WorldJsonObject).properties)),
              }
            : { type: 'object' },
        }),
  }
  return {
    ...prepared,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['decision'],
      allOf: [
        {
          if: { properties: { decision: { const: 'publish' } } },
          then: {
            required: ['segments'],
            allOf:
              (prepared.schema.oneOf as WorldJsonObject[]).find(
                branch =>
                  (branch.properties as WorldJsonObject).decision &&
                  ((branch.properties as WorldJsonObject).decision as WorldJsonObject).const === 'publish',
              )?.allOf ?? [],
          },
        },
        { if: { properties: { decision: { const: 'recall' } } }, then: { required: ['query'] } },
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
          enum: [
            'abstain',
            ...(speechAllowed || narrationAllowed ? ['publish'] : []),
            ...(request.canRecall === true ? ['recall'] : []),
            ...(actionTypes.length > 0 ? ['perform'] : []),
          ],
          description: 'publish 需要有序 segments；recall 需要 query；perform 需要 actionType 和 parameters。',
        },
        ...(speechAllowed || narrationAllowed
          ? {
              scope: {
                type: 'string',
                enum: addressees.length ? ['scene_public', 'direct', 'private', 'self'] : ['scene_public', 'self'],
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
                  },
                },
              },
            }
          : {}),
        ...(addressees.length === 0
          ? {}
          : { addresseeIds: { type: 'array', uniqueItems: true, items: { type: 'string', enum: addressees } } }),
        ...(request.canRecall === true ? { query: { type: 'string', minLength: 2, maxLength: 120 } } : {}),
        ...(actionTypes.length === 0
          ? {}
          : {
              actionType: { type: 'string', enum: actionTypes },
              parameters: {
                type: 'object',
                additionalProperties: false,
                properties: parameterProperties,
                description:
                  'move 只填 locationId；interact 复制 context.affordances 中同一个选项的 targetRef、bindingId、definitionRef 和 arguments。',
              },
            }),
      },
    },
  }
}
