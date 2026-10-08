import type { WorldJsonObject } from './world-json.ts'

/** Ordered publication content; narration does not establish a controlled world outcome. */
export interface ExpressionSegment extends WorldJsonObject {
  readonly type: 'speech' | 'narration'
  readonly text: string
}

export function parseExpressionSegments(value: unknown, maximumCharacters = 2000): ExpressionSegment[] {
  if (!Number.isSafeInteger(maximumCharacters) || maximumCharacters < 1 || maximumCharacters > 16000) throw new TypeError('invalid publication character limit')
  if (!Array.isArray(value) || value.length === 0) throw new TypeError('expression segments must be non-empty')
  let length = 0
  return value.map(item => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)
      || Object.keys(item).sort().join(',') !== 'text,type'
      || !['speech', 'narration'].includes(item.type)
      || typeof item.text !== 'string' || !item.text.trim()) throw new TypeError('invalid expression segment')
    length += item.text.length
    if (length > maximumCharacters) throw new TypeError(`expression segments exceed ${maximumCharacters} characters in total`)
    return { type: item.type, text: item.text }
  })
}

/** Current player publications use text/narration; NPC publications carry ordered segments. */
export function publicationSegments(publication: WorldJsonObject): ExpressionSegment[] {
  if (publication.segments !== undefined) {
    if (!Array.isArray(publication.segments)) throw new TypeError('publication segments must be an array')
    return publication.segments.map(value => {
      if (value === null || typeof value !== 'object' || Array.isArray(value)
        || (value.type !== 'speech' && value.type !== 'narration') || typeof value.text !== 'string') {
        throw new TypeError('invalid publication segment')
      }
      // Authorized display/context copies may contain text removed by preset rules.
      return { type: value.type, text: value.text }
    })
  }
  if (typeof publication.text !== 'string'
    || (publication.narration !== undefined && typeof publication.narration !== 'string')) {
    throw new TypeError('publication requires segments or player text/narration')
  }
  return [
    ...(typeof publication.narration === 'string' && publication.narration.length > 0
      ? [{ type: 'narration' as const, text: publication.narration }] : []),
    ...(publication.text.length > 0 ? [{ type: 'speech' as const, text: publication.text }] : []),
  ]
}

export function publicationSourceText(publication: WorldJsonObject): string {
  const segments = publicationSegments(publication)
  // Existing player Sources keep their original two-field rendering.
  const ordered = publication.segments === undefined
    ? segments.toSorted((a, b) => Number(a.type === 'narration') - Number(b.type === 'narration')) : segments
  return ordered.map(segment => segment.type === 'speech'
    ? `${publication.characterId} said: ${segment.text}`
    : `${publication.characterId} published narration (not an adjudicated outcome): ${segment.text}`).join('; ')
}

export function checkExpressionPolicy(segments: readonly ExpressionSegment[], policy: WorldJsonObject): void {
  const speech = segments.filter(segment => segment.type === 'speech')
  if (segments.some(segment => segment.type === 'narration') && policy.narration === false
    || speech.length > 0 && policy.speech === 'none') throw new TypeError('当前玩法禁止该表达字段。')
  if (policy.speech === 'choices' && (speech.length > 1
    || speech.some(segment => !Array.isArray(policy.speechChoices) || !policy.speechChoices.includes(segment.text)))) {
    throw new TypeError('原始对白不属于当前玩法选项；一次发布最多选择一项。')
  }
}
