import type { InteractionCharacterView, InteractionParameterSchema } from './interaction-definition.ts'
import type { WorldJsonObject, WorldJsonValue } from './world-json.ts'

/**
 * Model-facing schemas for an interaction request, derived from the same frozen structures the Host
 * validates against. There is no second source of truth: a definition's argument schema is one
 * object that both the Host validator and these builders read.
 *
 * Direction of the guarantee: a request the Host accepts is always schema-valid. The reverse does
 * not hold for free strings, because the Host bounds them in UTF-8 bytes while JSON Schema counts
 * code points; `maxLength` is therefore the byte bound, which is the safe side. Enumerated values
 * are exact in both directions.
 */
function fieldSchema(field: InteractionParameterSchema['fields'][number]): WorldJsonObject {
  if (field.type === 'boolean') return { type: 'boolean' }
  if (field.type === 'integer') return { type: 'integer', minimum: field.minimum, maximum: field.maximum }
  return field.values.length === 0
    ? { type: 'string', maxLength: field.maxBytes }
    : { type: 'string', enum: [...field.values] }
}

/** Schema for one definition's `arguments`, bounded by types, ranges and declared enums only. */
export function createInteractionArgumentSchema(schema: InteractionParameterSchema): WorldJsonObject {
  return {
    type: 'object',
    additionalProperties: false,
    required: schema.fields.map(field => field.name),
    properties: Object.fromEntries(schema.fields.map(field => [field.name, fieldSchema(field)])),
  }
}

const targetSchema = (kind: string, id: string): WorldJsonObject => ({
  type: 'object', additionalProperties: false, required: ['kind', 'id'],
  properties: { kind: { const: kind }, id: { const: id } },
})

function argumentsSchema(arguments_: WorldJsonObject): WorldJsonObject {
  const names = Object.keys(arguments_).sort()
  return {
    type: 'object',
    additionalProperties: false,
    required: names,
    properties: Object.fromEntries(names.map(name => [name, { const: arguments_[name] as WorldJsonValue }])),
  }
}

/**
 * Schema for one character's interaction request. Every offered option becomes one exact branch, so
 * a target, a binding, a definition and an argument set can only appear as the triple the view
 * offered. That is what makes a cartesian product of independent field enums schema-invalid rather
 * than merely discouraged.
 *
 * A view with no options yields a schema that accepts nothing, which is the honest translation of
 * "this character has nothing to attempt".
 */
export function createInteractionRequestSchema(view: InteractionCharacterView): WorldJsonObject {
  if (view.options.length === 0) return { not: {} }
  // Each branch is self-contained: giving the union a top-level `properties` as well would only
  // invite the two levels to disagree about what an option looks like.
  return {
    anyOf: view.options.map(option => ({
      type: 'object',
      additionalProperties: false,
      required: ['targetRef', 'bindingId', 'definitionRef', 'arguments'],
      properties: {
        targetRef: targetSchema(option.targetRef.kind, option.targetRef.id),
        bindingId: { const: option.bindingId },
        definitionRef: {
          type: 'object', additionalProperties: false, required: ['id', 'version'],
          properties: { id: { const: option.definitionRef.id }, version: { const: option.definitionRef.version } },
        },
        arguments: argumentsSchema(option.arguments),
      },
    })),
  }
}
