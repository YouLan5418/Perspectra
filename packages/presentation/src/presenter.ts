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
    const text = value?.observationType === 'player-action-result'
      && typeof value.actionType === 'string'
      && (value.status === 'accepted' || value.status === 'rejected')
      ? this.#playerAction(locale, value.actionType, value.status, typeof value.reason === 'string' ? value.reason : undefined)
      : new TextDecoder().decode(canonicalizeWorldJson(observation))
    const observationContentHash = hashWorldJson('authorized-observation', observation)
    const base = { rendererProfileVersion: 1 as const, locale, style, text, observationContentHash }
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
}
