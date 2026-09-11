import { describe, expect, it } from 'vitest'
import { HYBRID_TOKENIZER_ID, tokenizeHybridText } from './hybrid-tokenizer.ts'
import { tokenizeKeywordText } from './ngram-tokenizer.ts'

function tokens(text: string): string[] {
  return tokenizeHybridText(text).map(token => token.token)
}

function tokenOf(text: string, token: string) {
  return tokenizeHybridText(text).find(value => value.token === token)
}

describe('hybrid keyword tokenizer', () => {
  it('keeps the frozen identifier explicit', () => {
    expect(HYBRID_TOKENIZER_ID).toBe('jieba-hybrid/v1')
  })

  it('indexes segmenter words on top of the n-gram floor', () => {
    const found = tokens('我把备用钥匙放在门口第三个花盆下面了')
    // Segmenter words.
    expect(found).toContain('备用')
    expect(found).toContain('钥匙')
    expect(found).toContain('花盆')
    // N-gram floor, which a word-only index would not have.
    expect(found).toContain('备用钥')
    expect(found).toContain('匙放')
  })

  it('still matches a partial mention of a compound the segmenter merged', () => {
    // The segmenter emits 钥匙 and 串 for this text, so a word-only index could not match 钥匙串.
    const stored = tokens('新的钥匙串挂在墙上')
    expect(stored).toContain('钥匙串')
    expect(stored).toContain('匙串')
    expect(tokens('钥匙串')).toContain('钥匙串')
  })

  it('gives a real word more weight than the same string as an n-gram', () => {
    expect(tokenOf('钥匙放好', '钥匙')?.kind).toBe('jieba-word')
    expect(tokenOf('钥匙放好', '钥匙')?.weight).toBe(4)
    expect(tokenOf('钥匙放好', '钥放')).toBeUndefined()
    expect(tokenOf('钥匙放好', '钥匙放')?.kind).toBe('cjk-3')
    expect(tokenOf('钥匙放好', '钥匙放')?.weight).toBe(2)
  })

  it('drops one-character CJK words because they would match everything', () => {
    expect(tokens('我把钥匙放好')).not.toContain('我')
    expect(tokens('我把钥匙放好')).not.toContain('好')
    expect(tokenizeKeywordText('我把钥匙放好').map(token => token.token)).not.toContain('我')
  })

  it('keeps Latin words whole and lower-cased', () => {
    expect(tokens('Alice把钥匙放好')).toContain('alice')
    expect(tokenOf('Alice', 'alice')?.kind).toBe('word')
  })

  it('never returns the same token twice with two weights', () => {
    const found = tokens('钥匙放在门口')
    expect(new Set(found).size).toBe(found.length)
  })

  it('is deterministic and independent of call order', () => {
    const once = tokenizeHybridText('备用钥匙放在门口')
    expect(tokenizeHybridText('备用钥匙放在门口')).toEqual(once)
    tokenizeHybridText('另一段完全不同的文本先跑一次')
    expect(tokenizeHybridText('备用钥匙放在门口')).toEqual(once)
  })

  it('does not trap on punctuation, emoji, mixed scripts or long text', () => {
    const awkward = [
      '。，！？', '🙂🙂钥匙🙂', 'Alice把钥匙放在门口、然后走了。',
      'ＡＢＣ１２３全角', 'x'.repeat(20_000), '钥'.repeat(500),
      '钥匙😀花盆', '\u{20000}\u{20001}', '\uD800', '\uDC00\uD800',
    ]
    for (const text of awkward) {
      const found = tokenizeHybridText(text)
      expect(Array.isArray(found)).toBe(true)
      expect(found.every(token => token.token.length > 0 && token.weight > 0)).toBe(true)
    }
  })
})
