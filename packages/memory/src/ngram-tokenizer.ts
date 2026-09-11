import { compareWorldText } from '@harness-world/contracts'

/**
 * Versioned keyword tokenizer for Cognitive Memory recall.
 *
 * The frozen `fts5-bm25-stable/v1` path quotes each whitespace run as one term. Chinese text has no
 * word separators, so an entire sentence becomes a single term and only a character-for-character
 * repetition of that same run can ever match. This tokenizer produces overlapping 2- and 3-character
 * tokens for runs of CJK script, so a two-character noun such as 钥匙 matches inside a longer
 * sentence, while a three-character hit stays available as stronger evidence for ranking.
 *
 * Latin letters, digits and identifiers keep the existing rule: a run of those characters is one
 * token, folded to lower case so matching stays case-insensitive the way the previous path was.
 *
 * Token boundaries are part of the frozen identifier: changing them changes Recall results, so a new
 * identifier is required and existing plans keep using the previous path.
 */
export const KEYWORD_TOKENIZER_ID = 'cjk-ngram/v1'

/** Shortest and longest CJK token this tokenizer produces. Single characters are deliberately absent. */
export const CJK_NGRAM_MINIMUM = 2
export const CJK_NGRAM_MAXIMUM = 3

export type KeywordTokenKind = 'cjk-2' | 'cjk-3' | 'word'

export interface KeywordToken {
  readonly token: string
  readonly kind: KeywordTokenKind
  /** Kind bonus used by ranking: a longer CJK hit, or a Latin word, is stronger evidence than a bigram. */
  readonly weight: number
}

/** Kind bonuses are integers so ranking never depends on floating point or platform sorting. */
const KIND_WEIGHT: Readonly<Record<KeywordTokenKind, number>> = Object.freeze({
  'cjk-2': 1, 'cjk-3': 2, word: 3,
})

/**
 * CJK script ranges treated as runs without separators. Han includes the compatibility and both
 * supplementary blocks; kana and Hangul are included because the same absence of separators applies.
 */
function isCjkScript(codePoint: number): boolean {
  return (codePoint >= 0x3400 && codePoint <= 0x4dbf)
    || (codePoint >= 0x4e00 && codePoint <= 0x9fff)
    || (codePoint >= 0xf900 && codePoint <= 0xfaff)
    || (codePoint >= 0x20000 && codePoint <= 0x2fa1f)
    || (codePoint >= 0x3040 && codePoint <= 0x30ff)
    || (codePoint >= 0x1100 && codePoint <= 0x11ff)
    || (codePoint >= 0xac00 && codePoint <= 0xd7af)
}

/**
 * A word run keeps ASCII underscores, matching the previous tokenizer's treatment of them as part of
 * a token rather than as a separator.
 */
function isWordCharacter(codePoint: number): boolean {
  return (codePoint >= 0x30 && codePoint <= 0x39)
    || (codePoint >= 0x41 && codePoint <= 0x5a)
    || (codePoint >= 0x61 && codePoint <= 0x7a)
    || codePoint === 0x5f
}

interface Segment {
  readonly kind: 'cjk' | 'word'
  readonly text: string
}

function segmentsOf(text: string): Segment[] {
  const segments: Segment[] = []
  let current: { kind: 'cjk' | 'word'; characters: string[] } | undefined
  for (const character of text) {
    const codePoint = character.codePointAt(0)!
    const kind = isCjkScript(codePoint) ? 'cjk' : isWordCharacter(codePoint) ? 'word' : undefined
    if (kind === undefined) {
      if (current !== undefined) segments.push({ kind: current.kind, text: current.characters.join('') })
      current = undefined
      continue
    }
    if (current === undefined || current.kind !== kind) {
      if (current !== undefined) segments.push({ kind: current.kind, text: current.characters.join('') })
      current = { kind, characters: [] }
    }
    current.characters.push(character)
  }
  if (current !== undefined) segments.push({ kind: current.kind, text: current.characters.join('') })
  return segments
}

/** Tokens of one CJK run: every overlapping bigram and trigram, in document order. */
function cjkTokens(characters: readonly string[]): KeywordToken[] {
  const tokens: KeywordToken[] = []
  for (let length = CJK_NGRAM_MAXIMUM; length >= CJK_NGRAM_MINIMUM; length -= 1) {
    for (let index = 0; index + length <= characters.length; index += 1) {
      tokens.push({
        token: characters.slice(index, index + length).join(''),
        kind: length === CJK_NGRAM_MAXIMUM ? 'cjk-3' : 'cjk-2',
        weight: KIND_WEIGHT[length === CJK_NGRAM_MAXIMUM ? 'cjk-3' : 'cjk-2'],
      })
    }
  }
  return tokens
}

/**
 * Tokenize text for matching. A run shorter than the shortest token produces no token at all: a
 * single CJK character is too broad to be evidence, so it matches nothing rather than everything.
 * Duplicates are removed and the result is ordered by `compareWorldText` so Golden files and stored
 * term rows cannot depend on insertion order.
 */
export function tokenizeKeywordText(text: string): readonly KeywordToken[] {
  const found = new Map<string, KeywordToken>()
  for (const segment of segmentsOf(text)) {
    const tokens = segment.kind === 'cjk'
      ? cjkTokens([...segment.text])
      : [{ token: segment.text.toLowerCase(), kind: 'word' as const, weight: KIND_WEIGHT.word }]
    for (const token of tokens) if (!found.has(token.token)) found.set(token.token, token)
  }
  return [...found.values()].sort((left, right) => compareWorldText(left.token, right.token))
}
