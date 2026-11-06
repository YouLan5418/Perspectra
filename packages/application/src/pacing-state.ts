import {
  playerRoundNumber,
  type RoundCountEvent,
  type StatusChange,
  type StatusEventData,
  type WorldEventDraft,
  type WorldJsonObject,
} from '@harness-world/contracts'
import { currentCharacterLifecycle, type CompiledWorldManifest, type RulebookEvent } from '@harness-world/kernel'
import type { PacingHistory } from '@harness-world/plugin-sdk'
import { sceneEventObservations } from './activity-lifecycle.ts'

const record = (value: unknown) => (value ?? {}) as Record<string, unknown>

/** What pacing may know of the past, from committed events only: a branch or a replay reads the same history. */
export function pacingHistory(
  events: readonly RoundCountEvent[],
  turnStartSeq: number,
  scope: {
    readonly managedActivities: readonly string[]
    readonly progress: { readonly statuses: readonly string[]; readonly activities: readonly string[] }
  },
): PacingHistory {
  const roundAt = (seq: number) =>
    playerRoundNumber(
      events.filter(event => event.seq <= seq),
      seq,
      false,
    ).round
  const fired: { kind: 'activity' | 'beat'; key: string; round: number }[] = []
  let lastProgressSeq: number | undefined
  for (const event of events) {
    const data = record(event.data)
    if (event.eventType === 'activity.updated') {
      const key = String(data.activityKey ?? 'default')
      if (data.operation === 'start' && scope.managedActivities.includes(key))
        fired.push({ kind: 'activity', key, round: roundAt(event.seq) })
      if (scope.progress.activities.includes(key) && record(record(data.state).game).active === false)
        lastProgressSeq = event.seq
    } else if (event.eventType === 'status.updated') {
      const source = record(data.source)
      if (source.kind === 'beat') fired.push({ kind: 'beat', key: String(source.beatId), round: roundAt(event.seq) })
      if (
        source.kind !== 'initial' &&
        (data.changes as readonly { key: string }[]).some(change => scope.progress.statuses.includes(change.key))
      )
        lastProgressSeq = event.seq
    }
  }
  return {
    round: playerRoundNumber(events, turnStartSeq, false).round,
    fired,
    lastProgressRound: lastProgressSeq === undefined ? 0 : roundAt(lastProgressSeq),
  }
}

/** What an author may do to a character's mind: something noticed, or a thought. Never an instruction channel. */
export interface BeatStimulus {
  readonly characterId: string
  readonly kind: 'perception' | 'thought'
  readonly text: string
}
export interface BeatResult {
  readonly changes: readonly StatusChange[]
  readonly reveals: readonly unknown[]
  readonly notice?: string
  readonly sceneNotice?: string
  readonly stimuli: readonly BeatStimulus[]
}
const MAX_STIMULI = 8,
  MAX_TEXT = 500

function beatText(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_TEXT)
    throw new TypeError(`节拍的${field}必须是 1–${MAX_TEXT} 字符`)
  return value
}

/** An author's mistake refuses the whole beat, so nothing of it is committed. */
export function parseBeatResult(value: unknown, characterIds: readonly string[], playerId: string): BeatResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('节拍结果必须是对象')
  const result = value as Record<string, unknown>
  for (const key of Object.keys(result))
    if (!['changes', 'reveals', 'notice', 'sceneNotice', 'stimuli'].includes(key))
      throw new TypeError('节拍结果有未知字段 ' + key)
  const changes = result.changes ?? [],
    reveals = result.reveals ?? [],
    stimuli = result.stimuli ?? []
  if (!Array.isArray(changes) || !Array.isArray(reveals) || !Array.isArray(stimuli))
    throw new TypeError('节拍的 changes、reveals、stimuli 必须是列表')
  if (stimuli.length > MAX_STIMULI) throw new TypeError(`一个节拍最多 ${MAX_STIMULI} 条刺激`)
  return {
    changes: changes as StatusChange[],
    reveals,
    ...(result.notice === undefined ? {} : { notice: beatText(result.notice, '玩家提示') }),
    ...(result.sceneNotice === undefined ? {} : { sceneNotice: beatText(result.sceneNotice, '在场提示') }),
    stimuli: stimuli.map(item => {
      const row = (item ?? {}) as Record<string, unknown>
      if (Object.keys(row).some(key => !['characterId', 'kind', 'text'].includes(key)))
        throw new TypeError('节拍刺激有未知字段')
      if (row.characterId === playerId) throw new TypeError('玩家不是刺激对象；给玩家的内容写进 notice')
      if (typeof row.characterId !== 'string' || !characterIds.includes(row.characterId))
        throw new TypeError('节拍刺激对象不是已声明且活跃的角色：' + String(row.characterId))
      if (row.kind !== 'perception' && row.kind !== 'thought')
        throw new TypeError('节拍刺激的 kind 只能是 perception 或 thought')
      return { characterId: row.characterId, kind: row.kind, text: beatText(row.text, '刺激文字') }
    }),
  }
}

/** The characters a beat may stimulate now: declared, active, not the player. */
export function beatStimulusTargets(
  manifest: CompiledWorldManifest,
  events: readonly RulebookEvent[],
  playerId: string,
): string[] {
  return manifest.characters
    .map(character => String(character.characterId))
    .filter(id => id !== playerId && (currentCharacterLifecycle(events, id) ?? 'active') === 'active')
}

/** One beat as facts. A stimulus reaches only the character it names; the words prove no change of state. */
export function beatDrafts(input: {
  readonly status: StatusEventData
  readonly actionId: string
  readonly notice?: string | undefined
  readonly sceneNotice?: string | undefined
  readonly stimuli: readonly BeatStimulus[]
  readonly sceneAudience: readonly string[]
  readonly playerId: string
}): WorldEventDraft[] {
  const { actionId, sceneNotice, playerId } = input
  const playerText = input.notice ?? sceneNotice
  return [
    { eventType: 'status.updated', eventVersion: 1, data: input.status as unknown as WorldJsonObject },
    ...(playerText === undefined
      ? []
      : sceneEventObservations({ actionId, observerIds: [playerId], text: playerText })),
    ...(sceneNotice === undefined
      ? []
      : sceneEventObservations({
          actionId,
          observerIds: input.sceneAudience.filter(id => id !== playerId),
          text: sceneNotice,
        })),
    ...input.stimuli.map((stimulus, index) => ({
      eventType: 'observation.upsert',
      eventVersion: 1,
      data: {
        id: `${actionId}:stimulus:${index}`,
        value: {
          observerId: stimulus.characterId,
          actionId,
          ...(stimulus.kind === 'perception'
            ? { epistemicKind: 'direct_observation', content: { status: 'accepted', perceived: stimulus.text } }
            : { epistemicKind: 'subjective_inference', content: { status: 'accepted', innerThought: stimulus.text } }),
        },
      },
    })),
  ]
}
