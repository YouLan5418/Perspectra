import { hashWorldJson, type ReactionProfileId, type WorldJsonObject } from '@harness-world/contracts'
import { characterInteractionWorld } from './character-interaction-world.ts'
import { frozenInteractionWorld } from './frozen-interaction-world.ts'

export function intentWorld() {
  const base = characterInteractionWorld()
  const manifest = { ...base.manifest, playerInputPolicy: { version: 'player-intent/v1' } }
  const manifestHash = hashWorldJson('compiled-world-manifest', manifest)
  const genesisEvents = base.genesisEvents.map(event => event.eventType === 'world.manifest-locked'
    ? { ...event, data: { manifestHash, genesisPlanHash: manifest.genesisPlanHash } } : event)
  return { manifest, manifestHash, genesisEvents, genesisHash: hashWorldJson('world-genesis-plan', genesisEvents) }
}

/**
 * The same frozen v10 world, asked to interpret free text instead of taking an explicit command. Its
 * interactions are offered to the intent provider at the version the world adjudicates them, which is
 * what makes an interpreted interaction reachable on the frozen path at all.
 */
export function frozenIntentWorld(profile?: ReactionProfileId) {
  const base = frozenInteractionWorld(profile)
  const manifest = { ...base.manifest, playerInputPolicy: { version: 'player-intent/v1' as const } }
  const manifestHash = hashWorldJson('compiled-world-manifest', manifest)
  const genesisEvents = base.genesisEvents.map(event => event.eventType === 'world.manifest-locked'
    ? { ...event, data: { ...event.data as WorldJsonObject, manifestHash } } : event)
  return { manifest, manifestHash, genesisEvents, genesisHash: hashWorldJson('world-genesis-plan', genesisEvents) }
}

export const intentFixtureProfile = { version: 'player-intent-profile/v1' as const, providerId: 'fixture', modelId: 'intent/v1', maxOutputTokens: 10, timeoutMs: 100 }
export const intentFixtureResponse = { version: 'player-intent-candidate/v3', decision: 'act', reason: 'none',
  actions: [{ key: 'a', affordanceId: 'speak', quotes: ['你好'] }] }
export const intentFixtureRequest = { text: '你好', principalId: 'principal:player', idempotencyKey: 'intent:crash', correlationId: 'intent:crash' }
