import { compareWorldText, RECALL_HYBRID_TOKENIZER_ID } from '@harness-world/contracts'
import { cut } from 'jieba-wasm'
import { isCjkText, tokenizeKeywordText, type KeywordToken } from './ngram-tokenizer.ts'

/**
 * Hybrid tokenizer: dictionary words for precision on top of the n-gram recall floor.
 *
 * Word segmentation alone is not enough for Recall. A segmenter merges a compound or an unknown proper
 * noun into one token, and once it does, a query that mentions only part of it stops matching: with
 * `钥匙串` segmented as one word, the query `钥匙` finds nothing. That is the same failure the frozen
 * whole-run path had, in a new form. So both sources are indexed: the n-grams guarantee that a partial
 * mention still matches, and a segmenter word carries a higher weight when it matches exactly.
 *
 * Exact mode (`hmm: false`) is deliberate: it is dictionary plus dynamic programming, with no
 * statistical model, so the same pinned version segments the same text the same way. The mode's known
 * weakness — an unseen name splits into characters (`林小满` becomes `林` `小` `满`) — is covered by the
 * n-gram floor, and the HMM alternative also invents wrong merges (`串挂`) that exact mode avoids.
 *
 * Only one-character CJK words are dropped: they carry almost no discriminative power and would add
 * every utterance as a candidate for any query. Latin words keep the n-gram tokenizer's rule.
 */
export const HYBRID_TOKENIZER_ID = RECALL_HYBRID_TOKENIZER_ID

/** Shortest CJK word kept from the segmenter. */
const CJK_WORD_MINIMUM = 2

/**
 * Tokenize text for matching with both sources merged. When a segmenter word equals an n-gram token,
 * the word's stronger kind wins, so the same string is never counted twice at two weights.
 */
export function tokenizeHybridText(text: string): readonly KeywordToken[] {
  const found = new Map<string, KeywordToken>()
  for (const token of tokenizeKeywordText(text)) found.set(token.token, token)
  for (const word of cut(text, false)) {
    if (!isCjkText(word) || [...word].length < CJK_WORD_MINIMUM) continue
    found.set(word, { token: word, kind: 'jieba-word', weight: 4 })
  }
  return [...found.values()].sort((left, right) => compareWorldText(left.token, right.token))
}
