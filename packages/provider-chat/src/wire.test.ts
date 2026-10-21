import Ajv from 'ajv'
import { expect, it } from 'vitest'
import { chatMessages, intentCall, operationSchemas } from './wire.ts'

it('binds current perform parameters to the offered target, definition version and arguments', () => {
  const choice = {
    targetRef: { kind: 'entity', id: 'entity:cup' },
    bindingId: 'binding:give',
    definitionRef: { id: 'base:give', version: 1 },
    arguments: { recipientId: 'character:friend' },
  }
  const schema = operationSchemas([{ actionType: 'interact', interactions: [choice] }]).find(
    operation => operation.actionType === 'interact',
  )!.parameters
  const validate = new Ajv({ strict: false }).compile(schema)
  expect(validate(choice)).toBe(true)
  expect(validate({ ...choice, definitionRef: { id: 'base:give', version: 2 } })).toBe(false)
  expect(validate({ ...choice, targetRef: { kind: 'entity', id: 'entity:other' } })).toBe(false)
  expect(validate({ ...choice, arguments: { recipientId: 'character:other' } })).toBe(false)
  expect(validate({ ...choice, performance: { cue: 'smile' } })).toBe(false)
})

it('keeps each interaction choice separate and honors its argument schema', () => {
  const choices = ['a', 'b'].map(id => ({
    targetRef: { kind: 'entity', id: `entity:${id}` },
    bindingId: `binding:${id}`,
    definitionRef: { id: 'custom:choose', version: 1 },
    argumentSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['count'],
      properties: { count: { type: 'integer', minimum: 1 } },
    },
  }))
  const schema = operationSchemas([{ actionType: 'interact', interactions: choices }]).find(
    operation => operation.actionType === 'interact',
  )!.parameters
  const validate = new Ajv({ strict: false }).compile(schema)
  const { argumentSchema: _schema, ...choice } = choices[0]!
  expect(validate({ ...choice, arguments: { count: 2 } })).toBe(true)
  expect(validate({ ...choice, arguments: { count: 0 } })).toBe(false)
  expect(validate({ ...choice, bindingId: choices[1]!.bindingId, arguments: { count: 2 } })).toBe(false)
})

it('restricts offered move destinations and omits interactions when none are available', () => {
  const operations = operationSchemas([
    { actionType: 'move', destinations: [{ locationId: 'location:room', name: '前室' }] },
  ])
  expect(operations.map(operation => operation.actionType)).toEqual(['move'])
  const validate = new Ajv({ strict: false }).compile(operations[0]!.parameters)
  expect(validate({ locationId: 'location:room' })).toBe(true)
  expect(validate({ locationId: 'location:unknown' })).toBe(false)
  const openMove = new Ajv({ strict: false }).compile(operationSchemas(undefined)[0]!.parameters)
  expect(openMove({ locationId: 'location:room' })).toBe(true)
  expect(openMove({ locationId: '' })).toBe(false)
})

it('maps developer messages to system without changing other roles or message text', () => {
  const messages = [
    { role: 'developer', content: '角色契约' },
    { role: 'assistant', content: '原话' },
  ]
  expect(chatMessages(messages)).toEqual([{ role: 'system', content: '角色契约' }, messages[1]])
  expect(messages[0]!.role).toBe('developer')
})

it('passes the player interpretation schema and source text through unchanged', () => {
  const responseSchema = { type: 'object', required: ['version'] }
  const call = intentCall({
    contract: 'Interpret only the player intent.',
    sourceText: '我把杯子递给他',
    affordances: [{ affordanceId: 'give' }],
    responseSchema,
  })
  expect(call.schema).toBe(responseSchema)
  expect(call.messages[0]!.content).toContain('Interpret only the player intent.')
  expect(JSON.parse(call.messages[1]!.content)).toEqual({
    sourceText: '我把杯子递给他',
    affordances: [{ affordanceId: 'give' }],
  })
  expect(() => intentCall({})).toThrow('no response schema')
  expect(JSON.parse(intentCall({ responseSchema }).messages[1]!.content)).toEqual({ sourceText: '', affordances: [] })
})
