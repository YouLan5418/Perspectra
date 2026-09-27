import { describe, expect, it } from 'vitest'
import { resolutionAuthority } from '@harness-world/contracts'
import { createCoreRulebookRegistry, currentEntityState, type RulebookEvent } from '@harness-world/kernel'
import type { PlayerInputJob } from '@harness-world/store-sqlite'
import { preparePlayerIntent } from '../../packages/application/src/player-intent-preparation.ts'
import { frozenIntentWorld, intentFixtureProfile } from '../fixtures/player-intent-world.ts'
import { basicInteractionPackage } from '../fixtures/frozen-interaction-world.ts'

const player = 'character:player', item = 'entity:cup'
function fixture(holder: string | null, sourceText: string) {
  const world = frozenIntentWorld()
  const events: RulebookEvent[] = [...world.genesisEvents]
  if (holder) events.push({ eventType: 'entity.transferred', data: { entityId: item,
    fromHolderId: null, fromLocationId: 'location:room', toHolderId: holder, toLocationId: null,
    characterId: holder, interactionId: 'base:take' } })
  const resolver = createCoreRulebookRegistry({ interactionPackages: [basicInteractionPackage] })
    .resolve(world.manifest.rulebook.rulebookId, world.manifest.rulebook.version, 'custody-input:test')
  const job = { address: world.manifest.address, inputId: 'input:physical', principalId: 'principal:player',
    input: { text: sourceText } } as unknown as PlayerInputJob
  const prepared = preparePlayerIntent(job, world.manifest, events, resolver, intentFixtureProfile, 100,
    world.manifestHash, events.length)
  if (!('directSubmission' in prepared)) throw new Error('expected deterministic input')
  return { world, events, resolver, prepared }
}
describe('player physical expression and custody authority', () => {
  it('keeps physical words as speech without relinquishing custody', () => {
    const text = '我把自己保管的水杯暂放桌上，仍由我保管。'
    const f = fixture(player, text)
    const action = f.prepared.directSubmission.actions[0]!
    const result = f.resolver.resolve({ manifest: f.world.manifest, manifestHash: f.world.manifestHash,
      events: f.events, characterId: player, asOfWorldSeq: f.events.length, actionId: action.actionId,
      resolutionAuthority: resolutionAuthority('player', 'manual_player_immediate'), action })
    expect(result.status).toBe('accepted')
    expect(result.events.some(e => e.eventType === 'entity.transferred')).toBe(false)
    expect(currentEntityState([...f.events, ...result.events], item)?.holderId).toBe(player)
    expect(result.events.find(e => e.eventType === 'character.speak')?.data).toMatchObject({ text })
  })

  it('never translates a transfer invitation into a player operation', () => {
    const text = '我把水杯交给NPC保管。'
    for (const holder of [player, 'character:npc']) {
      const f = fixture(holder, text)
      expect(f.prepared.directSubmission.actions).toMatchObject([{ actionType: 'speak', parameters: { text } }])
      expect(currentEntityState(f.events, item)?.holderId).toBe(holder)
    }
  })
})
