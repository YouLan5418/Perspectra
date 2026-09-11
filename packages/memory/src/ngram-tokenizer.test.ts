import { describe, expect, it } from 'vitest'
import {
  CJK_NGRAM_MAXIMUM,
  CJK_NGRAM_MINIMUM,
  KEYWORD_TOKENIZER_ID,
  tokenizeKeywordText,
  type KeywordToken,
} from './ngram-tokenizer.ts'

/** Token strings in a stable, order-independent form so these cases read as a Golden set. */
function tokens(text: string): string[] {
  return tokenizeKeywordText(text).map(token => token.token).sort()
}

function kindOf(text: string, token: string): KeywordToken | undefined {
  return tokenizeKeywordText(text).find(value => value.token === token)
}

describe('versioned keyword tokenizer', () => {
  it('keeps the frozen identifier and token lengths explicit', () => {
    expect(KEYWORD_TOKENIZER_ID).toBe('cjk-ngram/v1')
    expect([CJK_NGRAM_MINIMUM, CJK_NGRAM_MAXIMUM]).toEqual([2, 3])
  })

  it('produces overlapping bigrams and trigrams so a two-character noun matches inside a sentence', () => {
    expect(tokens('备用钥匙')).toEqual(['备用', '备用钥', '用钥', '钥匙', '用钥匙'].sort())

    // The case the previous tokenizer could not serve: a two-character noun inside a longer run.
    const sentence = '我把备用钥匙放在门口第三个花盆下面了'
    expect(tokens(sentence)).toContain('钥匙')
    expect(tokens(sentence)).toContain('花盆')
    expect(tokens(sentence)).toContain('备用钥')
    // 18 characters produce 17 bigrams and 16 trigrams, all distinct.
    expect(tokenizeKeywordText(sentence)).toHaveLength(33)
  })

  it('drops runs shorter than the shortest token instead of matching everything', () => {
    expect(tokens('钥')).toEqual([])
    expect(tokens('了')).toEqual([])
    expect(tokens('')).toEqual([])
  })

  it('treats a two-character run as exactly one bigram', () => {
    expect(tokenizeKeywordText('钥匙')).toEqual([{ token: '钥匙', kind: 'cjk-2', weight: 1 }])
  })

  it('folds Latin case and keeps identifiers as single tokens', () => {
    expect(tokens('Alice')).toEqual(['alice'])
    expect(tokens('ALICE alice')).toEqual(['alice'])
    expect(tokens('scene_state_2')).toEqual(['scene_state_2'])
  })

  it('splits on punctuation, whitespace and non-word characters', () => {
    expect(tokens('钥匙，放好了。')).toEqual(tokens('钥匙 放好了'))
    expect(tokens('钥匙，花盆')).toEqual(['花盆', '钥匙'].sort())
  })

  it('ignores leading, trailing and repeated separators', () => {
    expect(tokens('，  钥匙。。')).toEqual(['钥匙'])
    expect(tokens('钥匙，，，放好')).toEqual(tokens('钥匙 放好'))
    expect(tokens('。。。')).toEqual([])
  })

  it('keeps CJK and Latin runs apart inside one text', () => {
    expect(tokens('Alice把钥匙放好'))
      .toEqual(['alice', '把钥', '钥匙', '匙放', '放好', '把钥匙', '钥匙放', '匙放好'].sort())
  })

  it('counts supplementary-plane characters by code point', () => {
    // U+20000 is one character, so this run is a bigram and not a surrogate pair fragment.
    expect(tokenizeKeywordText('\u{20000}\u{20001}')).toEqual([
      { token: '\u{20000}\u{20001}', kind: 'cjk-2', weight: 1 },
    ])
  })

  it('treats every CJK script range as a run without separators', () => {
    const pairs = [
      '\u3400\u3401', '\u4e00\u4e01', '\uf900\uf901', '\u{20000}\u{20001}',
      '\u3042\u3044', '\u30a2\u30a4', '\u1100\u1101', '\uac00\uac01',
    ]
    for (const pair of pairs) {
      expect(tokenizeKeywordText(pair)).toEqual([{ token: pair, kind: 'cjk-2', weight: 1 }])
    }
  })

  it('separates characters just outside every CJK script range', () => {
    const outside = ['\u33ff', '\u4dc0', '\ua000', '\u{2fa20}', '\u303f', '\u3100', '\u10ff', '\ud7b0']
    for (const character of outside) {
      expect(tokens(`钥匙${character}钥匙`)).toEqual(['钥匙'])
    }
  })

  it('removes duplicates across separate runs', () => {
    expect(tokens('钥匙，钥匙')).toEqual(['钥匙'])
    expect(tokens('Alice Alice')).toEqual(['alice'])
  })

  it('reports the kind of every token it produces', () => {
    expect(kindOf('钥匙放', '钥匙放')?.kind).toBe('cjk-3')
    expect(kindOf('钥匙放', '钥匙')?.kind).toBe('cjk-2')
    expect(kindOf('Alice', 'alice')?.kind).toBe('word')
  })

  it('ranks a longer CJK hit and a word above a bigram', () => {
    expect(kindOf('钥匙放', '钥匙放')?.weight).toBe(2)
    expect(kindOf('钥匙放', '钥匙')?.weight).toBe(1)
    expect(kindOf('Alice', 'alice')?.weight).toBe(3)
  })

  it('is deterministic and independent of insertion order', () => {
    const once = tokenizeKeywordText('备用钥匙放在门口')
    expect(tokenizeKeywordText('备用钥匙放在门口')).toEqual(once)
    const reversed = [...once].reverse()
    expect([...once].map(token => token.token).sort()).toEqual(reversed.map(token => token.token).sort())
  })
})
