/**
 * Read-only diagnostic: how much of the past does a Character Context actually hand to the model,
 * and what would a compressed long-term layer have to carry instead?
 *
 * A Character Controller Context is twelve fixed segments. Of those, only three can ever carry the
 * past: the bounded recent Interaction Tail, one query-driven Recall, and the Continuity Checkpoint.
 * The Checkpoint already names Memory L1 summaries by identity, source range and Hash, but it carries
 * no summary text at all, so the extracts L1 produces never reach a model. This script measures the
 * shape of that gap on the repository's own acceptance Pack:
 *
 *   1. one fact is spoken at Round 1 and never mentioned again,
 *   2. a long stretch of unrelated talk follows, one line per Round,
 *   3. the last Round asks something unrelated to all of it,
 *   4. the final Context is broken down segment by segment: what the Tail still carries, how far the
 *      Checkpoint's summary references reach, and how many bytes of speech live outside both.
 *
 * It changes no production code, performs no direct SQL, and writes only inside its own output
 * directory. Numbers are single-machine diagnostics, not a threshold or a cross-platform SLA.
 *
 * Usage: node --import tsx tests/experiments/measure-context-compression.ts <new-directory> [rounds]
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { WorldApplication, type RoundParticipant } from '@harness-world/application'
import { brandId, type CharacterId, type ProposalContext, type StoredWorldEvent } from '@harness-world/contracts'
import { adaptRainyRoadPack, compileRainyRoadPack, RAINY_ROAD_IDS } from '@harness-world/simulation'
import {
  ContextCostTracker,
  estimateCostCny,
  summarizeContextCost,
  type ContextCallCost,
} from './context-cost.ts'

const [outputArgument, roundsArgument = '60'] = process.argv.slice(2)
const rounds = Number(roundsArgument)
if (!outputArgument || !Number.isSafeInteger(rounds) || rounds < 5) {
  throw new Error('usage: measure-context-compression <new-directory> <rounds>=5')
}
const directory = resolve(outputArgument)
if (existsSync(directory)) throw new Error('output directory must not already exist')
mkdirSync(directory, { recursive: true })

const ADDRESS = {
  tenantId: brandId('tenant:compression-measure', 'TenantId'),
  worldId: brandId('world:compression-measure', 'WorldId'),
  branchId: brandId('branch:main', 'BranchId'),
}
/** The one fact that is spoken once and never mentioned again. */
const IMPORTANT = '我把备用钥匙放在门口第三个花盆下面了，你们别忘了。'
const MARKER = '花盆'
/** Unrelated talk, one line per Round, long enough to be worth compressing. */
const CHATTER = [
  '今天雨下得真大，路上几乎看不清前面的车灯。',
  '我们在车站等了很久，广播里一直在报晚点。',
  '售票厅的暖气坏了，大家都缩在角落里。',
  '我买了两瓶热饮，你先拿着暖手吧。',
  '刚才有个老人问路，我把他带到街对面了。',
  '这班车要是再不来，我们就得找地方住一晚。',
  '我的鞋全湿了，走路一直有声音。',
  '窗外那排路灯只亮了一半，看着有点怪。',
]
/** The final question shares no word with anything the character lived through. */
const UNRELATED = '嗯，随便吧。'

const emit = (data: object) => process.stdout.write(`${JSON.stringify(data)}\n`)

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('expected object')
  return value as Record<string, unknown>
}

interface RenderedSegment {
  readonly segmentKind: string
  readonly content: unknown
}
interface RenderedMessage {
  readonly role: string
  readonly content: string
}
/** The exact twelve-segment request a participant received, as the model saw it. */
function renderedRequest(context: ProposalContext): readonly RenderedMessage[] {
  return (context as unknown as { exactProviderRequest: { messages: readonly RenderedMessage[] } })
    .exactProviderRequest.messages
}
function renderedSegments(context: ProposalContext): RenderedSegment[] {
  // The first two messages are the Host protocol and the controller contract; they carry no segment.
  return renderedRequest(context).slice(2).map(message => JSON.parse(message.content) as RenderedSegment)
}
function segmentOf(context: ProposalContext, kind: string): RenderedSegment | undefined {
  return renderedSegments(context).find(segment => segment.segmentKind === kind)
}

/** An abstaining participant: it produces no world effect, but records the exact Context it received. */
const received = new Map<string, ProposalContext[]>()
/** What each call cost, so the run reports money alongside shape. */
const costs: ContextCallCost[] = []
const costTracker = new ContextCostTracker()
function abstaining(participantId: string, actorId: CharacterId, priority: number): RoundParticipant {
  return {
    participantId, role: 'agent', actorId, allowedActionTypes: ['move', 'speak', 'take'],
    priority, estimatedTokens: 1, timeoutMs: 100,
    provider: {
      async propose(context) {
        received.set(participantId, [...received.get(participantId) ?? [], context])
        costs.push(costTracker.record({
          roundId: context.roundId, participantId, tick: context.tick,
          messages: renderedRequest(context),
        }))
        return { schemaVersion: 2, decision: 'abstain', actions: [] }
      },
    },
  }
}

/** A participant that always speaks one line of unrelated talk, so every Round commits a Tail block. */
function chatty(participantId: string, actorId: CharacterId, priority: number): RoundParticipant {
  const spoken: string[] = []
  return {
    participantId, role: 'agent', actorId, allowedActionTypes: ['move', 'speak', 'take'],
    priority, estimatedTokens: 1, timeoutMs: 100,
    provider: {
      async propose(context) {
        received.set(participantId, [...received.get(participantId) ?? [], context])
        spoken.push(CHATTER[(spoken.length) % CHATTER.length]!)
        return {
          schemaVersion: 2, decision: 'act',
          actions: [{
            actionId: `action:bob:spoken:${spoken.length}`, actorId, actionType: 'speak', actionVersion: 1,
            parameters: {
              text: spoken.at(-1)!, addresseeIds: [], scope: 'scene_public',
              replyTo: null, declaredSpeechAct: 'assert',
            },
          }],
        }
      },
    },
  }
}

/** The text of a committed speak, read from the durable `character.speak` payload. */
function spokenText(event: StoredWorldEvent): string | undefined {
  if (event.eventType !== 'character.speak') return undefined
  const data = event.data
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return undefined
  const text = (data as Record<string, unknown>).text
  return typeof text === 'string' ? text : undefined
}

/** The character a committed Observation belongs to, read from the durable `observation.upsert` payload. */
function observerOf(event: StoredWorldEvent): string | undefined {
  if (event.eventType !== 'observation.upsert') return undefined
  const data = event.data
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return undefined
  const value = (data as Record<string, unknown>).value
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const observerId = (value as Record<string, unknown>).observerId
  return typeof observerId === 'string' ? observerId : undefined
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
    chatty('agent:bob', RAINY_ROAD_IDS.bob, 1),
  ],
})

let turn = 0
const say = async (text: string) => {
  turn += 1
  const result = await application.submit(ADDRESS, {
    idempotencyKey: `compression-measure:${turn}`,
    principalId: RAINY_ROAD_IDS.principal,
    action: { actionType: 'speak', parameters: { text } } as never,
    correlationId: `compression-measure:${turn}`,
  })
  await application.deliver(ADDRESS, `compression-measure:deliver:${turn}`)
  return result.tick
}

try {
  emit({ stage: 'activate', status: application.activate(compiled).status })

  emit({ stage: 'fact', tick: await say(IMPORTANT), text: IMPORTANT })
  for (let index = 0; index < rounds - 2; index += 1) await say(CHATTER[index % CHATTER.length]!)
  emit({ stage: 'chatter-complete', rounds: turn })
  emit({ stage: 'last', tick: await say(UNRELATED), text: UNRELATED })

  const contexts = received.get('agent:alice') ?? []
  const finalContext = contexts.at(-1)
  if (finalContext === undefined) throw new Error('the observed participant never received a Context')

  // 1. The final Context, byte by byte, exactly as the provider request carried it.
  const messages = renderedRequest(finalContext)
  writeFileSync(join(directory, 'final-context.json'), JSON.stringify(
    messages.map(message => ({ role: message.role, content: message.content })), null, 1,
  ))
  emit({
    stage: 'context-bytes',
    total: messages.reduce((sum, message) => sum + Buffer.byteLength(message.content), 0),
    segments: messages.map(message => ({ bytes: Buffer.byteLength(message.content) })),
    kinds: renderedSegments(finalContext).map(segment => ({
      segmentKind: segment.segmentKind,
      bytes: Buffer.byteLength(JSON.stringify(segment.content)),
    })),
  })

  // 2. What the recent Interaction Tail still carries, and what kind of Round it covers.
  const tail = segmentOf(finalContext, 'recent_interaction_tail')
  const blocks = tail === undefined ? [] : ((object(tail.content).blocks ?? []) as readonly unknown[])
  const tailSeqs = blocks.flatMap(block => {
    const value = object(block)
    return [Number(value.startSeq), Number(value.endSeq)]
  })
  const observationsOf = (block: unknown): readonly unknown[] =>
    ((object(block).observations ?? []) as readonly unknown[])
  const tailTexts = blocks.flatMap(block => observationsOf(block).map(observation =>
    JSON.stringify(object(observation).content)))
  emit({
    stage: 'tail',
    blocks: blocks.length,
    roundsCommitted: turn,
    covered: blocks.length === 0
      ? null
      : { first: Math.min(...tailSeqs), last: Math.max(...tailSeqs) },
    carriesMarker: tailTexts.some(text => text.includes(MARKER)),
    observationBytes: tailTexts.reduce((sum, text) => sum + Buffer.byteLength(text), 0),
  })

  // 3. What the Continuity segment holds: the baseline, the Summaries it names, and the digest text.
  const checkpoint = segmentOf(finalContext, 'continuity_checkpoint')
  const checkpointSegment = checkpoint === undefined ? undefined : object(checkpoint.content)
  const checkpointContent = checkpointSegment === undefined ? undefined : object(checkpointSegment.checkpoint)
  const summaryRefs = (checkpointContent?.summaryRefs ?? []) as readonly unknown[]
  const refRanges = summaryRefs.map(ref => {
    const value = object(ref)
    return { start: Number(value.sourceStartSeq), end: Number(value.sourceEndSeq) }
  })
  const activeCognition = (checkpointContent?.activeCognition ?? []) as readonly unknown[]
  const digest = (checkpointSegment?.digest ?? []) as readonly { readonly text: string }[]
  emit({
    stage: 'checkpoint',
    asOfWorldSeq: checkpointContent?.asOfWorldSeq ?? null,
    sourceStartSeq: checkpointContent?.sourceStartSeq ?? null,
    sourceEndSeq: checkpointContent?.sourceEndSeq ?? null,
    summaryRefs: summaryRefs.length,
    ranges: refRanges,
    summaryRange: refRanges.length === 0
      ? null
      : { first: Math.min(...refRanges.map(range => range.start)), last: Math.max(...refRanges.map(range => range.end)) },
    activeCognition: activeCognition.length,
    // Every reference carries identity, range and Hash; only the digest carries text to the model.
    textKeys: [...new Set(summaryRefs.flatMap(ref => Object.keys(object(ref))))].sort(),
    // This is what the model can actually read about Rounds the Tail no longer holds.
    digestEntries: digest.length,
    digestBytes: digest.reduce((sum, entry) => sum + Buffer.byteLength(entry.text), 0),
    digestCarriesMarker: digest.some(entry => entry.text.includes(MARKER)),
    bytes: checkpoint === undefined ? 0 : Buffer.byteLength(JSON.stringify(checkpoint.content)),
  })

  // 4. The durable history itself: how much speech exists, and how much of it no segment carries.
  const history = await application.eventHistory(ADDRESS)
  const speaks = history.filter(event => spokenText(event) !== undefined)
  const speechBytes = speaks.reduce((sum, event) => sum + Buffer.byteLength(spokenText(event)!), 0)
  emit({
    stage: 'history',
    events: history.length,
    headSeq: history.at(-1)?.seq ?? 0,
    speaks: speaks.length,
    speechBytes,
    observedByAlice: history.filter(event => observerOf(event) === RAINY_ROAD_IDS.alice).length,
    eventTypes: [...new Set(history.map(event => event.eventType))].sort(),
  })

  // 5. The Recall the final question produced, and whether the fact reached either channel.
  const recalled = await application.recallMemory(ADDRESS, RAINY_ROAD_IDS.alice, UNRELATED)
  const recallSegment = segmentOf(finalContext, 'verified_recall')
  const recallTexts = (Array.isArray(recallSegment?.content) ? recallSegment.content : [])
    .map(value => JSON.stringify(value))
  emit({
    stage: 'final-recall',
    returned: recalled.length,
    carriesMarker: recallTexts.some(text => text.includes(MARKER)),
    texts: recalled.map(memory => memory.text.slice(0, 40)),
  })

  writeFileSync(join(directory, 'contexts.json'), JSON.stringify(
    contexts.map(context => renderedSegments(context).map(segment => segment.segmentKind)), null, 1,
  ))
  writeFileSync(join(directory, 'call-costs.json'), JSON.stringify(costs, null, 1))

  // 6. What the calls cost: the seven numbers a cost review needs, per call and for the run.
  const last = costs.at(-1)
  emit({
    stage: 'last-call-cost',
    roundId: last?.roundId ?? null,
    tick: last?.tick ?? null,
    totalInputTokens: last?.totalTokens ?? 0,
    cachedTokens: last?.cachedTokens ?? 0,
    missedTokens: last?.missedTokens ?? 0,
    cacheHitRate: Number((last?.hitRate ?? 0).toFixed(4)),
    cacheBreakpointSegment: last?.breakpointSegment ?? null,
    cacheBreakpointMessageIndex: last?.breakpointMessageIndex ?? null,
    newTokensThisRound: last?.newTokens ?? 0,
    checkpointRebuilt: last?.checkpointAdvanced ?? false,
    checkpointAsOfWorldSeq: last?.checkpointAsOfWorldSeq ?? null,
  })
  const summary = summarizeContextCost(costs)
  emit({
    stage: 'cost-summary',
    calls: summary.calls,
    totalInputTokens: summary.totalTokens,
    cachedTokens: summary.cachedTokens,
    missedTokens: summary.missedTokens,
    cacheHitRate: Number(summary.hitRate.toFixed(4)),
    medianNewTokensPerCall: summary.medianNewTokens,
    checkpointRebuilds: summary.checkpointRebuilds,
    breakpointSegments: summary.breakpointSegments,
    // Input only, priced at DeepSeek Flash: 2 CNY per million missed, 0.04 per million cached.
    inputCostCny: Number(estimateCostCny({
      missedTokens: summary.missedTokens, cachedTokens: summary.cachedTokens, outputTokens: 0,
    }).toFixed(4)),
    offPeakInputCostCny: Number(estimateCostCny({
      missedTokens: summary.missedTokens, cachedTokens: summary.cachedTokens, outputTokens: 0, offPeak: true,
    }).toFixed(4)),
  })
} finally {
  await application.close()
}
emit({ stage: 'complete', outputDirectory: directory })
