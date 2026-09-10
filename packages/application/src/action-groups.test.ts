import { describe, expect, it, vi } from 'vitest'
import { brandId, type ActionGroupBinding } from '@harness-world/contracts'
import { resolveGroupAction, sortActionGroups, stepManifestation } from './action-groups.ts'

const group: ActionGroupBinding = { version: 'bounded-action-group/v1', manifestations: [null, null] }
const action = { actionId: 'a', actorId: brandId('a', 'CharacterId'), actionType: 'move', actionVersion: 1, parameters: {} }

describe('bounded action groups', () => {
  it('keeps groups contiguous and proposal order independent from action id', () => {
    const a = { participantId: 'a', actionId: 'z', proposalOrdinal: 0, actionGroup: group }
    const b = { ...a, actionId: 'a', proposalOrdinal: 1 }
    const c = { ...a, participantId: 'b', actionId: 'm' }
    const legacy = { participantId: 'legacy', actionId: 'n', proposalOrdinal: 0 }
    const compare = (a: { actionId: string }, b: { actionId: string }) => a.actionId.localeCompare(b.actionId)
    expect(sortActionGroups([b, legacy, c, a], compare)).toEqual([c, legacy, a, b])
    expect(sortActionGroups([c, a], () => 0)).toEqual([a, c])
  })
  it('retains accepted prefixes and does not invoke rules for skipped steps', () => {
    const stopped = new Set<string>()
    const reject = vi.fn(() => ({ status: 'rejected' as const, events: [] }))
    const accept = vi.fn(() => ({ status: 'accepted' as const, events: [] }))
    expect(resolveGroupAction(action, 'a', true, stopped, accept).skipped).toBe(false)
    expect(resolveGroupAction(action, 'a', true, stopped, reject).skipped).toBe(false)
    expect(resolveGroupAction(action, 'a', true, stopped, accept).skipped).toBe(true)
    expect(accept).toHaveBeenCalledTimes(1)
    expect(resolveGroupAction(action, 'a', false, stopped, accept).skipped).toBe(false)
    expect(resolveGroupAction(action, 'b', true, stopped, accept).skipped).toBe(false)
  })
  it('only renders success-dependent cues after success', () => {
    expect(stepManifestation(null, true)).toBeUndefined()
    expect(stepManifestation({ independent: [], onSuccess: ['slow_walk'] }, false)).toBeUndefined()
    expect(stepManifestation({ independent: ['frown'], onSuccess: ['slow_walk'] }, false)?.cues).toHaveLength(1)
    expect(stepManifestation({ independent: ['frown'], onSuccess: ['slow_walk'] }, true)?.cues).toHaveLength(2)
  })
})
