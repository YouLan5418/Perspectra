/**
 * Read-only diagnostic: can a character find an important old fact when the Round asks for it?
 *
 * Production derives the Recall query from the current stimulus, so a character's query is literally
 * whatever the player just said. A fact the character lived through is therefore only reachable when
 * those words happen to match it. This script measures that end to end on the repository's own
 * acceptance Pack, using only public Application, Memory and diagnostic surfaces:
 *
 *   1. one important fact is spoken publicly at Round 1,
 *   2. a long stretch of mundane chatter follows, with two late lines that mention the same key noun,
 *   3. the player asks again the way a player would, in several phrasings,
 *   4. every phrasing is measured three ways: candidates matched before the result limit, the ranked
 *      result the character receives, and whether the fact reached the real Context that was sent.
 *
 * It changes no production code, performs no direct SQL, and writes only inside its own output
 * directory. Numbers are single-machine diagnostics, not a threshold or a cross-platform SLA.
 *
 * Usage: node --import tsx tests/experiments/measure-recall-quality.ts <new-directory> [noiseRounds]
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { WorldApplication, type RoundParticipant } from '@harness-world/application'
import { brandId, type CharacterId, type ProposalContext } from '@harness-world/contracts'
import { isCjkText, tokenizeHybridText, tokenizeKeywordText } from '@harness-world/memory'
import { cut } from 'jieba-wasm'
import { adaptRainyRoadPack, compileRainyRoadPack, RAINY_ROAD_IDS } from '@harness-world/simulation'

const [outputArgument, noiseArgument = '200'] = process.argv.slice(2)
const noiseRounds = Number(noiseArgument)
if (!outputArgument || !Number.isSafeInteger(noiseRounds) || noiseRounds < 10) {
  throw new Error('usage: measure-recall-quality <new-directory> <noiseRounds>=10')
}
const directory = resolve(outputArgument)
if (existsSync(directory)) throw new Error('output directory must not already exist')
mkdirSync(directory, { recursive: true })

const ADDRESS = {
  tenantId: brandId('tenant:recall-measure', 'TenantId'),
  worldId: brandId('world:recall-measure', 'WorldId'),
  branchId: brandId('branch:main', 'BranchId'),
}
/** The fact the character must still be able to find after the chatter. */
const IMPORTANT = '我把备用钥匙放在门口第三个花盆下面了，你们别忘了。'
/** Distinctive nouns of IMPORTANT, used to probe matching granularity. */
const KEY_NOUN = '钥匙'
const MARKER = '花盆'
const MUNDANE = [
  '今天雨下得真大。',
  '路上有点堵，我们走慢点。',
  '车站那边的灯好像坏了。',
  '我先看看时刻表。',
  '这件外套都湿透了。',
  '车里还有半瓶水。',
  '天这么黑，人影都看不清。',
  '我记得车票是放在包里。',
]
/** A late line that mentions the same noun as IMPORTANT, to separate importance from recency. */
const LATE_DECOY = '门口那串钥匙我也看到了，挺旧的。'
/** Phrasings a player might use when the character is expected to surface the fact. */
const CUES = [
  IMPORTANT,
  KEY_NOUN,
  `${KEY_NOUN}放在哪了？`,
  '我们要出门了，你有什么要提醒我的吗？',
]
/**
 * Probes of IMPORTANT, from the shortest noun to the whole line, plus one token present in every
 * captured utterance. They run before any cue Round, so no cue text is in Memory when they are read.
 */
const PROBES = [
  KEY_NOUN, '备用钥匙', MARKER, '第三个花盆', '门口第三个花盆下面了',
  '我把备用钥匙放在门口第三个花盆下面了', IMPORTANT, LATE_DECOY.split('，')[0]!, 'said',
]
/** Queries that compare the frozen whole-run rule with the versioned n-gram tokenizer. */
const PREVIEW_QUERIES = [
  KEY_NOUN, '备用钥匙', MARKER, '第三个花盆', '门口第三个花盆下面了', IMPORTANT,
  `${KEY_NOUN}放在哪了？`, '我们要出门了，你有什么要提醒我的吗？', LATE_DECOY.split('，')[0]!,
]

const emit = (data: object) => process.stdout.write(`${JSON.stringify(data)}\n`)

interface RenderedSegment {
  readonly segmentKind: string
  readonly content: unknown
}
function renderedSegments(context: ProposalContext): RenderedSegment[] {
  const request = (context as unknown as {
    exactProviderRequest: { messages: readonly { content: string }[] }
  }).exactProviderRequest
  // The first two messages are the Host protocol and controller contract, which carry no segments.
  return request.messages.slice(2).map(message => JSON.parse(message.content) as RenderedSegment)
}

/** An abstaining participant: it produces no world effect, but records the exact Context it received. */
const received = new Map<string, ProposalContext[]>()
function abstaining(participantId: string, actorId: CharacterId, priority: number): RoundParticipant {
  return {
    participantId, role: 'agent', actorId, allowedActionTypes: ['move', 'speak', 'take'],
    priority, estimatedTokens: 1, timeoutMs: 100,
    provider: {
      async propose(context) {
        received.set(participantId, [...received.get(participantId) ?? [], context])
        return { schemaVersion: 2, decision: 'abstain', actions: [] }
      },
    },
  }
}

const pack = await compileRainyRoadPack()
const compiled = adaptRainyRoadPack(pack, ADDRESS)
const application = new WorldApplication({
  worldPath: join(directory, 'world.sqlite'),
  sessionPath: join(directory, 'session.sqlite'),
  memoryPath: join(directory, 'memory.sqlite'),
  modelBudgetTokens: 1_000_000,
  participants: () => [
    abstaining('agent:alice', RAINY_ROAD_IDS.alice, 2),
    abstaining('agent:bob', RAINY_ROAD_IDS.bob, 1),
  ],
})

let turn = 0
/** Every public utterance the player committed; the character captured exactly these. */
const spoken: string[] = []
const say = async (text: string) => {
  turn += 1
  spoken.push(text)
  const started = performance.now()
  const result = await application.submit(ADDRESS, {
    idempotencyKey: `recall-measure:${turn}`,
    principalId: RAINY_ROAD_IDS.principal,
    action: { actionType: 'speak', parameters: { text } } as never,
    correlationId: `recall-measure:${turn}`,
  })
  await application.deliver(ADDRESS, `recall-measure:deliver:${turn}`)
  return { tick: result.tick, ms: performance.now() - started }
}

/**
 * Production derives the Recall query from the current stimulus: the string values of the action
 * parameters, in sorted key order, joined by spaces. A speak action therefore queries its own text.
 */
function productionQuery(action: { parameters: Record<string, unknown> }): string {
  return Object.keys(action.parameters).sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
    .flatMap(key => (typeof action.parameters[key] === 'string' ? [action.parameters[key] as string] : []))
    .join(' ')
}

/** The token set the versioned tokenizer derives from one text. */
function tokenSetOf(text: string): ReadonlySet<string> {
  return new Set(tokenizeKeywordText(text).map(token => token.token))
}

/** The token set the segmenter-backed version derives from one text. */
function hybridTokenSetOf(text: string): ReadonlySet<string> {
  return new Set(tokenizeHybridText(text).map(token => token.token))
}

/** The words a segmenter alone would produce, which is the variant that drops the n-gram floor. */
function segmenterTokenSetOf(text: string): ReadonlySet<string> {
  return new Set(cut(text, false).filter(word => isCjkText(word) && [...word].length >= 2))
}

/** How many stored utterances a token set matches over the same corpus. */
function matchedByTokenSet(query: string, corpus: readonly string[], tokenize: (text: string) => ReadonlySet<string>): number {
  const queryTokens = tokenize(query)
  if (queryTokens.size === 0) return 0
  return corpus.filter(text => [...tokenize(text)].some(token => queryTokens.has(token))).length
}

/** How many stored utterances the versioned tokenizer would match over the same corpus. */
function matchedByNgrams(query: string, corpus: readonly string[]): number {
  return matchedByTokenSet(query, corpus, tokenSetOf)
}

/** What the character actually received in the last Round: the Recall segment as the model saw it. */
function contextEvidence(participantId: string): {
  recalled: string[]
  carriedMarker: boolean
} | undefined {
  const last = received.get(participantId)?.at(-1)
  if (last === undefined) return undefined
  const segment = renderedSegments(last).find(value => value.segmentKind === 'verified_recall')
  const recalled = Array.isArray(segment?.content)
    ? (segment!.content as readonly { text: string }[]).map(value => value.text)
    : []
  return { recalled, carriedMarker: recalled.some(text => text.includes(MARKER)) }
}

const roundMs: { tick: number; ms: number }[] = []
try {
  emit({ stage: 'activate', status: application.activate(compiled).status })

  const first = await say(IMPORTANT)
  roundMs.push(first)
  emit({ stage: 'important-fact', tick: first.tick, text: IMPORTANT })

  for (let index = 0; index < noiseRounds; index += 1) {
    // The echo repeats IMPORTANT word for word near the end, so the probes can separate an old fact
    // from a recent restatement of the very same words.
    const text = index === noiseRounds - 3 ? LATE_DECOY
      : index === noiseRounds - 1 ? IMPORTANT
      : MUNDANE[index % MUNDANE.length]!
    const round = await say(text)
    roundMs.push(round)
    if ((index + 1) % 50 === 0) emit({ stage: 'noise', rounds: index + 1, tick: round.tick, roundMs: Number(round.ms.toFixed(2)) })
  }
  emit({ stage: 'noise-complete', rounds: noiseRounds, headTick: turn })
  emit({ stage: 'round-cost', first: Number(roundMs[0]!.ms.toFixed(2)),
    last: Number(roundMs.at(-1)!.ms.toFixed(2)),
    medianMs: Number(roundMs.map(value => value.ms).sort((l, r) => l - r)[Math.floor(roundMs.length / 2)]!.toFixed(2)) })

  // Probes read Memory as it stands after the chatter and before any cue Round is committed.
  for (const probe of PROBES) {
    const diagnostics = await application.diagnoseMemoryRecall(ADDRESS, RAINY_ROAD_IDS.alice, probe)
    const memories = await application.recallMemory(ADDRESS, RAINY_ROAD_IDS.alice, probe)
    emit({
      stage: 'probe', probe, candidatesMatched: diagnostics.matchedCount, returned: memories.length,
      firstSeq: memories[0]?.sourceMaxSeq ?? null,
      firstText: memories[0]?.text.slice(0, 60) ?? null,
      markerRank: memories.findIndex(memory => memory.text.includes(MARKER)),
    })
  }

  // Matching preview: the same stored utterances, matched once by the frozen whole-run rule and once
  // by the versioned n-gram tokenizer. This measures the matching change itself, before it is wired
  // into production; the corpus is cross-checked against the `said` probe one stage above.
  const corpus = spoken.map(text => `character:player said: ${text}`)
  emit({ stage: 'preview-corpus', entries: corpus.length })
  for (const query of PREVIEW_QUERIES) {
    const diagnostics = await application.diagnoseMemoryRecall(ADDRESS, RAINY_ROAD_IDS.alice, query)
    emit({
      stage: 'preview', query,
      frozenMatch: diagnostics.matchedCount,
      ngramMatch: matchedByNgrams(query, corpus),
      segmenterOnlyMatch: matchedByTokenSet(query, corpus, segmenterTokenSetOf),
      hybridMatch: matchedByTokenSet(query, corpus, hybridTokenSetOf),
    })
  }

  // Each cue is a real Round, so its Context is built by production exactly as it would be in play.
  for (const cue of CUES) {
    const round = await say(cue)
    const diagnostics = await application.diagnoseMemoryRecall(ADDRESS, RAINY_ROAD_IDS.alice, cue)
    const memories = await application.recallMemory(ADDRESS, RAINY_ROAD_IDS.alice, cue)
    const evidence = contextEvidence('agent:alice')
    emit({
      stage: 'cue',
      tick: round.tick,
      cue,
      productionQuery: productionQuery({ parameters: { text: cue } }),
      candidatesMatched: diagnostics.matchedCount,
      limit: diagnostics.limit,
      returned: memories.length,
      rankedByRecency: memories.map(memory => ({
        sourceSeq: memory.sourceMaxSeq,
        marker: memory.text.includes(MARKER),
        text: memory.text.slice(0, 60),
      })),
      contextRecalled: evidence?.recalled.length ?? null,
      contextCarriedMarker: evidence?.carriedMarker ?? false,
    })
  }

  const history = await application.eventHistory(ADDRESS)
  emit({ stage: 'world', headSeq: history.at(-1)?.seq ?? 0, tick: history.at(-1)?.tick ?? 0,
    events: history.length, speaks: history.filter(event => event.eventType === 'character.speak').length })
} finally {
  await application.close()
}
writeFileSync(join(directory, 'round-ms.json'), JSON.stringify(roundMs, null, 1))
emit({ stage: 'complete', outputDirectory: directory })
