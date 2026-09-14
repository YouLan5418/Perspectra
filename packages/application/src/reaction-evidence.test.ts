import { describe, expect, it } from 'vitest'
import { brandId, type CharacterId } from '@harness-world/contracts'
import type { RulebookResolution } from '@harness-world/kernel'
import {
  recordsReactionEvidence,
  reactionEvidence,
  reactionRoleClass,
  speechAddressees,
  strongestClass,
} from './reaction-evidence.ts'

const actor = 'character:actor'
const observer: CharacterId = brandId('character:observer', 'CharacterId')

describe('reaction evidence', () => {
  it('classifies an observer from who acted, what landed on them, and who was named', () => {
    const base = { actorId: actor, observerId: observer, affectedCharacterIds: undefined, addresseeIds: [] }
    // The actor is self before anything else is asked, so an action never appends a call to its own doer.
    expect(reactionRoleClass({ ...base, observerId: actor as CharacterId })).toBe('self')
    // Nothing landed on anyone and nobody was named, so an onlooker is only a witness.
    expect(reactionRoleClass(base)).toBe('witness')
    // The effect landing on someone outranks being named, which is what keeps an onlooker of a failed
    // attempt - a rejection reports no affected character - from being read as direct.
    expect(reactionRoleClass({ ...base, affectedCharacterIds: [observer], addresseeIds: [] })).toBe('direct')
    expect(reactionRoleClass({ ...base, addresseeIds: [observer] })).toBe('addressee')
  })

  it('records evidence only for the profile that says so, including the disabled world', () => {
    expect(recordsReactionEvidence({ version: 'reaction-policy/v1', mode: 'disabled' })).toBe(false)
    expect(recordsReactionEvidence({ version: 'reaction-policy/v1', mode: 'responsive', profile: 'responsive/v1' })).toBe(false)
    expect(recordsReactionEvidence({ version: 'reaction-policy/v1', mode: 'responsive', profile: 'responsive/v2' })).toBe(true)
  })

  it('reads addressees from the speech the action produced, and nobody from anything else', () => {
    const speech = { events: [{ eventType: 'character.speak', eventVersion: 1, data: { addresseeIds: [observer] } }] }
    expect(speechAddressees(speech as unknown as RulebookResolution)).toEqual([observer])
    expect(speechAddressees({ events: [] } as unknown as RulebookResolution)).toEqual([])
    // A speech that named nobody, and any other event shape, both name nobody.
    expect(speechAddressees({ events: [{ eventType: 'character.speak', eventVersion: 1, data: {} }] } as unknown as RulebookResolution))
      .toEqual([])
  })

  it('names the definition that adjudicated the action, or the action itself when none did', () => {
    const common = { actionId: 'action:1', actionType: 'interact', actionVersion: 2, actorId: actor, observerId: observer,
      roleClass: 'witness' as const, sourceEventOrdinal: 3, observationId: 'observation:1' }
    const defined = reactionEvidence({ ...common, resolution: {
      definitionRef: { id: 'base:give', version: 1 },
    } as unknown as RulebookResolution })
    expect(defined).toEqual({ version: 'reaction-evidence/v1', sourceEventOrdinal: 3, observationId: 'observation:1',
      observerCharacterId: observer, actionId: 'action:1',
      entry: { kind: 'definition', definitionRef: { id: 'base:give', version: 1 } }, roleClass: 'witness' })
    const bare = reactionEvidence({ ...common, resolution: {} as unknown as RulebookResolution })
    expect(bare.entry).toEqual({ kind: 'action', actionType: 'interact', actionVersion: 2 })
  })

  it('reports the strongest class a candidate holds, which is what the planner weighs it by', () => {
    expect(strongestClass([{ roleClass: 'witness' }, { roleClass: 'direct' }])).toBe('direct')
    expect(strongestClass([{ roleClass: 'self' }, { roleClass: 'addressee' }])).toBe('addressee')
    expect(strongestClass([{ roleClass: 'self' }])).toBe('self')
  })
})
