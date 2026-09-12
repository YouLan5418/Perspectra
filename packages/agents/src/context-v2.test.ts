import { describe, expect, it } from 'vitest'
import {
  CHARACTER_CONTEXT_SEGMENT_KINDS,
  brandId,
  hashContinuityCheckpoint,
  hashInteractionBlock,
  hashInteractionTail,
  hashWorldJson,
  RECALL_KEYWORD_STRATEGY_ID,
  RECALL_KEYWORD_TOKENIZER_ID,
  type CharacterCognitionView,
  type CharacterContinuityCheckpoint,
  type CharacterView,
  type CognitiveMemoryEntry,
  type CognitiveRecallResult,
  type CognitiveRecallResultV2,
  type CognitionProjectionKind,
  type CognitionProjectionRecord,
  type ContextSourceRef,
  type InteractionBlock,
  type InteractionTail,
  type RecallQueryPlan,
  type RecallQueryPlanV2,
  type WorldAddress,
  type WorldJsonObject,
} from '@harness-world/contracts'
import {
  CharacterContextAssembler,
  characterContextUtf8,
  selectInteractionTail,
  type CharacterContextRequest,
  type ContextAffordance,
  type ContextDigestEntry,
} from './context-v2.ts'

const alice = brandId('character:alice', 'CharacterId')
const address: WorldAddress = {
  tenantId: brandId('tenant:context-v2', 'TenantId'),
  worldId: brandId('world:context-v2', 'WorldId'),
  branchId: brandId('branch:main', 'BranchId'),
}
const manifestHash = hashWorldJson('manifest', { version: 4 })

function source(seq: number, id = `event:${seq}`): ContextSourceRef {
  return { sourceKind: 'world_event', sourceId: id, sourceSeq: seq, sourceHash: hashWorldJson('event', { seq, id }) }
}

function view(asOfWorldSeq = 20): CharacterView {
  const base = {
    address, characterId: alice, asOfWorldSeq, lifecycleState: 'active' as const,
    locationId: 'location:station', scenes: [], observations: [], selfObservations: [],
    claims: [], goals: [], visibility: [],
  }
  return { ...base, bundleHash: hashWorldJson('world-character-view', base) }
}

function cognitionRecord(
  kind: CognitionProjectionKind,
  id: string,
  value: WorldJsonObject,
  seq: number,
): CognitionProjectionRecord {
  return { kind, id, characterId: alice, value, validFromSeq: seq, validToSeq: null, sourceRef: source(seq) }
}

function cognition(asOfWorldSeq = 20, records?: readonly CognitionProjectionRecord[]): CharacterCognitionView {
  const values = records ?? [
    cognitionRecord('subjective-claim', 'claim:rain', {
      status: 'active', awareness: 'conscious', proposition: 'rain',
      source: { sourceId: 'AUTHOR_SECRET_SOURCE_CANARY' }, basisRefs: [],
    }, 2),
    cognitionRecord('character-goal', 'goal:leave', {
      status: 'blocked', awareness: 'unrecognized', objective: { kind: 'narrative', text: 'leave' },
      targetKeys: ['station'], source: { sourceId: 'AUTHOR_GOAL_CANARY' }, basisRefs: [],
    }, 3),
    cognitionRecord('relationship-attitude', 'relationship:bob', {
      status: 'active', awareness: 'unrecognized', type: 'trust', target: 'character:bob', basisRefs: [],
    }, 4),
    cognitionRecord('affect-episode', 'affect:anxiety', {
      status: 'active', awareness: 'partially_conscious', type: 'anxiety', basisRefs: [],
    }, 5),
    cognitionRecord('inner-tension', 'tension:leave', {
      status: 'active', awareness: 'unrecognized', title: 'leave?',
      poles: [{ key: 'stay', basisRefs: [{ sourceId: 'AUTHOR_POLE_CANARY' }] }], basisRefs: [],
    }, 6),
    cognitionRecord('commitment', 'commitment:wait', {
      status: 'active', awareness: 'conscious', content: 'wait', basisRefs: [],
    }, 7),
    cognitionRecord('open-loop', 'loop:ticket', {
      status: 'open', summary: 'ticket?', basisRefs: [],
    }, 8),
    cognitionRecord('character-goal', 'goal:done', { status: 'completed', awareness: 'conscious' }, 9),
    cognitionRecord('relationship-attitude', 'relationship:old', { status: 'resolved', awareness: 'conscious' }, 10),
    cognitionRecord('open-loop', 'loop:done', { status: 'answered' }, 11),
  ]
  const current = (kind: CognitionProjectionKind) => values.filter(record => record.kind === kind)
  const base = {
    address, characterId: alice, asOfWorldSeq,
    claims: current('subjective-claim'), goals: current('character-goal'),
    relationships: current('relationship-attitude'), affects: current('affect-episode'),
    innerTensions: current('inner-tension'), commitments: current('commitment'), openLoops: current('open-loop'),
  }
  return { ...base, bundleHash: hashWorldJson('world-character-cognition-view/v1', base) }
}

function block(index: number): InteractionBlock {
  const observationSource = source(12 + index, `event:tail:${index}`)
  const base = {
    schemaVersion: 'interaction-block/v1' as const,
    transactionId: brandId(`transaction:tail:${index}`, 'TransactionId'),
    roundId: brandId(`round:tail:${index}`, 'InteractionRoundId'),
    startSeq: observationSource.sourceSeq, endSeq: observationSource.sourceSeq, tick: index,
    observations: [{ observationId: `observation:tail:${index}`, content: { observerId: alice, text: `turn ${index}` }, sourceRef: observationSource }],
    authorityHash: null,
  }
  return { ...base, blockHash: hashInteractionBlock(base) }
}

function tail(blockCount = 2, afterSeq = 0, asOfWorldSeq = 20): InteractionTail {
  const blocks = Array.from({ length: blockCount }, (_, index) => block(index))
  const base = { schemaVersion: 'interaction-tail/v1' as const, address, characterId: alice, afterSeq, asOfWorldSeq, blocks }
  return { ...base, tailHash: hashInteractionTail(base) }
}

/** One L1 Summary as the Context receives it: its identity, the range it covers, and the text to show. */
function digestEntry(
  sourceStartSeq: number,
  sourceEndSeq: number,
  text: string,
  sourceRefs: readonly ContextSourceRef[],
): ContextDigestEntry {
  return {
    summaryId: `memory-l1-summary/v1:${sourceStartSeq}`, sourceStartSeq, sourceEndSeq,
    summaryHash: hashWorldJson('memory-l1-summary-entry', { sourceStartSeq, sourceEndSeq, text }),
    text, sourceRefs,
  }
}

function memory(index: number): CognitiveMemoryEntry {
  return {
    memoryId: `memory:${index}`, memoryKind: index % 2 === 0 ? 'communication' : 'episodic',
    epistemicKind: index % 2 === 0 ? 'reported_speech' : 'direct_observation',
    text: index % 2 === 0 ? `Bob said P${index}` : `Alice saw P${index}`,
    metadata: { source: { sourceId: 'AUTHOR_MEMORY_CANARY' }, index },
    sourceRef: source(1 + index, `event:memory:${index}`),
    captureHash: hashWorldJson('capture', { index }),
  }
}

function recall(memoryCount = 2, asOfWorldSeq = 20): { plan: RecallQueryPlan; result: CognitiveRecallResult } {
  const memories = Array.from({ length: memoryCount }, (_, index) => memory(index))
  const plan: RecallQueryPlan = {
    schemaVersion: 'recall-query-plan/v1', planId: 'recall:context-v2', address, characterId: alice,
    asOfWorldSeq, query: 'rain', limit: 10, rankingAlgorithm: 'fts5-bm25-stable/v1',
  }
  const watermark = {
    schemaVersion: 'cognitive-memory-watermark/v2' as const, address, characterId: alice,
    verifiedThroughSeq: asOfWorldSeq, capturedThroughSeq: asOfWorldSeq, memoryEpoch: 1,
    sourceMapHash: hashWorldJson('source-map', { asOfWorldSeq }),
  }
  const ranking = memories.map((entry, index) => ({ memoryId: entry.memoryId, rank: index + 1, sourceRef: entry.sourceRef }))
  const receiptInput = {
    schemaVersion: 'recall-receipt/v1' as const,
    receiptId: 'recall-receipt:context-v2',
    planHash: hashWorldJson('recall-query-plan/v1', plan),
    queryHash: hashWorldJson('recall-query/v1', { query: plan.query }),
    resultHash: hashWorldJson('cognitive-memory-recall-result/v2', { memories, ranking }),
    watermark, selectedSourceRefs: memories.map(entry => entry.sourceRef), ranking,
    exclusionReasons: [] as const,
  }
  return { plan, result: { memories, receipt: { ...receiptInput, receiptHash: hashWorldJson('recall-receipt/v1', receiptInput) } } }
}

/** The versioned keyword generation, shaped exactly as the Memory boundary writes it. */
function keywordRecall(memoryCount = 2, asOfWorldSeq = 20): {
  plan: RecallQueryPlanV2
  result: CognitiveRecallResultV2
} {
  const memories = Array.from({ length: memoryCount }, (_, index) => memory(index))
  const plan: RecallQueryPlanV2 = {
    schemaVersion: 'recall-query-plan/v2', planId: 'recall:context-v2:keyword', address, characterId: alice,
    asOfWorldSeq, queryText: 'rain', strategyId: RECALL_KEYWORD_STRATEGY_ID,
    tokenizerId: RECALL_KEYWORD_TOKENIZER_ID, dictionaryEnabled: false, dictionaryWatermark: null,
    clues: [], resultLimit: 10,
  }
  const watermark = {
    schemaVersion: 'cognitive-memory-watermark/v2' as const, address, characterId: alice,
    verifiedThroughSeq: asOfWorldSeq, capturedThroughSeq: asOfWorldSeq, memoryEpoch: 1,
    sourceMapHash: hashWorldJson('source-map', { asOfWorldSeq }),
  }
  const ranking = memories.map((entry, index) => ({
    memoryId: entry.memoryId, rank: index + 1, score: 100 - index,
    matchedTokens: ['rain'], clueMatched: false, sourceRef: entry.sourceRef,
  }))
  const receiptInput = {
    schemaVersion: 'recall-receipt/v2' as const,
    receiptId: 'recall-receipt:context-v2:keyword',
    planHash: hashWorldJson('recall-query-plan/v2', plan),
    strategyId: plan.strategyId, tokenizerId: plan.tokenizerId,
    dictionaryEnabled: false, dictionaryWatermark: null, clueIds: [], watermark,
    matchedCount: memories.length, droppedByResultLimit: 0,
    selectedSourceRefs: memories.map(entry => entry.sourceRef), ranking,
    exclusionReasons: [] as const,
    resultHash: hashWorldJson('cognitive-memory-recall-result/v3', { memories, ranking }),
  }
  return { plan, result: { memories, receipt: { ...receiptInput, receiptHash: hashWorldJson('recall-receipt/v2', receiptInput) } } }
}

function request(overrides: Partial<CharacterContextRequest> = {}): CharacterContextRequest {
  const asOfWorldSeq = overrides.asOfWorldSeq ?? 20
  const recalled = recall(2, asOfWorldSeq)
  const sceneBase = {
    schemaVersion: 'scene-decision/v2' as const, sceneId: 'scene:station', memberIds: [alice],
    observerIds: [alice], schedulableCharacterIds: [], visibleResultCharacterIds: [alice],
    directorEligible: true, asOfSeq: asOfWorldSeq,
  }
  const sceneDecision = { ...sceneBase, decisionHash: hashWorldJson('scene-decision/v2', sceneBase) }
  const stimulus = {
    actionId: 'action:player', actorId: alice, actionType: 'speak', actionVersion: 1,
    parameters: { text: 'Is the road flooded?' },
  }
  const affordances: ContextAffordance[] = [
    { actionType: 'speak', actionVersion: 1 }, { actionType: 'move', actionVersion: 1 },
  ]
  const sortedAffordances = [...affordances].sort((left, right) => left.actionType.localeCompare(right.actionType))
  return {
    address, roundId: brandId('round:current', 'InteractionRoundId'), participantId: 'agent:alice',
    characterId: alice, controllerId: 'scripted:v2', controllerEpoch: 1,
    baseHeadSeq: asOfWorldSeq, asOfWorldSeq, tick: 2, manifestHash, contextProfileId: 'compact',
    worldPublicAnchor: { title: 'Station', source: { sourceId: 'AUTHOR_WORLD_CANARY' } },
    characterAnchor: { name: 'Alice', principles: ['keep promises'], basisRefs: ['AUTHOR_ANCHOR_CANARY'] },
    characterView: view(asOfWorldSeq), cognition: cognition(asOfWorldSeq), checkpoint: null,
    tail: tail(2, 0, asOfWorldSeq), sceneDecision, sceneSourceRefs: [source(1, 'event:scene')],
    recallPlan: recalled.plan, recall: recalled.result, stimulus,
    stimulusHash: hashWorldJson('context-stimulus/v1', stimulus),
    affordances, affordanceHash: hashWorldJson('context-affordances/v1', sortedAffordances),
    runtimeAvailability: 'ready', correlationId: 'context-v2:test',
    ...overrides,
  }
}

function checkpoint(asOfWorldSeq = 0): CharacterContinuityCheckpoint {
  const base = {
    schemaVersion: 'continuity-checkpoint/v1' as const,
    checkpointId: brandId('checkpoint:alice', 'ContinuityCheckpointId'), address, characterId: alice,
    asOfWorldSeq, memoryEpoch: 1, sourceStartSeq: asOfWorldSeq, sourceEndSeq: asOfWorldSeq,
    activeCognition: [], summaryRefs: [],
  }
  return { ...base, checkpointHash: hashContinuityCheckpoint(base) }
}

describe('CharacterContextAssembler v2', () => {
  it('assembles twelve stable segments while isolating latent guidance and untrusted provenance', () => {
    const assembler = new CharacterContextAssembler()
    const assembled = assembler.assembleDetailed(request())
    expect(assembled.bundle.segments.map(segment => segment.segmentKind)).toEqual(CHARACTER_CONTEXT_SEGMENT_KINDS)
    expect(assembler.assemble(request())).toEqual(assembled.bundle)
    const self = assembled.bundle.segments.find(segment => segment.segmentKind === 'current_self_state')!.content as WorldJsonObject
    expect((self.latentGuidance as WorldJsonObject[]).map(value => value.kind)).toEqual([
      'character-goal', 'relationship-attitude', 'inner-tension',
    ])
    expect((self.consciousState as WorldJsonObject[]).map(value => value.kind)).toEqual([
      'subjective-claim', 'affect-episode', 'commitment', 'open-loop',
    ])
    expect([...(self.consciousState as WorldJsonObject[]), ...(self.latentGuidance as WorldJsonObject[])]
      .every(value => typeof value.stateHash === 'string' && value.stateHash.startsWith('sha256:'))).toBe(true)
    const rendered = Buffer.from(characterContextUtf8(assembled.bundle)).toString('utf8')
    expect(rendered).not.toContain('AUTHOR_')
    expect(rendered).toContain('reported_speech')
    expect(rendered).toContain('Bob said P0')
    expect(assembled.contextProfile.profileId).toBe('compact')
    expect(assembled.includedSourceRefs.map(value => value.sourceSeq)).toEqual(
      assembled.includedSourceRefs.map(value => value.sourceSeq).toSorted((left, right) => left - right),
    )
  })

  it('accepts non-Action stimuli and freezes the reaction action limit without changing legacy defaults', () => {
    const assembler = new CharacterContextAssembler()
    for (const stimulus of [null, [], 'heard rain', { content: 'heard rain' }] as const) {
      const stimulusHash = hashWorldJson('context-stimulus/v1', stimulus)
      const assembled = assembler.assembleDetailed(request({
        stimulus, stimulusHash, maximumExternalActions: 1,
      }))
      const current = assembled.bundle.segments.find(segment => segment.segmentKind === 'current_stimulus')!
      const reminder = assembled.bundle.segments.find(segment => segment.segmentKind === 'output_reminder')!
      expect(current.content).toEqual(stimulus)
      expect(reminder.content).toMatchObject({ maximumExternalActions: 1 })
      expect(assembled.includedSourceRefs).toContainEqual(expect.objectContaining({
        sourceId: `stimulus:${stimulusHash}`,
      }))
    }
  })

  it('trims only whole Tail blocks and lowest-ranked Recall entries at profile capacity', () => {
    const assembler = new CharacterContextAssembler()
    const recalled = recall(7)
    const input = request({ tail: tail(5), recallPlan: recalled.plan, recall: recalled.result })
    const compact = assembler.assembleDetailed(input)
    const tailSegment = compact.bundle.segments.find(segment => segment.segmentKind === 'recent_interaction_tail')!
    const recallSegment = compact.bundle.segments.find(segment => segment.segmentKind === 'verified_recall')!
    expect((tailSegment.content as InteractionTail).blocks.map(value => value.roundId)).toEqual([
      'round:tail:1', 'round:tail:2', 'round:tail:3', 'round:tail:4',
    ])
    expect(recallSegment.content as WorldJsonObject[]).toHaveLength(6)
    expect(compact.exclusions).toHaveLength(2)
    expect(new CharacterContextAssembler().assembleDetailed({ ...input, contextProfileId: 'deep' }).exclusions).toEqual([])
  })

  it('keeps the untrimmed assembly byte-identical when no budget trim is requested', () => {
    const assembler = new CharacterContextAssembler()
    const recalled = recall(8)
    const input = request({ tail: tail(6), recallPlan: recalled.plan, recall: recalled.result })
    const omitted = assembler.assembleDetailed(input)
    const zeroed = assembler.assembleDetailed({
      ...input, budgetTrim: { tailBlocks: 0, recallItems: 0, digestItems: 0 },
    })
    expect(zeroed.bundle.contextHash).toBe(omitted.bundle.contextHash)
    expect(zeroed.componentHashes).toEqual(omitted.componentHashes)
    expect(zeroed.includedSourceRefs).toEqual(omitted.includedSourceRefs)
    expect(zeroed.exclusions).toEqual(omitted.exclusions)
  })

  it('records a budget trim apart from profile capacity and gives up Recall before whole Tail blocks', () => {
    const assembler = new CharacterContextAssembler()
    const recalled = recall(8)
    const input = request({ tail: tail(6), recallPlan: recalled.plan, recall: recalled.result })
    const atCapacity = assembler.assembleDetailed(input)
    expect(atCapacity.exclusions.map(value => value.reason)).toEqual([
      'profile_capacity', 'profile_capacity', 'profile_capacity', 'profile_capacity',
    ])
    const trimmed = assembler.assembleDetailed({
      ...input, budgetTrim: { tailBlocks: 1, recallItems: 2, digestItems: 0 },
    })
    expect(trimmed.exclusions.filter(value => value.reason === 'profile_capacity')).toHaveLength(4)
    expect(trimmed.exclusions.filter(value => value.reason === 'budget_trimmed')).toHaveLength(3)
    expect(trimmed.includedSourceRefs.length).toBeLessThan(atCapacity.includedSourceRefs.length)
    const recallSegment = trimmed.bundle.segments.find(segment => segment.segmentKind === 'verified_recall')!
    const tailSegment = trimmed.bundle.segments.find(segment => segment.segmentKind === 'recent_interaction_tail')!
    expect(recallSegment.content as WorldJsonObject[]).toHaveLength(4)
    expect((tailSegment.content as InteractionTail).blocks.map(value => value.roundId)).toEqual([
      'round:tail:3', 'round:tail:4', 'round:tail:5',
    ])
  })

  it('carries the long-term digest inside the continuity segment and counts its sources', () => {
    const assembler = new CharacterContextAssembler()
    const digest = [digestEntry(3, 5, '第 1 轮 ｜ 备用钥匙放在花盆下',
      [source(3, 'event:digest:first'), source(4, 'event:digest:second')]),
    digestEntry(6, 8, '第 5 轮 ｜ 车票在包里', [source(7, 'event:digest:third')])]
    const withDigest = assembler.assembleDetailed(request({
      checkpoint: checkpoint(10), tail: tail(2, 10), digest,
    }))
    const without = assembler.assembleDetailed(request({ checkpoint: checkpoint(10), tail: tail(2, 10) }))
    const segment = withDigest.bundle.segments.find(value => value.segmentKind === 'continuity_checkpoint')!
    const content = segment.content as { readonly digest: readonly { readonly text: string }[] }
    expect(content.digest.map(entry => entry.text)).toEqual([
      '第 1 轮 ｜ 备用钥匙放在花盆下', '第 5 轮 ｜ 车票在包里',
    ])
    // The Rounds it draws on join the audited source set, and the Context Hash covers the text.
    expect(withDigest.includedSourceRefs.some(ref => ref.sourceId === 'event:digest:first')).toBe(true)
    expect(without.includedSourceRefs.some(ref => ref.sourceId === 'event:digest:first')).toBe(false)
    expect(withDigest.bundle.contextHash).not.toBe(without.bundle.contextHash)
  })

  it('refuses a digest that overlaps the Tail or is out of source order', () => {
    const assembler = new CharacterContextAssembler()
    const refused = 'Context digest overlaps the Interaction Tail or is out of source order'
    // A digest may only carry Rounds the Tail does not, so nothing may reach past the Tail floor.
    expect(() => assembler.assembleDetailed(request({
      checkpoint: checkpoint(10), tail: tail(2, 10), digest: [digestEntry(9, 11, '越过尾巴', [])],
    }))).toThrow(refused)
    // Entries arrive oldest first, and a range that runs backwards is not a range.
    expect(() => assembler.assembleDetailed(request({
      checkpoint: checkpoint(10), tail: tail(2, 10),
      digest: [digestEntry(6, 7, '较新', []), digestEntry(3, 4, '较旧', [])],
    }))).toThrow(refused)
    expect(() => assembler.assembleDetailed(request({
      checkpoint: checkpoint(10), tail: tail(2, 10), digest: [digestEntry(6, 5, '倒序', [])],
    }))).toThrow(refused)
  })

  it('gives up the earliest digest groups first and records every source they covered', () => {
    const assembler = new CharacterContextAssembler()
    const digest = [digestEntry(3, 5, '第 1 轮 ｜ 备用钥匙放在花盆下',
      [source(3, 'event:digest:first'), source(4, 'event:digest:second')]),
    digestEntry(6, 8, '第 5 轮 ｜ 车票在包里', [source(7, 'event:digest:third')])]
    const input = request({ checkpoint: checkpoint(10), tail: tail(2, 10), digest })
    const trimmed = assembler.assembleDetailed({
      ...input, budgetTrim: { tailBlocks: 0, recallItems: 0, digestItems: 1 },
    })
    const segment = trimmed.bundle.segments.find(value => value.segmentKind === 'continuity_checkpoint')!
    const content = segment.content as { readonly digest: readonly { readonly text: string }[] }
    // The earliest group goes, the newest stays, and both of its sources stay auditable.
    expect(content.digest.map(entry => entry.text)).toEqual(['第 5 轮 ｜ 车票在包里'])
    expect(trimmed.exclusions.filter(value => value.reason === 'budget_trimmed')).toHaveLength(2)
  })

  it('rejects a malformed budget trim before selecting any segment', () => {
    const assembler = new CharacterContextAssembler()
    expect(() => assembler.assembleDetailed(request({
      budgetTrim: { tailBlocks: -1, recallItems: 0, digestItems: 0 },
    }))).toThrow('Context budget trim requires non-negative safe integers')
    expect(() => assembler.assembleDetailed(request({
      budgetTrim: { tailBlocks: 0, recallItems: 1.5, digestItems: 0 },
    }))).toThrow('Context budget trim requires non-negative safe integers')
    expect(() => assembler.assembleDetailed(request({
      budgetTrim: { tailBlocks: 0, recallItems: 0, digestItems: 0.5 },
    }))).toThrow('Context budget trim requires non-negative safe integers')
  })

  it('selects an empty Tail when a profile reserves zero recent blocks', () => {
    const input = tail(5)
    const selected = selectInteractionTail(input, 0)
    expect(selected.blocks).toEqual([])
    const { tailHash: _tailHash, ...selectedBase } = selected
    expect(selected.tailHash).toBe(hashInteractionTail(selectedBase))
    expect(() => selectInteractionTail(input, -1)).toThrow(RangeError)
    expect(() => selectInteractionTail(input, 0.5)).toThrow(RangeError)
  })

  it('accepts a matching Checkpoint boundary and rejects namespace or watermark drift', () => {
    const assembler = new CharacterContextAssembler()
    const emptyCheckpoint = checkpoint(0)
    const { checkpointHash: _emptyHash, ...checkpointBase } = emptyCheckpoint
    const checkpointWithCognitionBase = {
      ...checkpointBase,
      activeCognition: [{ kind: 'character-goal', id: 'goal:checkpoint', value: { status: 'active' }, sourceRef: source(1) }],
    }
    const cp = {
      ...checkpointWithCognitionBase,
      checkpointHash: hashContinuityCheckpoint(checkpointWithCognitionBase),
    }
    expect(assembler.assemble(request({ checkpoint: cp })).contextHash).toMatch(/^sha256:/)
    const otherAddress = { ...address, branchId: brandId('branch:other', 'BranchId') }
    const invalid: Partial<CharacterContextRequest>[] = [
      { characterView: { ...view(), address: otherAddress } },
      { cognition: { ...cognition(), address: otherAddress } },
      { tail: { ...tail(), address: otherAddress } },
      { recallPlan: { ...recall().plan, address: otherAddress } },
      { recall: { ...recall().result, receipt: { ...recall().result.receipt, watermark: { ...recall().result.receipt.watermark, address: otherAddress } } } },
      { characterView: { ...view(), characterId: brandId('character:bob', 'CharacterId') } },
      { cognition: { ...cognition(), characterId: brandId('character:bob', 'CharacterId') } },
      { tail: { ...tail(), characterId: brandId('character:bob', 'CharacterId') } },
      { recallPlan: { ...recall().plan, characterId: brandId('character:bob', 'CharacterId') } },
      { recall: { ...recall().result, receipt: { ...recall().result.receipt, watermark: { ...recall().result.receipt.watermark, characterId: brandId('character:bob', 'CharacterId') } } } },
      { characterView: view(19) },
      { cognition: cognition(19) },
      { tail: tail(2, 0, 19) },
      { sceneDecision: { ...request().sceneDecision, asOfSeq: 19 } },
      { recallPlan: { ...recall().plan, asOfWorldSeq: 19 } },
      { recall: { ...recall().result, receipt: { ...recall().result.receipt, watermark: { ...recall().result.receipt.watermark, verifiedThroughSeq: 19 } } } },
      { recall: { ...recall().result, receipt: { ...recall().result.receipt, watermark: { ...recall().result.receipt.watermark, capturedThroughSeq: 19 } } } },
      { checkpoint: { ...cp, address: otherAddress } },
      { checkpoint: { ...cp, characterId: brandId('character:bob', 'CharacterId') } },
      { checkpoint: { ...cp, asOfWorldSeq: 21 }, tail: tail(0, 21) },
      { checkpoint: cp, tail: tail(2, 1) },
      { checkpoint: null, tail: tail(2, 1) },
    ]
    for (const override of invalid) {
      expect(() => assembler.assemble(request(override))).toThrowError(expect.objectContaining({
        envelope: expect.objectContaining({ errorCode: 'CONTEXT_SOURCE_UNVERIFIED' }),
      }))
    }
  })

  it('rejects malformed identities, numeric watermarks, Tail ranges, and future sources', () => {
    const assembler = new CharacterContextAssembler()
    for (const override of [
      { participantId: ' padded ' }, { controllerId: '' }, { controllerEpoch: -1 },
      { baseHeadSeq: -1 }, { asOfWorldSeq: -1 }, { tick: -1 }, { baseHeadSeq: 21 },
    ] as Partial<CharacterContextRequest>[]) expect(() => assembler.assemble(request(override))).toThrow()
    expect(() => assembler.assemble(request({
      tail: { ...tail(), blocks: [{ ...block(0), startSeq: 0 }] },
    }))).toThrowError(expect.objectContaining({ envelope: expect.objectContaining({ errorCode: 'CONTEXT_SOURCE_UNVERIFIED' }) }))
    expect(() => assembler.assemble(request({ sceneSourceRefs: [source(21)] }))).toThrowError(expect.objectContaining({
      envelope: expect.objectContaining({ errorCode: 'CONTEXT_SOURCE_UNVERIFIED' }),
    }))
    expect(() => assembler.assemble(request({ contextProfileId: 'unknown' as never }))).toThrow('unknown Context Profile')
  })

  it('verifies every component and Recall receipt Hash before assembly', () => {
    const assembler = new CharacterContextAssembler()
    const baseline = request()
    const baselineRecall = baseline.recall as CognitiveRecallResult
    const invalid: Partial<CharacterContextRequest>[] = [
      { characterView: { ...baseline.characterView, bundleHash: manifestHash } },
      { cognition: { ...baseline.cognition, bundleHash: manifestHash } },
      { sceneDecision: { ...baseline.sceneDecision, decisionHash: manifestHash } },
      { tail: { ...baseline.tail, tailHash: manifestHash } },
      { recall: { ...baselineRecall, receipt: { ...baselineRecall.receipt, planHash: manifestHash } } },
      { recall: { ...baselineRecall, receipt: { ...baselineRecall.receipt, queryHash: manifestHash } } },
      { recall: { ...baselineRecall, receipt: { ...baselineRecall.receipt, resultHash: manifestHash } } },
      { recall: { ...baselineRecall, receipt: { ...baselineRecall.receipt, receiptHash: manifestHash } } },
      { recall: { ...baselineRecall, receipt: { ...baselineRecall.receipt, selectedSourceRefs: [] } } },
      { recall: { ...baselineRecall, receipt: { ...baselineRecall.receipt, ranking: [] } } },
      // A plan and a receipt from different generations must never be reinterpreted as one another.
      { recall: { ...baselineRecall, receipt: keywordRecall().result.receipt as never } },
      { stimulusHash: manifestHash },
      { affordanceHash: manifestHash },
    ]
    for (const override of invalid) {
      expect(() => assembler.assemble(request(override))).toThrowError(expect.objectContaining({
        envelope: expect.objectContaining({ errorCode: 'CONTEXT_SOURCE_UNVERIFIED' }),
      }))
    }
    const cp = checkpoint()
    expect(() => assembler.assemble(request({ checkpoint: { ...cp, checkpointHash: manifestHash } })))
      .toThrowError(expect.objectContaining({ envelope: expect.objectContaining({ errorCode: 'CONTEXT_SOURCE_UNVERIFIED' }) }))
  })

  it('verifies a keyword Recall receipt against the memories the Context actually uses', () => {
    const assembler = new CharacterContextAssembler()
    const keyword = keywordRecall(3)
    expect(assembler.assemble(request({ recallPlan: keyword.plan, recall: keyword.result })).segments)
      .toHaveLength(CHARACTER_CONTEXT_SEGMENT_KINDS.length)
    const receipt = keyword.result.receipt
    const tampered = [
      { ...receipt, planHash: manifestHash },
      { ...receipt, resultHash: manifestHash },
      { ...receipt, receiptHash: manifestHash },
      { ...receipt, selectedSourceRefs: [] },
      // Sequential ranks that name the returned memories in the wrong order.
      { ...receipt, ranking: [...receipt.ranking].reverse().map((entry, index) => ({ ...entry, rank: index + 1 })) },
      // Correct order but a rank sequence that does not start at one.
      { ...receipt, ranking: receipt.ranking.map((entry, index) => ({ ...entry, rank: index + 2 })) },
    ]
    for (const mutated of tampered) {
      expect(() => assembler.assemble(request({
        recallPlan: keyword.plan, recall: { ...keyword.result, receipt: mutated as never },
      }))).toThrowError(expect.objectContaining({
        envelope: expect.objectContaining({ errorCode: 'CONTEXT_SOURCE_UNVERIFIED' }),
      }))
    }
    // A v2 plan answered by a v1 receipt is refused before any field comparison.
    expect(() => assembler.assemble(request({
      recallPlan: keyword.plan, recall: { ...keyword.result, receipt: (request()).recall.receipt as never },
    }))).toThrowError(expect.objectContaining({
      envelope: expect.objectContaining({ errorCode: 'CONTEXT_SOURCE_UNVERIFIED' }),
    }))
  })

  it('fails instead of trimming current cognition, Checkpoint core, Scene core, or duplicate affordances', () => {
    const assembler = new CharacterContextAssembler()
    const claims = Array.from({ length: 9 }, (_, index) => cognitionRecord(
      'subjective-claim', `claim:${index}`, { status: 'active', awareness: 'conscious' }, index + 1,
    ))
    expect(() => assembler.assemble(request({ cognition: cognition(20, claims) }))).toThrowError(expect.objectContaining({
      envelope: expect.objectContaining({ errorCode: 'COGNITION_STATE_LIMIT' }),
    }))
    const cpBase = checkpoint()
    const cpInput = {
      ...cpBase,
      activeCognition: Array.from({ length: 13 }, (_, index) => ({
        kind: 'character-goal', id: `goal:${index}`, value: { status: 'active' }, sourceRef: source(index),
      })),
    }
    const { checkpointHash: _checkpointHash, ...withoutCheckpointHash } = cpInput
    const oversizedCheckpoint = {
      ...withoutCheckpointHash, checkpointHash: hashContinuityCheckpoint(withoutCheckpointHash),
    }
    expect(() => assembler.assemble(request({ checkpoint: oversizedCheckpoint }))).toThrowError(expect.objectContaining({
      envelope: expect.objectContaining({ errorCode: 'COGNITION_STATE_LIMIT' }),
    }))
    const oversizedSceneBase = { ...request().sceneDecision, memberIds: Array.from({ length: 17 }, (_, index) => `character:${index}` as never) }
    const { decisionHash: _decisionHash, ...sceneWithoutHash } = oversizedSceneBase
    const oversizedScene = { ...sceneWithoutHash, decisionHash: hashWorldJson('scene-decision/v2', sceneWithoutHash) }
    expect(() => assembler.assemble(request({ sceneDecision: oversizedScene }))).toThrowError(expect.objectContaining({
      envelope: expect.objectContaining({ errorCode: 'CONTEXT_WINDOW_EXCEEDED' }),
    }))
    expect(() => assembler.assemble(request({
      affordances: [{ actionType: 'speak', actionVersion: 1 }, { actionType: 'speak', actionVersion: 1 }],
    }))).toThrow('unique')
  })
})
