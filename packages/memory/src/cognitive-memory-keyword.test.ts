import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  brandId,
  RECALL_HYBRID_TOKENIZER_ID,
  RECALL_KEYWORD_STRATEGY_ID,
  RECALL_KEYWORD_TOKENIZER_ID,
  type CharacterId,
  type RecallQueryPlanV2,
  type WorldAddress,
  type WorldEventDraft,
} from '@harness-world/contracts'
import { WorldStore } from '@harness-world/store-sqlite'
import { LocalMemoryStore } from './local-memory.ts'

const directories: string[] = []
const openStores: WorldStore[] = []
const openMemories: LocalMemoryStore[] = []

function paths(): { readonly world: string; readonly memory: string } {
  const directory = mkdtempSync(join(tmpdir(), 'hcw-memory-keyword-'))
  directories.push(directory)
  return { world: join(directory, 'world.sqlite'), memory: join(directory, 'memory.sqlite') }
}

afterEach(() => {
  for (const memory of openMemories.splice(0)) memory.close()
  for (const store of openStores.splice(0)) store.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function address(branch = 'main'): WorldAddress {
  return {
    tenantId: brandId('tenant:memory-keyword', 'TenantId'),
    worldId: brandId('world:memory-keyword', 'WorldId'),
    branchId: brandId(`branch:${branch}`, 'BranchId'),
  }
}

const alice = brandId('character:alice', 'CharacterId')
const bob = brandId('character:bob', 'CharacterId')

/** One committed speech observation, which Memory captures as `character:bob said: <text>`. */
function speech(id: string, text: string): WorldEventDraft {
  return {
    eventType: 'observation.upsert', eventVersion: 1,
    data: { id, value: { observerId: alice, content: { actionType: 'speak', actorId: bob, speech: { characterId: bob, text } } } },
  }
}

async function commit(store: WorldStore, suffix: string, events: readonly WorldEventDraft[], target = address()): Promise<void> {
  const head = store.head(target)
  await store.commitRound({
    address: target, transactionId: brandId(`transaction:keyword:${suffix}`, 'TransactionId'),
    roundId: brandId(`round:keyword:${suffix}`, 'InteractionRoundId'),
    expectedHeadSeq: head.headSeq, expectedTick: head.tick, nextTick: head.tick + 1,
    events, outbox: [], correlationId: `keyword:${suffix}`,
  })
}

/**
 * One important old fact, one later line that merely mentions the same noun, and mundane lines that
 * share only an ordinary word. This is the shape the measurement found the frozen path could not serve.
 */
const IMPORTANT = '我把备用钥匙放在门口第三个花盆下面了'
const DECOY = '门口那串钥匙我也看到了'
const MUNDANE = '车票是放在包里的'

async function fixture(): Promise<{
  readonly path: ReturnType<typeof paths>
  readonly world: WorldStore
  readonly memory: LocalMemoryStore
}> {
  const path = paths()
  const world = new WorldStore(path.world)
  openStores.push(world)
  world.createBranch(address())
  await commit(world, 'genesis', [
    { eventType: 'character.created', eventVersion: 1, data: { characterId: alice, locationId: 'location:road' } },
    { eventType: 'character.created', eventVersion: 1, data: { characterId: bob, locationId: 'location:road' } },
    speech('observation:important', IMPORTANT),
    speech('observation:mundane-a', MUNDANE),
    speech('observation:mundane-b', MUNDANE),
    speech('observation:decoy', DECOY),
  ])
  const memory = new LocalMemoryStore(path.memory, world)
  openMemories.push(memory)
  return { path, world, memory }
}

function plan(
  queryText: string,
  resultLimit = 10,
  characterId: CharacterId = alice,
  overrides: Partial<RecallQueryPlanV2> = {},
): RecallQueryPlanV2 {
  return {
    schemaVersion: 'recall-query-plan/v2', planId: `plan:${characterId}:${queryText}:${resultLimit}`,
    address: address(), characterId, asOfWorldSeq: 6,
    queryText, strategyId: RECALL_KEYWORD_STRATEGY_ID, tokenizerId: RECALL_KEYWORD_TOKENIZER_ID,
    dictionaryEnabled: false, dictionaryWatermark: null, clues: [], resultLimit,
    ...overrides,
  }
}

function texts(memory: LocalMemoryStore, query: string, resultLimit = 10): readonly string[] {
  return memory.recallKeywords(plan(query, resultLimit)).memories.map(entry => entry.text)
}

describe('versioned keyword Recall', () => {
  it('finds an important fact from a two-character noun the frozen path cannot match', async () => {
    const { memory } = await fixture()
    memory.catchUpV2(address(), alice, 6, 'keyword:catchup:alice', undefined, { keywordTokenizerId: RECALL_KEYWORD_TOKENIZER_ID })

    // The frozen path can only match a whole run, so this exact noun yields nothing there.
    expect(memory.recallDiagnostics({
      schemaVersion: 'recall-query-plan/v1', planId: 'plan:frozen', address: address(), characterId: alice,
      asOfWorldSeq: 6, query: '钥匙', limit: 10, rankingAlgorithm: 'fts5-bm25-stable/v1',
    }).matchedCount).toBe(0)

    expect(texts(memory, '钥匙')).toEqual([
      `character:bob said: ${DECOY}`, `character:bob said: ${IMPORTANT}`,
    ])
    // The diagnostic must describe the same candidate set the Recall sees, before its result limit.
    expect(memory.recallDiagnostics(plan('钥匙')).matchedCount).toBe(2)
    expect(texts(memory, '花盆')).toEqual([`character:bob said: ${IMPORTANT}`])
    expect(texts(memory, '钥匙放在哪了？')).toContain(`character:bob said: ${IMPORTANT}`)
  })

  it('ranks an entry that matches a rare token above one that only shares a common word', async () => {
    const { memory } = await fixture()
    memory.catchUpV2(address(), alice, 6, 'keyword:catchup:alice', undefined, { keywordTokenizerId: RECALL_KEYWORD_TOKENIZER_ID })
    const receipt = memory.recallKeywords(plan('钥匙 放在')).receipt
    const scores = receipt.ranking.map(entry => entry.score)
    expect(scores).toEqual([...scores].sort((left, right) => right - left))
    // The important fact carries both tokens, so it must outrank the line that only shares 放在.
    expect(receipt.ranking[0]!.matchedTokens).toEqual(['放在', '钥匙'].sort())
    expect(receipt.ranking.at(-1)!.matchedTokens).toEqual(['放在'])
    expect(memory.recallKeywords(plan('钥匙 放在')).memories[0]!.text).toBe(`character:bob said: ${IMPORTANT}`)
  })

  it('records what the result limit withheld instead of silently dropping it', async () => {
    const { memory } = await fixture()
    memory.catchUpV2(address(), alice, 6, 'keyword:catchup:alice', undefined, { keywordTokenizerId: RECALL_KEYWORD_TOKENIZER_ID })
    const limited = memory.recallKeywords(plan('钥匙', 1)).receipt
    expect(limited).toMatchObject({ matchedCount: 2, droppedByResultLimit: 1, exclusionReasons: ['result_limit'] })
    expect(limited.selectedSourceRefs).toHaveLength(1)

    const none = memory.recallKeywords(plan('完全没出现过的词')).receipt
    expect(none).toMatchObject({ matchedCount: 0, droppedByResultLimit: 0, exclusionReasons: ['no_match'] })
    expect(texts(memory, '完')).toEqual([])
    // A single character produces no token, so the diagnostic reports nothing matched rather than throwing.
    expect(memory.recallDiagnostics(plan('完')).matchedCount).toBe(0)
  })

  it('records the versions it ran under and reports the same receipt for the same plan', async () => {
    const { memory } = await fixture()
    memory.catchUpV2(address(), alice, 6, 'keyword:catchup:alice', undefined, { keywordTokenizerId: RECALL_KEYWORD_TOKENIZER_ID })
    const first = memory.recallKeywords(plan('钥匙')).receipt
    expect(first).toMatchObject({
      schemaVersion: 'recall-receipt/v2', strategyId: RECALL_KEYWORD_STRATEGY_ID,
      tokenizerId: RECALL_KEYWORD_TOKENIZER_ID, dictionaryEnabled: false, dictionaryWatermark: null,
    })
    expect(memory.recallKeywords(plan('钥匙')).receipt).toEqual(first)
  })

  it('keeps the index derived: a second catch-up indexes only what is new', async () => {
    const { world, memory } = await fixture()
    memory.catchUpV2(address(), alice, 6, 'keyword:catchup:alice', undefined, { keywordTokenizerId: RECALL_KEYWORD_TOKENIZER_ID })
    await commit(world, 'later', [speech('observation:later', '新的钥匙串挂在墙上')])
    memory.catchUpV2(address(), alice, 7, 'keyword:catchup:alice:later', undefined, { keywordTokenizerId: RECALL_KEYWORD_TOKENIZER_ID })
    const recalled = memory.recallKeywords(plan('钥匙串', 10, alice, { asOfWorldSeq: 7 })).memories
    // The new entry carries the trigram as well as both bigrams, so it outranks the older mentions.
    expect(recalled.map(entry => entry.text)).toEqual([
      'character:bob said: 新的钥匙串挂在墙上',
      `character:bob said: ${DECOY}`,
      `character:bob said: ${IMPORTANT}`,
    ])
  })

  it('refuses a keyword plan whose namespace has no index instead of returning an empty Recall', async () => {
    const { memory } = await fixture()
    memory.catchUpV2(address(), alice, 6, 'keyword:catchup:without-index')
    expect(() => memory.recallKeywords(plan('钥匙')))
      .toThrow(/keyword index has not been built/u)
    expect(() => memory.recallDiagnostics(plan('钥匙')))
      .toThrow(/keyword index has not been built/u)
  })

  it('rebuilds the index after a namespace reset', async () => {
    const { memory } = await fixture()
    memory.catchUpV2(address(), alice, 6, 'keyword:catchup:alice', undefined, { keywordTokenizerId: RECALL_KEYWORD_TOKENIZER_ID })
    memory.resetCognitiveNamespace(address(), alice)
    expect(() => memory.recallKeywords(plan('钥匙'))).toThrow(/keyword index has not been built/u)
    memory.catchUpV2(address(), alice, 6, 'keyword:catchup:alice:after-reset', undefined, { keywordTokenizerId: RECALL_KEYWORD_TOKENIZER_ID })
    expect(texts(memory, '钥匙')).toHaveLength(2)
  })

  it('rejects a plan it cannot honour', async () => {
    const { memory } = await fixture()
    memory.catchUpV2(address(), alice, 6, 'keyword:catchup:alice', undefined, { keywordTokenizerId: RECALL_KEYWORD_TOKENIZER_ID })
    expect(() => memory.recallKeywords(plan('钥匙', 10, alice, { asOfWorldSeq: -1 })))
      .toThrow(/asOfWorldSeq must be a non-negative safe integer/u)
    expect(() => memory.recallKeywords(plan('钥匙', 0))).toThrow(/resultLimit must be a positive safe integer/u)
    expect(() => memory.recallKeywords(plan('钥匙', 10, alice, { strategyId: 'other/v9' as never })))
      .toThrow(/strategyId is unsupported/u)
    expect(() => memory.recallKeywords(plan('钥匙', 10, alice, { tokenizerId: 'other/v9' as never })))
      .toThrow(/tokenizerId is unsupported/u)
    expect(() => memory.recallKeywords(plan('钥匙', 10, alice, { dictionaryEnabled: true })))
      .toThrow(/keyword dictionary is not implemented/u)
    expect(() => memory.recallKeywords(plan('钥匙', 10, alice, { asOfWorldSeq: 9 })))
      .toThrow(/has not reached the required as-of sequence/u)
  })

  it('scopes matching and statistics to one character namespace', async () => {
    const { memory } = await fixture()
    memory.catchUpV2(address(), alice, 6, 'keyword:catchup:alice', undefined, { keywordTokenizerId: RECALL_KEYWORD_TOKENIZER_ID })
    const before = memory.recallKeywords(plan('钥匙')).receipt
    // Bob observes the same world; his namespace must not exist as a channel into Alice's ranking.
    memory.catchUpV2(address(), bob, 6, 'keyword:catchup:bob', undefined, { keywordTokenizerId: RECALL_KEYWORD_TOKENIZER_ID })
    expect(memory.recallKeywords(plan('钥匙')).receipt).toEqual(before)
    expect(memory.recallKeywords(plan('钥匙', 10, bob)).memories).toEqual([])
  })

  it('fails closed when the same plan identity is bound to another result', async () => {
    const { memory } = await fixture()
    memory.catchUpV2(address(), alice, 6, 'keyword:catchup:alice', undefined, { keywordTokenizerId: RECALL_KEYWORD_TOKENIZER_ID })
    const first = plan('钥匙')
    memory.recallKeywords(first)
    expect(() => memory.recallKeywords(plan('花盆', 10, alice, { planId: first.planId })))
      .toThrow(/Recall receipt identity is bound to another result/u)
  })

  it('serves the segmenter-backed tokenizer without losing a partial mention', async () => {
    const { memory } = await fixture()
    memory.catchUpV2(address(), alice, 6, 'keyword:catchup:hybrid', undefined, { keywordTokenizerId: RECALL_HYBRID_TOKENIZER_ID })
    const hybrid = { tokenizerId: RECALL_HYBRID_TOKENIZER_ID } as const
    // The segmenter merges a compound into one word; the n-gram floor still matches the shorter query.
    expect(memory.recallKeywords(plan('钥匙', 10, alice, hybrid)).memories.map(entry => entry.text)).toEqual([
      `character:bob said: ${DECOY}`, `character:bob said: ${IMPORTANT}`,
    ])
    const word = memory.recallKeywords(plan('花盆', 10, alice, hybrid))
    expect(word.receipt).toMatchObject({ tokenizerId: RECALL_HYBRID_TOKENIZER_ID, matchedCount: 1 })
    expect(word.receipt.ranking[0]!.matchedTokens).toContain('花盆')
  })

  it('refuses a plan whose tokenizer is not the one this namespace was indexed with', async () => {
    const { memory } = await fixture()
    memory.catchUpV2(address(), alice, 6, 'keyword:catchup:alice', undefined, { keywordTokenizerId: RECALL_KEYWORD_TOKENIZER_ID })
    expect(() => memory.recallKeywords(plan('钥匙', 10, alice, { tokenizerId: RECALL_HYBRID_TOKENIZER_ID })))
      .toThrow(/keyword index has not been built for this namespace/u)
  })

  it('admits a candidate through a structural clue at the lowest weight', async () => {
    const { memory } = await fixture()
    memory.catchUpV2(address(), alice, 6, 'keyword:catchup:clues', undefined, { keywordTokenizerId: RECALL_KEYWORD_TOKENIZER_ID })
    // Nothing in the corpus shares a token with this question, so keyword matching alone finds nothing.
    expect(memory.recallKeywords(plan('完全无关的一句话')).receipt.matchedCount).toBe(0)
    const receipt = memory.recallKeywords(plan('完全无关的一句话', 10, alice, {
      planId: 'plan:clue', clues: [{ kind: 'present_character', sourceId: 'character:bob', text: '花盆' }],
    })).receipt
    expect(receipt).toMatchObject({ matchedCount: 1, clueIds: ['character:bob'] })
    expect(receipt.ranking[0]).toMatchObject({ clueMatched: true, matchedTokens: ['花盆'] })
    // The diagnostic must describe the same clue-widened candidate set the Recall ranked.
    expect(memory.recallDiagnostics(plan('完全无关的一句话', 10, alice, {
      planId: 'plan:clue:diagnostics', clues: [{ kind: 'present_character', sourceId: 'character:bob', text: '花盆' }],
    })).matchedCount).toBe(1)
  })

  it('does not mark a term as clue-matched when the question already carried it', async () => {
    const { memory } = await fixture()
    memory.catchUpV2(address(), alice, 6, 'keyword:catchup:clue-overlap', undefined, { keywordTokenizerId: RECALL_KEYWORD_TOKENIZER_ID })
    const receipt = memory.recallKeywords(plan('钥匙', 10, alice, {
      clues: [{ kind: 'open_objective', sourceId: 'goal:overlap', text: '钥匙' }],
    })).receipt
    expect(receipt.matchedCount).toBe(2)
    expect(receipt.ranking.every(entry => !entry.clueMatched)).toBe(true)
  })

  it('refuses an unknown clue kind instead of ignoring it', async () => {
    const { memory } = await fixture()
    memory.catchUpV2(address(), alice, 6, 'keyword:catchup:bad-clue', undefined, { keywordTokenizerId: RECALL_KEYWORD_TOKENIZER_ID })
    expect(() => memory.recallKeywords(plan('钥匙', 10, alice, {
      clues: [{ kind: 'invented' as never, sourceId: 'x', text: '钥匙' }],
    }))).toThrow(/clue kind is unsupported/u)
  })

  it('treats an empty clue list as no clues at all', async () => {
    const { memory } = await fixture()
    memory.catchUpV2(address(), alice, 6, 'keyword:catchup:empty-clues', undefined, { keywordTokenizerId: RECALL_KEYWORD_TOKENIZER_ID })
    const baseline = memory.recallKeywords(plan('钥匙')).receipt
    // A distinct plan identity, so this compares results rather than colliding with the first receipt.
    const empty = memory.recallKeywords(plan('钥匙', 10, alice, {
      planId: 'plan:empty-clues', clues: [],
    })).receipt
    expect(empty.ranking).toEqual(baseline.ranking)
    expect(empty).toMatchObject({ matchedCount: baseline.matchedCount, clueIds: [] })
  })
})
