import { expect, it } from 'vitest'
import { brandId, resolutionAuthority } from '@harness-world/contracts'
import { FrozenInteractionRulebook } from '@harness-world/kernel'
import { basicInteractionPackage, frozenInteractionWorld } from '../../../tests/fixtures/frozen-interaction-world.ts'
import { bindPlayerProvisional, provisionalReactionView, verifyPlayerProvisional } from './player-provisional.ts'

it('binds exact event ordinals, rejects drift, and redacts restricted views before Recall', () => {
  const world = frozenInteractionWorld()
  const action = {
    actionId: 'action:player',
    actorId: world.manifest.playerBindings[0]!.characterId,
    actionType: 'interact',
    actionVersion: 2,
    parameters: {
      targetRef: { kind: 'character', id: 'character:npc' },
      bindingId: 'binding:character:npc:base:hold-hand',
      definitionRef: { id: 'base:hold-hand', version: 1 },
      arguments: {},
    },
  } as const
  const resolver = new FrozenInteractionRulebook([basicInteractionPackage])
  resolver.adopt(world.manifest, world.manifestHash)
  const resolution = resolver.resolve({
    manifest: world.manifest,
    events: world.genesisEvents,
    characterId: action.actorId,
    actionId: action.actionId,
    manifestHash: world.manifestHash,
    asOfWorldSeq: world.genesisEvents.length,
    resolutionAuthority: resolutionAuthority('player', 'manual_player_immediate'),
    roundId: brandId('round:provisional-test', 'InteractionRoundId'),
  }, action)
  expect(resolution.status).toBe('accepted')
  const provisional = bindPlayerProvisional(world.manifest.address, 10, world.manifestHash, action, resolution)
  expect(() => verifyPlayerProvisional(provisional, action, resolution)).not.toThrow()
  expect(() => verifyPlayerProvisional(provisional, { ...action, actionId: 'action:changed' }, resolution)).toThrow('differs')
  const corrupted = structuredClone(provisional)
  corrupted.binding.events[0]!.draftOrdinal = 4
  expect(() => verifyPlayerProvisional(corrupted, action, resolution)).toThrow('differs')
  const fullView = provisionalReactionView({ provisional, visibility: 'full' }, world.genesisEvents)
  expect(fullView).toMatchObject({ observation: { relations: [{ relationKind: 'hand_hold' }] } })
  expect(JSON.stringify(fullView)).not.toContain('relationId')
  for (const visibility of ['none', 'occurrence_only'] as const) {
    const view = provisionalReactionView({ provisional, visibility }, world.genesisEvents)
    expect(JSON.stringify(view)).not.toContain('character:npc')
    expect(JSON.stringify(view)).not.toContain('hold-hand')
  }
  const rejected = bindPlayerProvisional(world.manifest.address, 10, world.manifestHash, action, { status: 'rejected', reason: 'unavailable', events: [] })
  expect(rejected.binding.reason).toBe('unavailable')
})