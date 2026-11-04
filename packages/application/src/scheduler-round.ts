import { publicationSegments } from '@harness-world/contracts'
import { brandId, type CharacterId, type WorldAddress, type WorldJsonObject } from '@harness-world/contracts'
import type {
  ActivationLimits,
  AutonomyOpportunities,
  SchedulerObservation,
  SchedulerRound,
  WorldReader,
} from '@harness-world/plugin-sdk'
import { CharacterViewBuilder, type WorldStore } from '@harness-world/store-sqlite'
import type { CharacterTurn } from './character-turn.ts'

/** Only `run` is used, so a Host may observe which roles are being processed. */
export type ActivationTurn = Pick<CharacterTurn, 'run'>

export interface SchedulerRoundInput {
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
  /** Explicit autonomous opportunities share the dispatcher, never expand observation permission. */
  readonly autonomy?: AutonomyOpportunities & { readonly turn: ActivationTurn }
}

/** What a scheduler may do with one round. It names observations by sequence, so a character's stimulus
 * can only ever be that character's own. */
export function createSchedulerRound(input: SchedulerRoundInput): SchedulerRound {
  const { store, address, autonomy } = input
  const read = (afterSeq: number, throughSeq: number) =>
    store
      .readEventsRange(address, afterSeq, throughSeq, ['observation.upsert'])
      .map(event => ({ seq: event.seq, value: (event.data as WorldJsonObject).value as WorldJsonObject }))
  // One reference per observer: a turn hands the model the very values this round read.
  const seen = new Map<string, WorldJsonObject>()
  const key = (seq: number, observerId: unknown) => `${seq}\u001f${String(observerId)}`
  return {
    phase: input.phase ?? 'scene',
    characterIds: input.characterIds,
    afterSeq: input.afterSeq,
    signal: input.signal,
    limits: input.limits,
    allowConcurrent: input.allowConcurrent,
    world: input.world,
    ...(input.activity === undefined ? {} : { activity: input.activity }),
    ...(input.initialCounts === undefined ? {} : { initialCounts: input.initialCounts }),
    ...(autonomy === undefined
      ? {}
      : {
          autonomy: {
            ...(autonomy.staged === undefined ? {} : { staged: autonomy.staged }),
            roles: autonomy.roles,
            maximumNpcCalls: autonomy.maximumNpcCalls,
            deadlineSeconds: autonomy.deadlineSeconds,
            reactionLimits: autonomy.reactionLimits,
          },
        }),
    headSeq: () => store.head(address).headSeq,
    observationsSince: (afterSeq, throughSeq) => {
      const observations: SchedulerObservation[] = []
      for (const { seq, value } of read(afterSeq, throughSeq)) {
        seen.set(key(seq, value.observerId), value)
        const content = value.content as WorldJsonObject | undefined
        if (content === undefined || content.status !== 'accepted' || content.actorId === value.observerId) continue
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
      const stimulus = options.stimulusSeqs.map(seq => {
        const value =
          seen.get(key(seq, id)) ??
          read(seq - 1, seq).find(entry => String(entry.value.observerId) === String(id))?.value
        if (value === undefined) throw new TypeError(`observation ${seq} does not belong to ${id}`)
        return value
      })
      const turn = options.kind === 'autonomous' ? autonomy?.turn : input.turn
      if (turn === undefined) throw new TypeError('this round has no autonomous opportunities')
      const { kind: _kind, stimulusSeqs: _stimulusSeqs, ...forwarded } = options
      return turn.run(id, { ...forwarded, stimulus })
    },
  }
}
