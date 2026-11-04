import { createSchedulerRound, type ActivationTurn } from '@harness-world/application'
import { currentLocation } from '@harness-world/kernel'
import type { CharacterId, WorldAddress } from '@harness-world/contracts'
import type { SchedulerRound, WorldReader } from '@harness-world/plugin-sdk'
import type { WorldStore } from '@harness-world/store-sqlite'
import type { PlaySettings } from '../play-settings.ts'
import type { AutonomousRole } from './pack-autonomy.ts'

/** Project declared autonomous opportunities; the configured scheduler owns consuming and budgeting them. */
export function createAutonomyRound(input: {
  readonly settings: PlaySettings
  readonly address: WorldAddress
  readonly signal: AbortSignal
  readonly store: WorldStore
  readonly world: WorldReader
  readonly turn: ActivationTurn
  readonly autonomousTurn: ActivationTurn
  readonly due: readonly AutonomousRole[]
  readonly counts: ReadonlyMap<CharacterId, number>
  readonly rootBeforeSeq: number
  readonly characterIds: readonly CharacterId[]
  readonly activeParticipants: readonly string[]
  readonly allowConcurrent: boolean
  readonly recipients: () => readonly CharacterId[]
}): SchedulerRound {
  const { settings, store, address } = input
  const limits = {
    maximumWaves: settings.autonomyReactionWaves,
    maximumNpcCalls: settings.autonomyReactionCalls,
    maximumCallsPerCharacter: settings.maximumCallsPerCharacter,
    reactionDeadlineSeconds: settings.autonomyDeadlineSeconds,
  }
  return createSchedulerRound({
    phase: 'autonomy',
    store,
    address,
    signal: input.signal,
    world: input.world,
    turn: input.turn,
    afterSeq: input.rootBeforeSeq,
    initialCounts: input.counts,
    characterIds: input.characterIds.filter(
      id => !input.due.some(role => role.characterId === id) && !input.activeParticipants.includes(id),
    ),
    allowConcurrent: input.allowConcurrent,
    presentCharacterIds: input.recipients,
    locationId: id => currentLocation(store.readEvents(address), id) ?? null,
    limits,
    autonomy: {
      turn: input.autonomousTurn,
      roles: input.due.map(role => ({
        characterId: role.characterId,
        opportunities: Math.min(role.opportunities, settings.autonomyOpportunities),
      })),
      maximumNpcCalls: settings.autonomyNpcCalls,
      deadlineSeconds: settings.autonomyDeadlineSeconds,
      reactionLimits: limits,
    },
  })
}
