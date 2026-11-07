import { characterTurnCall } from '@harness-world/provider-chat'
import Ajv from 'ajv'
import { expect, it } from 'vitest'
import { gatewayTurnCall } from '../../packages/official-llm/src/gateway-turn-call.ts'

const REVISION = 5
const request = {
  continuation: false,
  context: {
    publicationCharacters: 2000,
    character: { characterId: 'character:wolf' },
    // Arguments keep the author's schema only during an activity, whose revision changes every step anyway.
    activity: { activityId: 'activity:game' },
    affordances: [
      {
        actionType: 'interact',
        actionVersion: 2,
        interactions: [
          {
            label: '投票',
            targetRef: { kind: 'character', id: 'character:wolf' },
            bindingId: 'activity:game',
            definitionRef: { id: 'activity:vote', version: 1 },
            arguments: { activityId: 'activity:game', revision: REVISION },
            argumentSchema: {
              type: 'object',
              additionalProperties: false,
              required: ['activityId', 'revision', 'target'],
              properties: {
                activityId: { const: 'activity:game', type: 'string' },
                revision: { const: REVISION, type: 'integer' },
                target: { type: 'string', enum: ['Claude', 'GPT'] },
                round: { type: 'integer', enum: [2] },
                seat: { type: 'integer', enum: [1, 2] },
              },
            },
          },
        ],
      },
    ],
  },
} as never

const argumentsOf = (schema: unknown) =>
  (schema as { properties: { parameters: { properties: { arguments: { properties: Record<string, object> } } } } })
    .properties.parameters.properties.arguments.properties

it('sends single numeric arguments as equal bounds, because the gateway returns those constants as strings', () => {
  const sent = argumentsOf(gatewayTurnCall(request).schema)
  expect(sent.revision).toEqual({ type: 'integer', minimum: REVISION, maximum: REVISION })
  expect(sent.round).toEqual({ type: 'integer', minimum: 2, maximum: 2 })
})

it('leaves every other argument as the author wrote it', () => {
  const sent = argumentsOf(gatewayTurnCall(request).schema)
  expect(sent.activityId).toEqual({ const: 'activity:game', type: 'string' })
  expect(sent.target).toEqual({ type: 'string', enum: ['Claude', 'GPT'] })
  expect(sent.seat).toEqual({ type: 'integer', enum: [1, 2] })
})

it('does not loosen what the host accepts', () => {
  const validate = new Ajv({ strict: false }).compile(characterTurnCall(request).schema)
  const decision = (revision: unknown) => ({
    decision: 'perform',
    actionType: 'interact',
    parameters: {
      targetRef: { kind: 'character', id: 'character:wolf' },
      bindingId: 'activity:game',
      definitionRef: { id: 'activity:vote', version: 1 },
      arguments: { activityId: 'activity:game', revision, target: 'GPT', round: 2, seat: 1 },
    },
  })
  expect(validate(decision(REVISION))).toBe(true)
  expect(validate(decision(String(REVISION)))).toBe(false)
  expect(validate(decision(REVISION + 1))).toBe(false)
})
