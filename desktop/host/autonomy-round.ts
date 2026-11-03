import type { ActivationTurn, CharacterTurn, createSchedulerRound } from '@harness-world/application'
import { brandId, type CharacterId, type WorldAddress, type WorldJsonObject } from '@harness-world/contracts'
import { currentLocation } from '@harness-world/kernel'
import type { SchedulerResult } from '@harness-world/plugin-sdk'
import { CharacterViewBuilder, type WorldStore } from '@harness-world/store-sqlite'
import type { PlaySettings } from '../play-settings.ts'
import type { AutonomousRole } from './pack-autonomy.ts'
import type { WorldGameplay } from './world-gameplay.ts'

/** The model calls this round may still make, read by each decision while it runs. */
export interface CallBudget {
  current: { remaining: number; exhausted: boolean } | undefined
}

/** Each due character's own opportunities, then one bounded round of reactions to what they did. */
export async function runAutonomousRound(input: {
  readonly gameplay: WorldGameplay
  readonly settings: PlaySettings
  readonly address: WorldAddress
  readonly controller: AbortController
  readonly budget: CallBudget
  readonly store: WorldStore
  readonly createTurn: (autonomous?: boolean) => CharacterTurn
  readonly due: readonly AutonomousRole[]
  readonly counts: Map<CharacterId, number>
  readonly rootBeforeSeq: number
  readonly characterIds: readonly CharacterId[]
  readonly serialScheduling: boolean
  readonly isPaused: () => boolean
  readonly serialDecisions: () => boolean
  readonly recipients: () => readonly { readonly id: string }[]
  readonly track: (turn: ActivationTurn) => ActivationTurn
  readonly schedule: (input: Omit<Parameters<typeof createSchedulerRound>[0], 'world'>) => Promise<SchedulerResult>
}): Promise<{ cycle: Record<string, unknown>; reason: string }> {
  const { address, controller, budget, store, createTurn, due, counts, isPaused } = input
  const settings = input.settings
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(settings.autonomyDeadlineSeconds * 1000)])
  const before = store.head(address).headSeq
  const activations: { characterId: CharacterId; result: Awaited<ReturnType<CharacterTurn['run']>> }[] = []
  budget.current = { remaining: settings.autonomyNpcCalls, exhausted: false }
  let calls = 0,
    reason = 'quiescent'
  const turn = input.track(createTurn(true))
  outer: for (let opportunity = 0; opportunity < settings.autonomyOpportunities; opportunity++) {
    for (const role of due) {
      if (opportunity >= role.opportunities) continue
      if (isPaused() || signal.aborted) {
        reason = 'interrupted'
        break outer
      }
      const remaining = Math.min(settings.autonomyNpcCalls - calls, budget.current.remaining)
      if (remaining < 2) {
        reason = 'call_limit'
        break outer
      }
      const stimulus = new CharacterViewBuilder(store)
        .rebuildAt(address, role.characterId, store.head(address).headSeq)
        .observations.filter(o => o.sourceSeq > input.rootBeforeSeq)
        .map(o => o.value as WorldJsonObject)
      const result = await turn.run(role.characterId, { signal, maxCalls: 2, maxModelCalls: remaining, stimulus })
      calls += result.calls
      activations.push({ characterId: role.characterId, result })
      counts.set(role.characterId, (counts.get(role.characterId) ?? 0) + 1)
      if (result.status === 'failed' || result.status === 'interrupted') {
        reason = budget.current.exhausted ? 'call_limit' : result.status
        break outer
      }
    }
  }
  const autonomousCalls = settings.autonomyNpcCalls - budget.current.remaining
  let reactions: SchedulerResult | undefined
  if (
    !signal.aborted &&
    !isPaused() &&
    reason !== 'failed' &&
    reason !== 'interrupted' &&
    settings.autonomyReactionWaves > 0
  ) {
    budget.current = { remaining: settings.autonomyReactionCalls, exhausted: false }
    const active = input.gameplay.activity?.current()
    reactions = await input.schedule({
      store,
      address: address,
      turn: input.track(createTurn()),
      afterSeq: before,
      signal,
      characterIds: input.characterIds.filter(
        id => !due.some(role => role.characterId === id) && (!active?.game.active || !active.participants.includes(id)),
      ),
      presentCharacterIds: () => input.recipients().map(p => brandId(p.id, 'CharacterId')),
      allowConcurrent: !input.serialScheduling && !active?.game.active && !input.serialDecisions(),
      locationId: (id: CharacterId) => currentLocation(store.readEvents(address), id) ?? null,
      initialCounts: counts,
      limits: {
        maximumWaves: settings.autonomyReactionWaves,
        maximumNpcCalls: settings.autonomyReactionCalls,
        maximumCallsPerCharacter: settings.maximumCallsPerCharacter,
        reactionDeadlineSeconds: settings.autonomyDeadlineSeconds,
      },
    })
    if (budget.current.exhausted) reason = 'call_limit'
    else if (reactions.terminalReason !== 'quiescent') reason = reactions.terminalReason
  }
  if (signal.aborted) reason = 'interrupted'
  const reactionCalls = reactions === undefined ? 0 : settings.autonomyReactionCalls - budget.current.remaining
  const cycle = { activations, autonomousCalls, reactionCalls, reactions, terminalReason: reason }
  return { cycle, reason }
}
