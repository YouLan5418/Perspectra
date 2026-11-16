import { expect, it } from 'vitest'
import type { ActivityState } from '@perspectra/sdk/contracts'
import { createCardActivity, validateCardActivities } from './activity.ts'
import { auctionRule } from './rules/auction.ts'
const rules = new Map([['cards-auction', auctionRule]])
function state(): ActivityState {
  const hooks = createCardActivity(auctionRule, { npcIds: ['b', 'c'], names: {}, npcMode: 'model', seed: 7 }, 'unit')
  return {
    id: 'activity:test',
    revision: 1,
    participants: ['a', 'b', 'c'],
    game: hooks.initialize({ playerId: 'a', npcIds: ['b', 'c'] }, () => 0) as ActivityState['game'],
  }
}
it('accepts actual Host lifecycle wrappers and refuses mismatched table/Activity turn, round or phase on restore', () => {
  const original = state()
  const check = (s: ActivityState) => validateCardActivities({ 'cards-auction': s }, rules)
  expect(() => check(original)).not.toThrow()
  expect(() =>
    check({ ...original, suspendedTurn: 'a', game: { ...original.game, active: false, turn: null } }),
  ).not.toThrow()
  expect(() =>
    check({ ...original, game: { ...original.game, active: false, turn: null, phase: 'host-aborted' } }),
  ).not.toThrow()
  expect(() => check({ ...original, game: { ...original.game, turn: 'b' } })).toThrow('CARD_LIFECYCLE_MISMATCH')
  expect(() => check({ ...original, game: { ...original.game, round: 2 } })).toThrow('CARD_LIFECYCLE_MISMATCH')
  expect(() =>
    check({ ...original, suspendedTurn: 'b', game: { ...original.game, active: false, turn: null } }),
  ).toThrow('CARD_LIFECYCLE_MISMATCH')
})
it('refuses tampered persisted player projections before a restored table can serve them', () => {
  const corrupt = state()
  corrupt.game.public = { ...corrupt.game.public, leaked: 'not-derived-from-table' }
  expect(() => validateCardActivities({ 'cards-auction': corrupt }, rules)).toThrow('CARD_PROJECTION_MISMATCH')
})
