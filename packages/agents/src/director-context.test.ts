import { describe, expect, it } from 'vitest'
import {
  brandId,
  hashWorldJson,
  type ContextSourceRef,
  type WorldAddress,
} from '@harness-world/contracts'
import { DirectorContextAssembler, type DirectorContextRequest } from './director-context.ts'

const address: WorldAddress = {
  tenantId: brandId('tenant:director-context', 'TenantId'),
  worldId: brandId('world:director-context', 'WorldId'),
  branchId: brandId('branch:main', 'BranchId'),
}

function source(sourceKind: string, sourceSeq: number, sourceId = `${sourceKind}:${sourceSeq}`): ContextSourceRef {
  return { sourceKind, sourceId, sourceSeq, sourceHash: hashWorldJson('director-source', { sourceKind, sourceSeq, sourceId }) }
}

function request(overrides: Partial<DirectorContextRequest> = {}): DirectorContextRequest {
  const sceneInput = {
    schemaVersion: 'scene-decision/v2' as const,
    sceneId: 'scene:station', memberIds: ['character:alice', 'character:bob'] as never,
    observerIds: ['character:alice', 'character:bob'] as never,
    schedulableCharacterIds: ['character:bob'] as never,
    visibleResultCharacterIds: ['character:alice', 'character:bob'] as never,
    directorEligible: true, asOfSeq: 10,
  }
  return {
    address,
    roundId: brandId('round:director', 'InteractionRoundId'),
    participantId: 'director:station', controllerId: 'scripted-director', controllerEpoch: 1,
    baseHeadSeq: 10, asOfWorldSeq: 10, tick: 2,
    manifestHash: hashWorldJson('manifest', { version: 4 }), contextProfileId: 'compact',
    sceneDecision: { ...sceneInput, decisionHash: hashWorldJson('scene-decision/v2', sceneInput) },
    publicEntries: [
      { entryId: 'public:weather', value: { weather: 'rain' }, sourceRef: source('scene_public_event', 2) },
      { entryId: 'public:loop', value: { openLoop: 'departure delayed' }, sourceRef: source('director_visible', 3) },
    ],
    dramaticSignals: [
      { signalType: 'participant_unavailable', sourceRefs: [source('runtime_availability', 5)] },
      { signalType: 'scene_stalled', sourceRefs: [source('scene_public_event', 4)] },
    ],
    environmentAffordances: ['weather.change', 'announcement.emit'],
    directiveTargets: [
      { targetId: 'open-loop:departure', sourceRef: source('director_visible', 3) },
      { targetId: 'character:bob', sourceRef: source('runtime_health', 6) },
    ],
    correlationId: 'director-context:test',
    ...overrides,
  }
}

describe('DirectorContextAssembler', () => {
  it('builds one stable focal-Scene context from public and explicitly director-visible sources', () => {
    const assembler = new DirectorContextAssembler()
    const detailed = assembler.assembleDetailed(request())
    expect(assembler.assemble(request())).toEqual(detailed.context)
    expect(detailed.context).toMatchObject({
      schemaVersion: 'director-planning/v1', focalSceneId: 'scene:station',
      environmentAffordances: ['announcement.emit', 'weather.change'],
      directiveTargets: ['character:bob', 'open-loop:departure'],
    })
    expect(detailed.context.dramaticSignals.map(signal => signal.signalType)).toEqual([
      'participant_unavailable', 'scene_stalled',
    ])
    expect(detailed.includedSourceRefs.map(ref => ref.sourceSeq)).toEqual([2, 3, 4, 5, 6])
    expect(detailed.exclusions).toEqual([])
    expect(detailed.context.contextHash).toMatch(/^sha256:/)
  })

  it('rejects private, future, unknown, and structurally secret sources before aggregation', () => {
    const assembler = new DirectorContextAssembler()
    const invalidSources = [source('character_private', 1), source('cognitive_memory', 1), source('scene_public_event', 11)]
    for (const invalid of invalidSources) {
      expect(() => assembler.assemble(request({
        publicEntries: [{ entryId: 'bad', value: { public: true }, sourceRef: invalid }],
      }))).toThrowError(expect.objectContaining({
        envelope: expect.objectContaining({ errorCode: 'CONTEXT_SOURCE_UNVERIFIED' }),
      }))
      expect(() => assembler.assemble(request({
        dramaticSignals: [{ signalType: 'scene_stalled', sourceRefs: [invalid] }],
      }))).toThrowError(expect.objectContaining({
        envelope: expect.objectContaining({ errorCode: 'CONTEXT_SOURCE_UNVERIFIED' }),
      }))
      expect(() => assembler.assemble(request({
        directiveTargets: [{ targetId: 'target:bad', sourceRef: invalid }],
      }))).toThrowError(expect.objectContaining({
        envelope: expect.objectContaining({ errorCode: 'CONTEXT_SOURCE_UNVERIFIED' }),
      }))
    }
    for (const forbidden of [
      { secret: 'CANARY' },
      { nested: { latentGuidance: true } },
      { nested: [{ rawMemory: 'CANARY' }] },
      { authorTruth: true }, { memoryRecall: [] }, { privateClaim: {} }, { privateAffect: {} }, { privateTension: {} },
    ]) {
      expect(() => assembler.assemble(request({
        publicEntries: [{ entryId: 'bad', value: forbidden, sourceRef: source('scene_public_event', 1) }],
      }))).toThrow('forbidden')
    }
  })

  it('requires one exact, eligible, hash-verified focal Scene', () => {
    const assembler = new DirectorContextAssembler()
    const scene = request().sceneDecision
    for (const invalidScene of [
      { ...scene, schemaVersion: 'scene-decision/v1' as never },
      { ...scene, sceneId: null },
      { ...scene, directorEligible: false },
      { ...scene, asOfSeq: 9 },
    ]) {
      expect(() => assembler.assemble(request({ sceneDecision: invalidScene }))).toThrowError(expect.objectContaining({
        envelope: expect.objectContaining({ errorCode: 'CONTEXT_SOURCE_UNVERIFIED' }),
      }))
    }
    expect(() => assembler.assemble(request({ sceneDecision: { ...scene, decisionHash: hashWorldJson('wrong', null) } })))
      .toThrowError(expect.objectContaining({ envelope: expect.objectContaining({ errorCode: 'CONTEXT_SOURCE_UNVERIFIED' }) }))
  })

  it('validates controller identities and numeric watermarks', () => {
    const assembler = new DirectorContextAssembler()
    for (const override of [
      { participantId: ' padded ' }, { controllerId: '' }, { controllerEpoch: -1 },
      { baseHeadSeq: -1 }, { asOfWorldSeq: -1 }, { tick: -1 }, { baseHeadSeq: 11 },
    ] as Partial<DirectorContextRequest>[]) expect(() => assembler.assemble(request(override))).toThrow()
  })

  it('rejects duplicate or malformed public entries, signals, affordances, and targets', () => {
    const assembler = new DirectorContextAssembler()
    const publicEntry = request().publicEntries[0]!
    expect(() => assembler.assemble(request({ publicEntries: [publicEntry, publicEntry] }))).toThrow('unique')
    expect(() => assembler.assemble(request({ publicEntries: [{ ...publicEntry, entryId: '' }] }))).toThrow('entryId')
    expect(() => assembler.assemble(request({ dramaticSignals: [{ signalType: 'unknown' as never, sourceRefs: [] }] })))
      .toThrow('unknown')
    const signal = request().dramaticSignals[0]!
    expect(() => assembler.assemble(request({ dramaticSignals: [signal, signal] }))).toThrow('unique')
    expect(() => assembler.assemble(request({ environmentAffordances: ['same', 'same'] }))).toThrow('unique')
    expect(() => assembler.assemble(request({ environmentAffordances: [''] }))).toThrow('environmentAffordance')
    const target = request().directiveTargets[0]!
    expect(() => assembler.assemble(request({ directiveTargets: [target, target] }))).toThrow('unique')
    expect(() => assembler.assemble(request({ directiveTargets: [{ ...target, targetId: '' }] }))).toThrow('targetId')
  })

  it('sorts and deduplicates source references without changing authorized content', () => {
    const assembler = new DirectorContextAssembler()
    const duplicate = source('scene_public_event', 4)
    const sameSeqDifferentKind = source('director_visible', 4)
    const sameSeqDifferentId = source('scene_public_event', 4, 'scene_public_event:z')
    const context = assembler.assembleDetailed(request({
      dramaticSignals: [
        { signalType: 'scene_stalled', sourceRefs: [] },
        { signalType: 'scene_stalled', sourceRefs: [duplicate, duplicate, sameSeqDifferentKind, sameSeqDifferentId] },
      ],
      publicEntries: [], directiveTargets: [], environmentAffordances: [],
    }))
    expect(context.context.dramaticSignals).toHaveLength(2)
    expect(context.includedSourceRefs.map(ref => ref.sourceId)).toEqual([
      'director_visible:4', 'scene_public_event:4', 'scene_public_event:z',
    ])
  })
})
