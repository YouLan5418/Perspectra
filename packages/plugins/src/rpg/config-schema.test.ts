import Ajv from 'ajv'
import { expect, it } from 'vitest'
import schema from './config-schema.json' with { type: 'json' }
import { parseRpgConfig } from './config.ts'
import { referenceJson, referencePack } from './fixtures/reference.ts'
import { addRpgMvExample } from '../../../../tests/support/rpg-mv-fixture.ts'

const validate = new Ajv({ strict: true }).compile(schema)
it('accepts the same new author example in Schema and runtime', () => {
  const raw = referenceJson()
  addRpgMvExample(raw)
  expect(validate(raw), JSON.stringify(validate.errors)).toBe(true)
  expect(() => parseRpgConfig(raw, referencePack)).not.toThrow()
})
it('rejects healing elements, HP cost, old fields and out-of-bound states in both validators', () => {
  for (const edit of [
    (raw: Record<string, any>) => {
      raw.skills[0].effects = [{ kind: 'heal', amount: 3, element: 'fire' }]
    },
    (raw: Record<string, any>) => {
      raw.combatStatuses.burn.tick = { kind: 'heal', amount: 3, element: 'fire' }
    },
    (raw: Record<string, any>) => {
      raw.skills[0].cost = { hp: 1 }
    },
    (raw: Record<string, any>) => {
      raw.skills[0].power = 8
    },
    (raw: Record<string, any>) => {
      raw.combatStatuses.burn.turns = 100
    },
    (raw: Record<string, any>) => {
      raw.combatStatuses.fracture.modifiers.defense = -1001
    },
  ]) {
    const raw = referenceJson()
    addRpgMvExample(raw)
    edit(raw)
    expect(validate(raw)).toBe(false)
    expect(() => parseRpgConfig(raw, referencePack)).toThrow()
  }
})
