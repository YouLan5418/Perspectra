import { describe, expect, it } from 'vitest'
import { bindPlayerIntentCandidate, resolutionAuthority, type WorldJsonObject } from '@harness-world/contracts'
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
  if (!('binding' in prepared)) throw new Error('expected interpreted input')
  return { world, events, resolver, prepared }
}
const candidate = (affordanceId: string, quote: string) => ({ version: 'player-intent-candidate/v3',
  decision: 'act', reason: 'none', actions: [{ key: 'a', affordanceId, quotes: [quote] }] })

describe('player physical expression and custody authority', () => {
  it('publishes temporary placement without relinquishing custody', () => {
    const text = '我把自己保管的水杯暂放桌上，仍由我保管。'
    const f = fixture(player, text)
    const bound = bindPlayerIntentCandidate(candidate('narrate', text), f.prepared.binding)
    if (bound.status !== 'validated') throw new Error('expected publication')
    const action = bound.submission.actions[0]!
    const result = f.resolver.resolve({ manifest: f.world.manifest, manifestHash: f.world.manifestHash,
      events: f.events, characterId: player, asOfWorldSeq: f.events.length, actionId: action.actionId,
      resolutionAuthority: resolutionAuthority('player', 'manual_player_immediate'), action })
    expect(result.status).toBe('accepted')
    expect(result.events.some(e => e.eventType === 'entity.transferred')).toBe(false)
    expect(currentEntityState([...f.events, ...result.events], item)?.holderId).toBe(player)
    expect(result.events.find(e => e.eventType === 'character.speak')?.data).toMatchObject({ narration: text })
  })

  it('cannot borrow an offered transfer from a prefix where the player was custodian', () => {
    const text = '我把水杯交给NPC保管。'
    const owned = fixture(player, text), other = fixture('character:npc', text)
    const give = owned.prepared.binding.affordances.find(a => {
      const p = a.parameters as WorldJsonObject
      return (p.definitionRef as WorldJsonObject | undefined)?.id === 'base:give'
        && (p.targetRef as WorldJsonObject | undefined)?.id === item
    })!
    expect(give).toBeDefined()
    expect((owned.prepared.request as WorldJsonObject).contract).toContain(
      JSON.stringify({ characterId: 'character:npc', name: 'NPC' }))
    expect(other.prepared.binding.affordances.some(a => a.affordanceId === give.affordanceId)).toBe(false)
    expect(() => bindPlayerIntentCandidate(candidate(give.affordanceId, text), other.prepared.binding)).toThrow()
    expect(currentEntityState(other.events, item)?.holderId).toBe('character:npc')
  })
})
