import { fileURLToPath } from 'node:url'
import type { RoundParticipant } from '@harness-world/application'
import { brandId, type WorldAddress } from '@harness-world/contracts'
import type { CompiledWorldSpec } from '@harness-world/kernel'
import {
  WorldPackCompiler,
  type CompiledWorldPack,
} from '@harness-world/world-pack'
import { ScriptedAgentProvider } from './providers.ts'

export const TAVERN_SOCIAL_IDS = Object.freeze({
  visitor: brandId('character:visitor', 'CharacterId'),
  alice: brandId('character:alice', 'CharacterId'),
  bob: brandId('character:bob', 'CharacterId'),
  session: brandId('session:tavern-visitor', 'SessionId'),
  principal: 'principal:tavern-visitor',
  hall: 'location:tavern-hall',
  courtyard: 'location:courtyard',
  token: 'entity:brass-token',
})

/** Repository-owned source fixture; callers may copy it before compiling to prove source independence. */
export function tavernSocialSourceDirectory(): string {
  return fileURLToPath(new URL('../../../examples/world-packs/tavern-social/', import.meta.url))
}

/** Compile the reference Pack through the same public compiler used by creator content. */
export function compileTavernSocialPack(sourceDirectory = tavernSocialSourceDirectory()): Promise<CompiledWorldPack> {
  return new WorldPackCompiler().compile(sourceDirectory)
}

/** Bind an immutable compiled Pack to one runtime address without injecting content Events. */
export function adaptTavernSocialPack(pack: CompiledWorldPack, address: WorldAddress): CompiledWorldSpec {
  return new WorldPackCompiler().adaptToWorldSpec(pack, {
    address,
    principalId: TAVERN_SOCIAL_IDS.principal,
    sessionId: TAVERN_SOCIAL_IDS.session,
  })
}

/** Deterministic no-network NPCs used only to exercise the formal Agent/Scene/Memory path. */
export function createTavernSocialParticipants(): readonly RoundParticipant[] {
  const alice = new ScriptedAgentProvider('agent:alice', context => context.tick === 7
    ? [{
      actorId: TAVERN_SOCIAL_IDS.alice,
      actionType: 'move',
      actionVersion: 1,
      parameters: { locationId: TAVERN_SOCIAL_IDS.courtyard },
    }]
    : [{
      actorId: TAVERN_SOCIAL_IDS.alice,
      actionType: 'speak',
      actionVersion: 1,
      parameters: { text: '欢迎来到渡鸦酒馆。' },
    }])
  const bob = new ScriptedAgentProvider('agent:bob', () => [{
    actorId: TAVERN_SOCIAL_IDS.bob,
    actionType: 'speak',
    actionVersion: 1,
    parameters: { text: '今晚地窖门保持锁着。' },
  }])
  return [
    {
      participantId: alice.participantId,
      role: 'agent',
      actorId: TAVERN_SOCIAL_IDS.alice,
      allowedActionTypes: ['move', 'speak'],
      priority: 2,
      estimatedTokens: 1,
      timeoutMs: 100,
      provider: alice,
    },
    {
      participantId: bob.participantId,
      role: 'agent',
      actorId: TAVERN_SOCIAL_IDS.bob,
      allowedActionTypes: ['speak'],
      priority: 1,
      estimatedTokens: 1,
      timeoutMs: 100,
      provider: bob,
    },
  ]
}
