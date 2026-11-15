import { createSchedulerRound, type ActivationTurn, type ExecutionSchedulerRound } from '@harness-world/application'
import { currentLocation } from '@harness-world/kernel'
import type { CharacterId, WorldAddress } from '@harness-world/contracts'
import type { PluginFault, WorldReader, WakeupSource } from '@harness-world/plugin-sdk'
import type { WorldStore } from '@harness-world/store-sqlite'
import type { PlaySettings } from '../play-settings.ts'
import type { AutonomousRole } from '@harness-world/contracts'

export function autonomyWakeupSource(
  sourceId: string,
  due: readonly AutonomousRole[],
  maximumOpportunities: number,
): WakeupSource {
  return {
    id: sourceId,
    nominate: () =>
      due.map(role => ({
        characterId: role.characterId,
        stimulusSeqs: [],
        opportunities: Math.min(role.opportunities, maximumOpportunities),
      })),
  }
}

/** Project declared autonomous opportunities; the configured scheduler owns consuming and budgeting them. */
export function createAutonomyRound(input: {
  readonly settings: PlaySettings
  readonly address: WorldAddress
  readonly signal: AbortSignal
  readonly store: WorldStore
  readonly world: WorldReader
  readonly turn: ActivationTurn
  readonly due: readonly AutonomousRole[]
  readonly counts: ReadonlyMap<CharacterId, number>
  readonly rootBeforeSeq: number
  readonly characterIds: readonly CharacterId[]
  readonly activeParticipants: readonly string[]
  readonly allowConcurrent: boolean
  readonly recipients: () => readonly CharacterId[]
  readonly autonomySourceId?: string
  readonly extraWakeupSources?: readonly WakeupSource[]
  readonly onWakeupWarning?: (fault: PluginFault) => void
  readonly isCoreError?: (error: unknown) => boolean
}): ExecutionSchedulerRound {
  const { settings, store, address } = input
  const limits = {
    maximumWaves: settings.autonomyReactionWaves,
    maximumNpcCalls: settings.autonomyReactionCalls,
    maximumCallsPerCharacter: settings.maximumCallsPerCharacter,
    reactionDeadlineSeconds: settings.autonomyDeadlineSeconds,
  }
  return createSchedulerRound({
    phase: 'opportunity',
    store,
    address,
    signal: input.signal,
    world: input.world,
    turn: input.turn,
    afterSeq: input.rootBeforeSeq,
    initialCounts: input.counts,
    characterIds: input.characterIds.filter(id => !input.activeParticipants.includes(id)),
    allowConcurrent: input.allowConcurrent,
    presentCharacterIds: input.recipients,
    locationId: id => currentLocation(store.readEvents(address), id) ?? null,
    limits,
    wakeupSources: [
      ...(input.due.length > 0
        ? [
            autonomyWakeupSource(
              input.autonomySourceId ?? 'official-autonomy',
              input.due,
              settings.autonomyOpportunities,
            ),
          ]
        : []),
      ...(input.extraWakeupSources ?? []),
    ],
    ...(input.onWakeupWarning ? { onWakeupWarning: input.onWakeupWarning } : {}),
    ...(input.isCoreError ? { isCoreError: input.isCoreError } : {}),
    opportunityLimits: {
      maximumNpcCalls: settings.autonomyNpcCalls,
      deadlineSeconds: settings.autonomyDeadlineSeconds,
      reactionLimits: limits,
    },
  })
}
