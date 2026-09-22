import {
  canonicalizeWorldJson,
  hashWorldJson,
  type WorldHash,
  type WorldJsonObject,
  type WorldJsonValue,
} from '@harness-world/contracts'

export interface PresenterOptions {
  readonly locale?: 'en' | 'zh-CN'
  readonly style?: 'plain'
}

export interface PresentationResult extends WorldJsonObject {
  readonly rendererProfileVersion: 1
  readonly locale: 'en' | 'zh-CN'
  readonly style: 'plain'
  readonly text: string
  readonly observationContentHash: WorldHash
  readonly presentationHash: WorldHash
  readonly reactionOrigin?: ReactionPresentationOrigin
}

export interface ReactionPresentationOrigin extends WorldJsonObject {
  readonly rootRoundId: string
  readonly cycleId: string
  readonly wave: number
  readonly roundId: string
}

function object(value: WorldJsonValue): WorldJsonObject | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as WorldJsonObject : undefined
}

/** Pure template renderer for already-authorized Observation data. */
export class DeterministicPresenter {
  render(observation: WorldJsonValue, options: PresenterOptions = {}): PresentationResult {
    canonicalizeWorldJson(observation)
    const locale = options.locale ?? 'en'
    const style = options.style ?? 'plain'
    if (locale !== 'en' && locale !== 'zh-CN') throw new TypeError('unsupported presenter locale')
    if (style !== 'plain') throw new TypeError('unsupported presenter style')
    const value = object(observation)
    const reactionOrigin = value?.observationType === 'reaction-round'
      && typeof value.cycleId === 'string'
      && typeof value.wave === 'number'
      && typeof value.roundId === 'string'
      && typeof value.rootRoundId === 'string'
      && typeof value.value === 'object'
      && value.value !== null
      ? {
          cycleId: value.cycleId,
          wave: value.wave,
          roundId: value.roundId,
          rootRoundId: value.rootRoundId,
        }
      : undefined
    const observationPayload = reactionOrigin !== undefined
      ? value
      : typeof value?.observationId === 'string' && object(value.value ?? null)?.content !== undefined
      ? value
      : undefined
    const text = value?.observationType === 'player-action-result'
      && typeof value.actionType === 'string'
      && (value.status === 'accepted' || value.status === 'rejected')
      ? this.#playerAction(locale, value.actionType, value.status, typeof value.reason === 'string' ? value.reason : undefined)
      : observationPayload !== undefined
      ? this.#observedAction(locale, observationPayload)
      : new TextDecoder().decode(canonicalizeWorldJson(observation))
    const observationContentHash = hashWorldJson('authorized-observation', observation)
    const base = {
      rendererProfileVersion: 1 as const,
      locale,
      style,
      text,
      observationContentHash,
      ...(reactionOrigin === undefined ? {} : { reactionOrigin }),
    }
    return { ...base, presentationHash: hashWorldJson('deterministic-presentation', base) }
  }

  #playerAction(locale: 'en' | 'zh-CN', actionType: string, status: 'accepted' | 'rejected', reason?: string): string {
    if (locale === 'zh-CN') {
      if (status === 'accepted') return `行动已执行：${actionType}`
      return reason === undefined ? `行动被拒绝：${actionType}` : `行动被拒绝：${actionType}（${reason}）`
    }
    if (status === 'accepted') return `Action completed: ${actionType}`
    return reason === undefined ? `Action rejected: ${actionType}` : `Action rejected: ${actionType} (${reason})`
  }

  #observedAction(locale: 'en' | 'zh-CN', payload: WorldJsonObject): string {
    const observation = object(payload.value!)
    const content = object(observation?.content ?? null)
    if (content === undefined) return new TextDecoder().decode(canonicalizeWorldJson(payload))
    const actorId = typeof content.actorId === 'string' ? content.actorId : 'unknown'
    const actionType = typeof content.actionType === 'string' ? content.actionType : 'unknown'
    const status = content.status === 'accepted' ? 'accepted' : content.status === 'rejected' ? 'rejected' : null
    if (status !== 'accepted') return new TextDecoder().decode(canonicalizeWorldJson(payload))
    const speechValue = object(content.speech ?? null)
    const speech = typeof speechValue?.text === 'string' ? speechValue.text : null
    const manifestation = object(content.manifestation ?? null)
    const cueValues = Array.isArray(manifestation?.cues) ? manifestation.cues : []
    const cueDescriptions = cueValues.map(value => object(value)?.description)
    const manifestationMalformed = content.manifestation !== undefined && (
      manifestation === undefined
      || (manifestation.description !== undefined && manifestation.description !== null
        && typeof manifestation.description !== 'string')
      || cueValues.length === 0
      || cueDescriptions.some(value => typeof value !== 'string')
    )
    if (manifestationMalformed) return new TextDecoder().decode(canonicalizeWorldJson(payload))
    const stage = typeof speechValue?.narration === 'string' && speechValue.narration.length > 0
      ? speechValue.narration : typeof manifestation?.description === 'string'
      ? manifestation.description
      : manifestation === undefined ? null : (cueDescriptions as string[]).join(locale === 'zh-CN' ? '，' : ', ')
    if (speech === '' && stage !== null) {
      return locale === 'zh-CN' ? `角色 ${actorId}：（${stage}）` : `${actorId}: *${stage}*`
    }
    if (locale === 'zh-CN') {
      const action = speech !== null
        ? `角色 ${actorId} 说："${speech}"`
        : `角色 ${actorId} 行动：${actionType}`
      return stage === null ? action : `（${stage}）\n${action}`
    }
    const action = speech !== null
      ? `${actorId} says: "${speech}"`
      : `${actorId} acts: ${actionType}`
    return stage === null ? action : `*${stage}*\n${action}`
  }
}
