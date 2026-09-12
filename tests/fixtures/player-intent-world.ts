import { hashWorldJson } from '@harness-world/contracts'
import { characterInteractionWorld } from './character-interaction-world.ts'

export function intentWorld() {
  const base = characterInteractionWorld()
  const manifest = { ...base.manifest, playerInputPolicy: { version: 'player-intent/v1' } }
  const manifestHash = hashWorldJson('compiled-world-manifest', manifest)
  const genesisEvents = base.genesisEvents.map(event => event.eventType === 'world.manifest-locked'
    ? { ...event, data: { manifestHash, genesisPlanHash: manifest.genesisPlanHash } } : event)
  return { manifest, manifestHash, genesisEvents, genesisHash: hashWorldJson('world-genesis-plan', genesisEvents) }
}

export const intentFixtureProfile = { version: 'player-intent-profile/v1' as const, providerId: 'fixture', modelId: 'intent/v1', maxOutputTokens: 10, timeoutMs: 100 }
export const intentFixtureResponse = { version: 'player-intent-candidate/v1', decision: 'act', reason: 'none',
  actions: [{ key: 'a', affordanceId: 'speak' }], sourceSpans: [{ actionKey: 'a', startUtf16: 0, endUtf16: 2, text: '你好', kind: 'speech' }] }
export const intentFixtureRequest = { text: '你好', principalId: 'principal:player', idempotencyKey: 'intent:crash', correlationId: 'intent:crash' }
