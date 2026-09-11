import { describe, expect, it } from 'vitest'
import { resolutionAuthority, validateResolutionAuthority } from './resolution-authority.ts'

describe('resolution authority', () => {
  it.each([
    ['player', 'standard'],
    ['player', 'manual_player_immediate'],
    ['agent', 'standard'],
    ['director', 'standard'],
  ] as const)('accepts %s + %s', (sourceRole, adjudicationMode) => {
    expect(validateResolutionAuthority(resolutionAuthority(sourceRole, adjudicationMode))).toEqual({
      version: 'resolution-authority/v1', sourceRole, adjudicationMode,
    })
  })

  it.each(['agent', 'director'] as const)('rejects forged immediate authority from %s', sourceRole => {
    expect(() => resolutionAuthority(sourceRole, 'manual_player_immediate')).toThrow('requires player')
  })

  it('rejects unknown authority fields and values at the typed boundary', () => {
    for (const value of [
      { version: 'v2', sourceRole: 'player', adjudicationMode: 'standard' },
      { version: 'resolution-authority/v1', sourceRole: 'system', adjudicationMode: 'standard' },
      { version: 'resolution-authority/v1', sourceRole: 'player', adjudicationMode: 'privileged' },
      { version: 'resolution-authority/v1', sourceRole: 'player', adjudicationMode: 'standard', forged: true },
    ]) expect(() => validateResolutionAuthority(value as never)).toThrow('invalid')
  })
})
