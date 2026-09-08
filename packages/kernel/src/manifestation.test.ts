import { describe, expect, it } from 'vitest'
import { brandId, type ManifestationProposal } from '@harness-world/contracts'
import { resolveManifestation } from './manifestation.ts'

const actorId = brandId('character:claude', 'CharacterId')
const roundId = brandId('round:1', 'InteractionRoundId')
const base = { roundId, actionId: 'action:1', actorId, events: [] }

describe('resolveManifestation', () => {
  it('commits outward occurrence and persistent state events independently of Action status', () => {
    const manifestation: ManifestationProposal = {
      description: 'Claude皱起眉，双臂抱在胸前。',
      cues: [
        { cueId: 'cue:face', channel: 'facial', description: '皱眉', persistence: 'event_only' },
        { cueId: 'cue:posture', channel: 'posture', description: '双臂抱胸', persistence: 'until_changed', stateKey: 'posture:arms-crossed', operation: 'set' },
      ],
    }
    expect(resolveManifestation({ ...base, manifestation })).toEqual({
      status: 'accepted',
      cueResolutions: [
        { cueId: 'cue:face', status: 'accepted', reason: 'accepted' },
        { cueId: 'cue:posture', status: 'accepted', reason: 'accepted' },
      ],
      events: [
        {
          eventType: 'character.manifested', eventVersion: 1,
          data: { roundId, actionId: 'action:1', characterId: actorId, description: manifestation.description, cues: manifestation.cues },
        },
        {
          eventType: 'character.visible-state-upserted', eventVersion: 1,
          data: {
            characterId: actorId, stateKey: 'posture:arms-crossed',
            value: { channel: 'posture', description: '双臂抱胸', sourceActionId: 'action:1' },
          },
        },
      ],
    })
  })

  it('partially rejects an absent clear without leaking the aggregate description', () => {
    const manifestation: ManifestationProposal = {
      description: 'Claude放下手臂，声音也低了下来。',
      cues: [
        { cueId: 'cue:clear', channel: 'posture', description: '放下手臂', persistence: 'until_changed', stateKey: 'posture:arms-crossed', operation: 'clear' },
        { cueId: 'cue:voice', channel: 'voice', description: '声音低沉', persistence: 'event_only' },
      ],
    }
    expect(resolveManifestation({ ...base, manifestation })).toEqual({
      status: 'partially_accepted',
      cueResolutions: [
        { cueId: 'cue:clear', status: 'rejected', reason: 'visible_state_absent' },
        { cueId: 'cue:voice', status: 'accepted', reason: 'accepted' },
      ],
      events: [{
        eventType: 'character.manifested', eventVersion: 1,
        data: { roundId, actionId: 'action:1', characterId: actorId, description: null, cues: [manifestation.cues[1]] },
      }],
    })
  })

  it('accepts clear only after the exact visible state exists and rejects an entirely inapplicable proposal', () => {
    const clear: ManifestationProposal = { cues: [{
      cueId: 'cue:clear', channel: 'appearance', description: '袖口恢复干燥', persistence: 'until_changed',
      stateKey: 'appearance:sleeve-wet', operation: 'clear',
    }] }
    expect(resolveManifestation({ ...base, manifestation: clear }).status).toBe('rejected')
    expect(resolveManifestation({
      ...base,
      events: [{
        eventType: 'character.visible-state-upserted',
        data: { characterId: actorId, stateKey: 'appearance:sleeve-wet', value: { channel: 'appearance', description: '袖口湿了' } },
      }],
      manifestation: clear,
    })).toMatchObject({
      status: 'accepted',
      events: [
        { eventType: 'character.manifested' },
        { eventType: 'character.visible-state-removed', data: { characterId: actorId, stateKey: 'appearance:sleeve-wet', sourceActionId: 'action:1' } },
      ],
    })
  })

  it('replays state prefixes in order and fails closed on malformed relevant state', () => {
    const manifestation: ManifestationProposal = { cues: [{
      cueId: 'cue:clear', channel: 'posture', description: '放下手臂', persistence: 'until_changed',
      stateKey: 'posture:arms-crossed', operation: 'clear',
    }] }
    expect(resolveManifestation({
      ...base,
      events: [
        { eventType: 'character.speak', data: { characterId: actorId, text: 'unrelated' } },
        { eventType: 'character.visible-state-upserted', data: { characterId: 'character:other', stateKey: 'posture:other', value: { channel: 'posture', description: 'ignored' } } },
        { eventType: 'character.visible-state-upserted', data: { characterId: actorId, stateKey: 'posture:arms-crossed', value: { channel: 'posture', description: '抱臂' } } },
        { eventType: 'character.visible-state-removed', data: { characterId: actorId, stateKey: 'posture:arms-crossed' } },
      ],
      manifestation,
    }).status).toBe('rejected')
    const malformedValues = [undefined, null, { channel: 'voice', description: 'x' }, { channel: 'posture', description: 1 }, { channel: 'posture', description: '' }]
    for (const value of malformedValues) {
      expect(() => resolveManifestation({
        ...base,
        events: [{
          eventType: 'character.visible-state-upserted',
          data: { characterId: actorId, stateKey: 'posture:bad', ...(value === undefined ? {} : { value }) },
        }],
        manifestation,
      })).toThrow('visible-state-upserted.value')
    }
    expect(() => resolveManifestation({
      ...base,
      events: [{ eventType: 'character.visible-state-removed', data: { characterId: actorId, stateKey: null } }],
      manifestation,
    })).toThrow('stateKey')
  })
})
