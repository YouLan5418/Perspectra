import Ajv from 'ajv'
import { expect, it } from 'vitest'
import { localPrototypeTurnCall } from '../experiments/local-prototype-turn-call.ts'

it('compiles a local tool schema when interactions share targets and bindings', () => {
  const interactions = ['take', 'inspect'].map(action => ({
    targetRef: { kind: 'entity', id: 'entity:brass-key' },
    bindingId: `binding:key-${action}`,
    definitionRef: { id: `base:${action}`, version: 1 },
    arguments: {},
  }))
  // One binding can expose multiple argument choices for the same target.
  interactions.push({ ...interactions[0]!, arguments: { variant: 'other' } })
  const call = localPrototypeTurnCall({ continuation: false, canPerform: true, context: {
    character: { characterId: 'character:companion' },
    scene: { people: [] },
    affordances: [{ actionType: 'interact', interactions }],
  } })
  const validate = new Ajv({ strict: false }).compile(call.schema)
  for (const parameters of interactions) {
    expect(validate({ decision: 'perform', actionType: 'interact', parameters })).toBe(true)
  }
  expect(validate({ decision: 'perform', actionType: 'interact', parameters: {
    ...interactions[0]!, targetRef: { kind: 'entity', id: 'entity:unknown' },
  } })).toBe(false)
})
