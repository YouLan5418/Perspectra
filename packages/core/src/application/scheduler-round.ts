import { publicationSegments } from '@perspectra/sdk/contracts'
import { brandId, type CharacterId, type WorldAddress, type WorldJsonObject } from '@perspectra/sdk/contracts'
import type {
  ActivationLimits,
  OpportunityScheduleLimits,
  SchedulerObservation,
  SchedulerTurnOptions,
  SchedulerRound,
  WorldReader,
  WakeupSource,
  WakeupCandidate,
  PluginFault,
} from '@perspectra/sdk'
import { CharacterViewBuilder, type WorldStore } from '@perspectra/core/store'
import type { CharacterTurn, CharacterTurnResult } from './character-turn.ts'
import { isPluginFault, PluginFaultError } from '@perspectra/core/runtime'

/** Only `run` is used, so a Host may observe which roles are being processed. */
export type ActivationTurn = Pick<CharacterTurn, 'run'>

export interface ExecutionSchedulerRound extends Omit<SchedulerRound, 'turn'> {
  /** Internal rebinding for settlement reactions, without replaying old autonomous nominations. */
  forReactions(afterSeq: number): ExecutionSchedulerRound
  validateTurn(id: CharacterId, options: SchedulerTurnOptions): void
  turn(
    id: CharacterId,
    options: SchedulerTurnOptions & Pick<NonNullable<Parameters<CharacterTurn['run']>[1]>, 'onProgress'>,
  ): Promise<CharacterTurnResult>
}

export interface SchedulerRoundInput {
  readonly validateTurn?: (id: CharacterId, options: SchedulerTurnOptions) => void
  readonly phase?: SchedulerRound['phase']
  readonly activity?: SchedulerRound['activity']
  readonly store: WorldStore
  readonly address: WorldAddress
  readonly turn: ActivationTurn
  readonly afterSeq: number
  readonly characterIds: readonly CharacterId[]
  readonly signal: AbortSignal
  readonly limits: ActivationLimits
  readonly allowConcurrent: boolean
  readonly world: WorldReader
  readonly presentCharacterIds?: () => readonly CharacterId[]
  readonly locationId?: (characterId: CharacterId) => string | null
  readonly initialCounts?: ReadonlyMap<CharacterId, number>
  /** Policy hints only. All sources use the one bound CharacterTurn. */
  readonly opportunityLimits?: OpportunityScheduleLimits
  readonly wakeupSources?: readonly WakeupSource[]
  readonly onWakeupWarning?: (fault: PluginFault) => void
  readonly isCoreError?: (error: unknown) => boolean
}

/** What a scheduler may do with one round. It names observations by sequence, so a character's stimulus
 * can only ever be that character's own. */
export function createSchedulerRound(input: SchedulerRoundInput): ExecutionSchedulerRound {
  const { store, address } = input
  const sourceIds = (input.wakeupSources ?? []).map(source => source.id)
  if (sourceIds.some(id => !id.trim()) || new Set(sourceIds).size !== sourceIds.length)
    throw new TypeError('WAKEUP_SOURCE_ID_INVALID')
  const read = (afterSeq: number, throughSeq: number) =>
    store.readEventsRange(address, afterSeq, throughSeq, ['observation.upsert']).map(event => {
      const data = event.data as WorldJsonObject
      return { seq: event.seq, value: data.value as WorldJsonObject, sceneReaction: data.sceneReaction !== false }
    })
  // One reference per observer: a turn hands the model the very values this round read.
  const seen = new Map<string, WorldJsonObject>()
  let wakeupCandidates: readonly WakeupCandidate[] | undefined
  const key = (seq: number, observerId: unknown) => `${seq}\u001f${String(observerId)}`
  const stimulusFor = (id: CharacterId, options: SchedulerTurnOptions) =>
    options.stimulusSeqs.map(seq => {
      if (!Number.isSafeInteger(seq) || seq < 1)
        throw new TypeError('observation reference must be a positive safe integer')
      const value =
        seen.get(key(seq, id)) ?? read(seq - 1, seq).find(entry => String(entry.value.observerId) === String(id))?.value
      if (value === undefined) throw new TypeError(`observation ${seq} does not belong to ${id}`)
      // An activity can receive an event as background. Retain the identity of the authorized
      // observation until the model renderer knows which history rows it will actually send.
      return input.phase === 'activity' &&
        typeof (value.content as WorldJsonObject | undefined)?.eventNotice === 'string'
        ? { ...value, sourceSeq: seq }
        : value
    })
  const validateTurn = (id: CharacterId, options: SchedulerTurnOptions) => {
    input.validateTurn?.(id, options)
    stimulusFor(id, options)
  }
  return {
    forReactions: afterSeq => {
      const {
        opportunityLimits: _limits,
        wakeupSources: _sources,
        initialCounts: _counts,
        activity: _activity,
        ...reaction
      } = input
      return createSchedulerRound({ ...reaction, phase: 'scene', afterSeq })
    },
    validateTurn,
    phase: input.phase ?? 'scene',
    characterIds: input.characterIds,
    afterSeq: input.afterSeq,
    signal: input.signal,
    limits: input.limits,
    allowConcurrent: input.allowConcurrent,
    world: input.world,
    wakeups: () => {
      input.signal.throwIfAborted()
      if (wakeupCandidates !== undefined) return structuredClone(wakeupCandidates)
      const throughSeq = store.head(address).headSeq
      const observations = read(input.afterSeq, throughSeq).map(({ seq, value }) => ({
        seq,
        characterId: brandId(String(value.observerId), 'CharacterId'),
        substantive: true,
      }))
      const merged = new Map<CharacterId, WakeupCandidate>()
      for (const source of input.wakeupSources ?? []) {
        let nominations
        try {
          nominations = source.nominate(
            structuredClone({ afterSeq: input.afterSeq, throughSeq, characterIds: input.characterIds, observations }),
          )
          if (!Array.isArray(nominations)) {
            if (nominations && typeof Reflect.get(nominations, 'then') === 'function')
              void Promise.resolve(nominations).catch(() => {})
            throw new TypeError('WAKEUP_RESULT_INVALID')
          }
          // Validate this source completely before accepting any of its contribution.
          for (const nomination of nominations) {
            if (
              !nomination ||
              !input.characterIds.includes(nomination.characterId) ||
              !Array.isArray(nomination.stimulusSeqs) ||
              !Number.isSafeInteger(nomination.opportunities ?? 1) ||
              (nomination.opportunities ?? 1) < 1
            )
              throw new TypeError('WAKEUP_NOMINATION_INVALID')
            for (const seq of nomination.stimulusSeqs)
              if (
                !Number.isSafeInteger(seq) ||
                seq <= input.afterSeq ||
                seq > throughSeq ||
                !observations.some(
                  observation => observation.seq === seq && observation.characterId === nomination.characterId,
                )
              )
                throw new TypeError('WAKEUP_STIMULUS_NOT_OWNED')
          }
        } catch (error) {
          if (
            (input.signal.aborted && error === input.signal.reason) ||
            (input.isCoreError?.(error) && !isPluginFault(error))
          )
            throw error
          const fault = isPluginFault(error) ? error : new PluginFaultError(source.id, 'nominate', true)
          if (!isPluginFault(error)) console.error(fault.message)
          input.onWakeupWarning?.(fault)
          continue
        }
        for (const nomination of nominations) {
          const previous = merged.get(nomination.characterId)
          merged.set(nomination.characterId, {
            characterId: nomination.characterId,
            stimulusSeqs: [...new Set([...(previous?.stimulusSeqs ?? []), ...nomination.stimulusSeqs])].sort(
              (a, b) => a - b,
            ),
            opportunities: Math.max(previous?.opportunities ?? 0, nomination.opportunities ?? 1),
            sourceIds: [...new Set([...(previous?.sourceIds ?? []), source.id])],
          })
        }
      }
      wakeupCandidates = [...merged.values()]
      return structuredClone(wakeupCandidates)
    },
    ...(input.activity === undefined ? {} : { activity: input.activity }),
    ...(input.initialCounts === undefined ? {} : { initialCounts: input.initialCounts }),
    ...(input.opportunityLimits === undefined ? {} : { opportunityLimits: structuredClone(input.opportunityLimits) }),
    headSeq: () => store.head(address).headSeq,
    observationsSince: (afterSeq, throughSeq) => {
      const observations: SchedulerObservation[] = []
      for (const { seq, value, sceneReaction } of read(afterSeq, throughSeq)) {
        seen.set(key(seq, value.observerId), value)
        const content = value.content as WorldJsonObject | undefined
        if (
          !sceneReaction ||
          content === undefined ||
          content.status !== 'accepted' ||
          content.actorId === value.observerId
        )
          continue
        const id = brandId(String(value.observerId), 'CharacterId')
        const speech = content.speech as WorldJsonObject | undefined
        observations.push({
          seq,
          characterId: id,
          substantive:
            speech === undefined ||
            publicationSegments(speech).some(segment => segment.type === 'speech' && segment.text.trim() !== '') ||
            (speech.addresseeIds as string[] | undefined)?.includes(id) === true,
        })
      }
      return observations
    },
    presentCharacterIds: () => input.presentCharacterIds?.() ?? input.characterIds,
    observationSeqs: (characterId, afterSeq, throughSeq) => {
      const observations = new CharacterViewBuilder(store).rebuildAt(address, characterId, throughSeq).observations
      for (const observation of observations)
        seen.set(key(observation.sourceSeq, characterId), observation.value as WorldJsonObject)
      return observations
        .filter(observation => observation.sourceSeq > afterSeq)
        .map(observation => observation.sourceSeq)
    },
    locationOf: id => input.locationId?.(id) ?? null,
    turn: async (id, options) => {
      validateTurn(id, options)
      const stimulus = stimulusFor(id, options)
      const { stimulusSeqs: _stimulusSeqs, ...forwarded } = options
      return input.turn.run(id, { ...forwarded, stimulus })
    },
  }
}
