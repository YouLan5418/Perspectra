import { describe, expect, it } from 'vitest'
import { brandId, canonicalizeWorldJson, type WorldAddress, type WorldEventDraft } from '@harness-world/contracts'
import {
  prototypeHoldHand,
  prototypeParticipantTransition,
  prototypeReleaseHand,
  replayPrototypeHandHolds,
} from './character-relation-spike.ts'

const address: WorldAddress = {
  tenantId: brandId('tenant:spike', 'TenantId'),
  worldId: brandId('world:spike', 'WorldId'),
  branchId: brandId('branch:main', 'BranchId'),
}

function hold(events: readonly WorldEventDraft[] = [], sourceActionId = 'action:hold:1') {
  return prototypeHoldHand({
    address,
    events,
    sourceActionId,
    actorId: 'character:player',
    targetId: 'character:alice',
    interactionId: 'core:hold-hand',
    sourceRole: 'player',
    adjudicationMode: 'manual_player_immediate',
  })
}

describe('C0 character relation pure-function spike', () => {
  it('derives byte-stable relation identity from the frozen action and address', () => {
    const first = hold()
    const replay = hold()
    expect(first.status).toBe('accepted')
    expect(Buffer.from(canonicalizeWorldJson(first.events))).toEqual(Buffer.from(canonicalizeWorldJson(replay.events)))
    expect(first.events[0]!.data).toMatchObject({
      relationId: expect.stringMatching(/^relation:[0-9a-f]{24}$/u),
      relationKind: 'hand_hold',
      sourceActionId: 'action:hold:1',
    })
  })

  it('rejects non-player authority and a duplicate active pair', () => {
    expect(prototypeHoldHand({
      address,
      events: [],
      sourceActionId: 'action:forged',
      actorId: 'character:alice',
      targetId: 'character:player',
      interactionId: 'core:hold-hand',
      sourceRole: 'agent',
      adjudicationMode: 'manual_player_immediate',
    })).toMatchObject({ status: 'rejected', reason: 'HOLD_HAND_REQUIRES_MANUAL_PLAYER_IMMEDIATE' })
    const started = hold().events
    expect(hold(started, 'action:hold:2')).toMatchObject({ status: 'rejected', reason: 'HAND_HOLD_ALREADY_ACTIVE' })
  })

  it('allows either participant to release and rejects a third party even with the exact relationId', () => {
    const started = hold().events
    const relationId = (started[0]!.data as { relationId: string }).relationId
    expect(prototypeReleaseHand(started, 'character:mallory', relationId)).toMatchObject({
      status: 'rejected', reason: 'NOT_RELATION_PARTICIPANT',
    })
    const released = prototypeReleaseHand(started, 'character:alice', relationId)
    expect(released.events).toEqual([{
      eventType: 'character.relation-ended',
      eventVersion: 1,
      data: { relationId, endedByCharacterId: 'character:alice', reason: 'released' },
    }])
    expect(replayPrototypeHandHolds([...started, ...released.events])).toMatchObject([{ active: false }])
  })

  it('keeps move first and deterministically ends every active relation of the mover', () => {
    const started = hold().events
    const move: WorldEventDraft = {
      eventType: 'character.moved', eventVersion: 1,
      data: { characterId: 'character:alice', fromLocationId: 'location:a', toLocationId: 'location:b' },
    }
    const result = prototypeParticipantTransition(started, 'character:alice', move, 'participant_moved')
    expect(result.events.map(event => event.eventType)).toEqual(['character.moved', 'character.relation-ended'])
    expect(result.events[1]!.data).toMatchObject({ endedByCharacterId: 'character:alice', reason: 'participant_moved' })
  })

  it('keeps lifecycle transition first and ends the relation as unavailable', () => {
    const started = hold().events
    const unavailable: WorldEventDraft = {
      eventType: 'character.lifecycle-changed', eventVersion: 1,
      data: { characterId: 'character:player', lifecycleState: 'departed' },
    }
    const result = prototypeParticipantTransition(started, 'character:player', unavailable, 'participant_unavailable')
    expect(result.events.map(event => event.eventType)).toEqual(['character.lifecycle-changed', 'character.relation-ended'])
    expect(result.events[1]!.data).toMatchObject({ reason: 'participant_unavailable' })
  })

  it('fails closed for an unknown, duplicate, or third-party end prefix', () => {
    const started = hold().events
    const relationId = (started[0]!.data as { relationId: string }).relationId
    const validEnd = prototypeReleaseHand(started, 'character:player', relationId).events[0]!
    expect(() => replayPrototypeHandHolds([validEnd])).toThrow('no matching active relation')
    expect(() => replayPrototypeHandHolds([...started, validEnd, validEnd])).toThrow('no matching active relation')
    expect(() => replayPrototypeHandHolds([...started, {
      ...validEnd,
      data: { relationId, endedByCharacterId: 'character:mallory', reason: 'released' },
    }])).toThrow('not a participant')
  })

  it('preserves an inherited relationId and derives new fork actions from the child address', () => {
    const inherited = hold().events
    const inheritedId = (inherited[0]!.data as { relationId: string }).relationId
    expect(replayPrototypeHandHolds(inherited)[0]!.relationId).toBe(inheritedId)
    const released = prototypeReleaseHand(inherited, 'character:player', inheritedId).events
    const child = prototypeHoldHand({
      address: { ...address, branchId: brandId('branch:child', 'BranchId') },
      events: [...inherited, ...released],
      sourceActionId: 'action:hold:child',
      actorId: 'character:player',
      targetId: 'character:alice',
      interactionId: 'core:hold-hand',
      sourceRole: 'player',
      adjudicationMode: 'manual_player_immediate',
    })
    expect((child.events[0]!.data as { relationId: string }).relationId).not.toBe(inheritedId)
  })
})
