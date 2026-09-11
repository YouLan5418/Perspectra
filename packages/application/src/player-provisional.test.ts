import { expect, it } from 'vitest'
import { resolutionAuthority } from '@harness-world/contracts'
import { createCoreRulebookRegistry } from '@harness-world/kernel'
import { characterInteractionWorld } from '../../../tests/fixtures/character-interaction-world.ts'
import { bindPlayerProvisional, provisionalReactionView, verifyPlayerProvisional } from './player-provisional.ts'

it('binds exact event ordinals, rejects drift, and redacts restricted views before Recall', () => {
  const world = characterInteractionWorld()
  const action = { actionId: 'action:player', actorId: world.manifest.playerBindings[0]!.characterId, actionType: 'interact', actionVersion: 1,
    parameters: { targetId: 'character:npc', interactionId: 'core:hold-hand', arguments: {} } }
  const resolver = createCoreRulebookRegistry().resolve('builtin:speak-move', 2, 'provisional-test')
  const resolution = resolver.resolve({ manifest: world.manifest, events: world.genesisEvents, characterId: action.actorId, actionId: action.actionId,
    action, resolutionAuthority: resolutionAuthority('player', 'manual_player_immediate') })
  const provisional = bindPlayerProvisional(world.manifest.address, 10, world.manifestHash, action, resolution)
  expect(() => verifyPlayerProvisional(provisional, action, resolution)).not.toThrow()
  expect(() => verifyPlayerProvisional(provisional, { ...action, actionId: 'action:changed' }, resolution)).toThrow('differs')
  const corrupted = structuredClone(provisional)
  corrupted.binding.events[0]!.draftOrdinal = 4
  expect(() => verifyPlayerProvisional(corrupted, action, resolution)).toThrow('differs')
  expect(JSON.stringify(provisionalReactionView({ provisional, visibility: 'full' }, world.genesisEvents))).not.toContain('relationId')
  for (const visibility of ['none', 'occurrence_only'] as const) {
    const view = provisionalReactionView({ provisional, visibility }, world.genesisEvents)
    expect(JSON.stringify(view)).not.toContain('character:npc')
    expect(JSON.stringify(view)).not.toContain('hold-hand')
  }
  const rejected = bindPlayerProvisional(world.manifest.address, 10, world.manifestHash, action, { status: 'rejected', reason: 'unavailable', events: [] })
  expect(rejected.binding.reason).toBe('unavailable')
})
