import { describe, expect, it } from 'vitest'
import {
  AFFECT_DURATIONS,
  AFFECT_EXPRESSION_MODES,
  AFFECT_TYPES,
  AWARENESS_LEVELS,
  CHARACTER_CONTEXT_SEGMENT_KINDS,
  CLAIM_STANCES,
  COMMITMENT_ORIGINS,
  COMMITMENT_STATUSES,
  DIRECTOR_DIRECTIVE_TYPES,
  DRAMATIC_SIGNAL_TYPES,
  GOAL_OBJECTIVE_KINDS,
  GOAL_STATUSES,
  OPEN_LOOP_KINDS,
  OPEN_LOOP_STATUSES,
  PHASE8_VOCABULARIES,
  PHASE8_VOCABULARY_LOCKS,
  PHASE8_VOCABULARY_REGISTRY_HASH,
  RELATIONSHIP_TYPES,
  TENSION_POLE_TENDENCIES,
  TENSION_RESOLUTION_KINDS,
  brandId,
  createContextSegment,
  createErrorEnvelope,
  hashCharacterContext,
  hashContextReceipt,
  hashDirectorContext,
  hashProviderRequest,
  hashWorldJson,
  type CharacterContextHashInput,
  type ContextReceiptInput,
  type ContextSegment,
  type DirectorPlanningContextHashInput,
  type ProviderRequestHashInput,
  type WorldAddress,
} from './index.ts'

const address: WorldAddress = {
  tenantId: brandId('tenant', 'TenantId'),
  worldId: brandId('world', 'WorldId'),
  branchId: brandId('main', 'BranchId'),
}

function contextFixture(): CharacterContextHashInput {
  return {
    schemaVersion: 'character-controller/v2',
    address,
    roundId: brandId('round', 'InteractionRoundId'),
    participantId: 'agent:alice',
    characterId: brandId('character:alice', 'CharacterId'),
    controllerId: 'scripted',
    controllerEpoch: 1,
    baseHeadSeq: 10,
    asOfWorldSeq: 10,
    tick: 2,
    manifestHash: hashWorldJson('manifest', { v: 4 }),
    contextProfileId: 'standard',
    segments: CHARACTER_CONTEXT_SEGMENT_KINDS.map((segmentKind, index) => (
      createContextSegment(segmentKind, { index }, [])
    )),
  }
}

function providerFixture(contextHash = hashCharacterContext(contextFixture())): ProviderRequestHashInput {
  return {
    schemaVersion: 'provider-request-hash/v1',
    contextHash,
    rendererId: 'renderer',
    rendererHash: hashWorldJson('renderer', { v: 1 }),
    toolSchemaId: 'submit_actions/v2',
    toolSchemaHash: hashWorldJson('tool', { v: 2 }),
    providerId: 'scripted',
    modelId: 'fixture',
    sampling: { temperaturePermille: 0 },
    providerUserPartitionValue: 'principal:abc',
    exactRequestUtf8Hex: Buffer.from('request').toString('hex'),
  }
}

function receiptFixture(): ContextReceiptInput {
  const context = contextFixture()
  const contextHash = hashCharacterContext(context)
  return {
    schemaVersion: 'context-receipt/v1',
    receiptId: brandId('receipt', 'ContextReceiptId'),
    address,
    roundId: context.roundId,
    participantKind: 'character',
    participantId: context.participantId,
    subjectCharacterId: context.characterId,
    controllerId: context.controllerId,
    controllerEpoch: context.controllerEpoch,
    baseHeadSeq: context.baseHeadSeq,
    asOfWorldSeq: context.asOfWorldSeq,
    tick: context.tick,
    manifestHash: context.manifestHash,
    contextProfileId: context.contextProfileId,
    contextProfileHash: hashWorldJson('profile', { id: 'standard' }),
    versionLocks: {
      contextSchema: 'character-controller/v2',
      contextReceiptSchema: 'context-receipt/v1',
      sceneDecisionSchema: 'scene-decision/v2',
      memorySchema: 'cognitive-memory/v2',
      checkpointSchema: 'continuity-checkpoint/v1',
      rendererSchema: 'character-controller-cache/v1',
    },
    componentHashes: {
      characterViewHash: hashWorldJson('view', { v: 1 }),
      sceneDecisionHash: hashWorldJson('scene', { v: 2 }),
      checkpointHash: null,
      tailHash: hashWorldJson('tail', []),
      recallHash: hashWorldJson('recall', []),
      affordanceHash: hashWorldJson('affordance', []),
    },
    includedSourceRefs: [],
    exclusions: [],
    contextHash,
    providerRequestHash: hashProviderRequest(providerFixture(contextHash)),
  }
}

function directorFixture(): DirectorPlanningContextHashInput {
  return {
    schemaVersion: 'director-planning/v1',
    address,
    roundId: brandId('round', 'InteractionRoundId'),
    participantId: 'director:scene:station',
    controllerId: 'scripted-director',
    controllerEpoch: 1,
    baseHeadSeq: 10,
    asOfWorldSeq: 10,
    tick: 2,
    manifestHash: hashWorldJson('manifest', { v: 4 }),
    focalSceneId: 'scene:station',
    publicContext: { status: 'waiting' },
    dramaticSignals: [{
      signalType: 'scene_stalled',
      sourceRefs: [{
        sourceKind: 'scene_public_event',
        sourceId: 'event:10',
        sourceSeq: 10,
        sourceHash: hashWorldJson('event', { seq: 10 }),
      }],
    }],
    environmentAffordances: ['weather.change'],
    directiveTargets: ['open-loop:departure'],
  }
}

describe('Phase 8 Basic v1 vocabularies', () => {
  it('freezes the complete vocabulary without compatibility aliases', () => {
    expect(AWARENESS_LEVELS).toEqual(['conscious', 'partially_conscious', 'unrecognized'])
    expect(CLAIM_STANCES).toEqual(['believed', 'suspected', 'doubted', 'denied'])
    expect(RELATIONSHIP_TYPES).toEqual([
      'affection', 'trust', 'distrust', 'respect', 'dependence',
      'obligation', 'resentment', 'fear', 'envy', 'rivalry',
    ])
    expect(AFFECT_TYPES).toEqual([
      'joy', 'sadness', 'anger', 'fear', 'anxiety', 'shame', 'guilt',
      'relief', 'hope', 'disgust', 'pride', 'loneliness', 'surprise', 'curiosity',
    ])
    expect(AFFECT_EXPRESSION_MODES).toEqual(['concealed', 'restrained', 'leaking', 'overt'])
    expect(AFFECT_DURATIONS).toEqual(['momentary', 'short_lived', 'sustained', 'persistent_until_resolved'])
    expect(TENSION_POLE_TENDENCIES).toEqual(['pursue', 'avoid', 'preserve', 'change', 'express', 'conceal'])
    expect(TENSION_RESOLUTION_KINDS).toEqual([
      'choice_made', 'integrated', 'external_condition_changed', 'source_state_resolved', 'superseded',
    ])
    expect(GOAL_OBJECTIVE_KINDS).toEqual(['registered', 'narrative'])
    expect(GOAL_STATUSES).toEqual(['active', 'blocked', 'completed', 'abandoned', 'failed'])
    expect(COMMITMENT_ORIGINS).toEqual(['promise', 'agreement', 'accepted_request', 'duty', 'self_commitment'])
    expect(COMMITMENT_STATUSES).toEqual(['active', 'fulfilled', 'breached', 'released', 'renounced'])
    expect(OPEN_LOOP_KINDS).toEqual(['question', 'request', 'offer', 'decision_pending', 'follow_up'])
    expect(OPEN_LOOP_STATUSES).toEqual(['open', 'answered', 'resolved', 'dismissed', 'expired'])
    expect(JSON.stringify(PHASE8_VOCABULARIES)).not.toContain('mistaken')
    expect(Object.isFrozen(AWARENESS_LEVELS)).toBe(true)
    expect(Object.isFrozen(PHASE8_VOCABULARIES)).toBe(true)
    expect(PHASE8_VOCABULARIES.every(entry => Object.isFrozen(entry) && Object.isFrozen(entry.termGroups))).toBe(true)
    expect(DRAMATIC_SIGNAL_TYPES).toEqual([
      'scene_stalled', 'open_loop_high_priority', 'conflict_pressure_high', 'participant_unavailable',
    ])
    expect(DIRECTOR_DIRECTIVE_TYPES).toEqual([
      'take_initiative', 'address_open_loop', 'attend_to_visible_entity', 'consider_active_goal',
      'deescalate', 'maintain_restraint', 'pause_and_observe',
    ])
    expect(Object.isFrozen(DRAMATIC_SIGNAL_TYPES) && Object.isFrozen(DIRECTOR_DIRECTIVE_TYPES)).toBe(true)
  })

  it('matches the domain-separated vocabulary registry Golden', () => {
    expect(PHASE8_VOCABULARY_LOCKS).toEqual([
      { vocabularyId: 'cognition-basic/v1', vocabularyHash: 'sha256:19a60df85f7f2868c9b1108ef4b31cdfe813b2603a9798210f22b92d7958c67f' },
      { vocabularyId: 'relationship-basic/v1', vocabularyHash: 'sha256:5009614e777f685fab0f97b81ddb0017c50666cb898aa9b724e2c0ffad069dbd' },
      { vocabularyId: 'affect-basic/v1', vocabularyHash: 'sha256:192aa902c51a90824502599e29ed863ee51e68d4683572e6a0790211fa15f106' },
      { vocabularyId: 'inner-tension-basic/v1', vocabularyHash: 'sha256:934ee4640a8ee1dc35a56333fdad8e6f1cff863c35f0dd0753bc301a969aed47' },
    ])
    expect(PHASE8_VOCABULARY_REGISTRY_HASH)
      .toBe('sha256:6d9f4c810955104568d2d11176b92b8179ba40254ca55bef80b66b83363b7c93')
  })

  it('exposes every Phase 8 failure as a canonical ErrorEnvelope code', () => {
    const codes = [
      'COGNITION_VOCABULARY_UNAVAILABLE', 'COGNITION_STATE_LIMIT', 'REFLECTION_SOURCE_FORBIDDEN',
      'CONTEXT_SOURCE_UNVERIFIED', 'CONTEXT_REBUILD_DIVERGED', 'MEMORY_CATCHUP_FAILED',
      'MODEL_PROFILE_INCOMPATIBLE', 'TOKEN_COUNTER_UNAVAILABLE', 'OUTPUT_RESERVE_INSUFFICIENT',
      'PROVIDER_CALL_AMBIGUOUS',
    ] as const
    expect(codes.map(errorCode => createErrorEnvelope({
      errorCode,
      category: errorCode === 'PROVIDER_CALL_AMBIGUOUS' ? 'provider' : 'runtime',
      message: errorCode,
      retryable: false,
      correlationId: `phase8:${errorCode}`,
    }).errorCode)).toEqual(codes)
  })
})

describe('Phase 8 Context and request hashes', () => {
  it('matches exact segment, semantic Context, Provider request, and receipt Goldens', () => {
    const context = contextFixture()
    expect(context.segments.map(segment => segment.segmentHash)).toEqual([
      'sha256:0bf0d485fd2ff40a54fdac04d34359c08d501ce3424cf9b3fabeba3342c9307a',
      'sha256:d05cf1208f8af2c37b278fcdebe43349f22f2443b74e70349aa5c49894304992',
      'sha256:28d12c58f2f8d7f3dc0c1efc02646c7a69bda38e1bc6a0d4494cdab84f303ab5',
      'sha256:f688f0e835c863788f9ce8bc59d38bf0cb1b1fd7e7a58024030ead178026006e',
      'sha256:99b56b3c6fd58361eb1e036484105720075bbb339d51575ed7a831d660847c80',
      'sha256:4eb580bbeac9be3a90f95b6c49dfef30c51dcfd0d91fc47715ed0751c4a0b8b4',
      'sha256:086e2aca40206d7ccd8811fd77a1635e87d4ff87c3c08f7677a7ad062704cf11',
      'sha256:3e7b2fc35f1503d05e0ff89101d273bcc1da699cc869925223858b65e5a42ded',
      'sha256:01dc65dfae930e5f12657a21e78825c9fba170dcd5ee2efc7c68de1281f40749',
      'sha256:9535b7ed6feb835001fa89308877d001b36f528f506e529f363c3d9b14126cd4',
      'sha256:f371795536deac2ca89d2ddea227c2ce94d8ba034b18779289f72f55392dedb6',
      'sha256:6da0fd33a59c949688ce627cc6f5ba02d1b409f316a33b932b6a79f037624dfa',
    ])
    expect(hashCharacterContext(context))
      .toBe('sha256:86ffe7968244020d69bb77a9503ef5ef42af851c51c2acd52d1e84072dfa8626')
    expect(hashProviderRequest(providerFixture()))
      .toBe('sha256:662c08d8c374942ec5f421d86f35bbb733cd77f2360fc7acd2c1ec4f32f3c381')
    expect(hashContextReceipt(receiptFixture()))
      .toBe('sha256:882ed4cc813761da4cfa7f7b24c0de5438e6eccb340e5fc91c88b477cc218fb8')
    expect(Object.isFrozen(CHARACTER_CONTEXT_SEGMENT_KINDS)).toBe(true)
    expect(context.segments.every(segment => Object.isFrozen(segment) && Object.isFrozen(segment.sourceRefs))).toBe(true)
  })

  it('keeps Director planning context separate from Character context', () => {
    const director = directorFixture()
    const baseline = hashDirectorContext(director)
    expect(baseline).toBe('sha256:53be0b8db5bd14c4c8237ce10afc89871c7054d2404fd6e3f117b2989a02514f')
    expect(hashDirectorContext({ ...director, focalSceneId: 'scene:road' })).not.toBe(baseline)
    expect(hashDirectorContext({ ...director, dramaticSignals: [] })).not.toBe(baseline)
    expect(hashDirectorContext({ ...director, transportTraceId: 'ignored' } as DirectorPlanningContextHashInput))
      .toBe(baseline)
  })

  it('rejects unknown, missing, reordered, and hash-diverged Context segments', () => {
    expect(() => createContextSegment('secret' as never, null, [])).toThrow('unknown')
    const context = contextFixture()
    expect(() => hashCharacterContext({ ...context, segments: context.segments.slice(1) })).toThrow('every fixed segment')
    const reordered = [...context.segments]
    ;[reordered[0], reordered[1]] = [reordered[1]!, reordered[0]!]
    expect(() => hashCharacterContext({ ...context, segments: reordered })).toThrow('must be host_protocol')
    const first = context.segments[0]!
    const diverged: ContextSegment = { ...first, segmentHash: hashWorldJson('wrong', null) }
    expect(() => hashCharacterContext({ ...context, segments: [diverged, ...context.segments.slice(1)] }))
      .toThrow('hash diverged')
  })

  it('separates semantic Context changes from Provider layout and transport metadata', () => {
    const context = contextFixture()
    const contextHash = hashCharacterContext(context)
    const semanticChange = hashCharacterContext({ ...context, participantId: 'agent:bob' })
    expect(semanticChange).not.toBe(contextHash)

    const provider = providerFixture(contextHash)
    const baseline = hashProviderRequest(provider)
    expect(hashProviderRequest({ ...provider, contextHash: semanticChange })).not.toBe(baseline)
    expect(hashProviderRequest({ ...provider, rendererId: 'renderer:v2' })).not.toBe(baseline)
    expect(hashProviderRequest({ ...provider, toolSchemaId: 'submit_actions/v3' })).not.toBe(baseline)
    expect(hashProviderRequest({ ...provider, providerId: 'other-provider' })).not.toBe(baseline)
    expect(hashProviderRequest({ ...provider, modelId: 'other-model' })).not.toBe(baseline)
    expect(hashProviderRequest({ ...provider, providerUserPartitionValue: 'principal:def' })).not.toBe(baseline)
    expect(hashProviderRequest({ ...provider, sampling: { temperaturePermille: 1 } })).not.toBe(baseline)
    expect(hashProviderRequest({ ...provider, exactRequestUtf8Hex: Buffer.from('request!').toString('hex') })).not.toBe(baseline)

    const transportDecorated = {
      ...provider,
      apiCredential: 'secret-canary',
      timeoutMs: 1,
      traceId: 'trace',
      cacheHit: true,
      retryCount: 9,
    }
    expect(hashProviderRequest(transportDecorated)).toBe(baseline)
  })

  it('rejects unsafe request identities and malformed exact bytes', () => {
    const provider = providerFixture()
    expect(() => hashProviderRequest({ ...provider, rendererId: ' padded ' })).toThrow('unpadded')
    expect(() => hashProviderRequest({ ...provider, exactRequestUtf8Hex: '' })).toThrow('hexadecimal')
    expect(() => hashProviderRequest({ ...provider, exactRequestUtf8Hex: 'abc' })).toThrow('hexadecimal')
    expect(() => hashProviderRequest({ ...provider, exactRequestUtf8Hex: 'GG' })).toThrow('hexadecimal')
  })

  it('binds receipt provenance independently of the Context and Provider hashes', () => {
    const receipt = receiptFixture()
    const baseline = hashContextReceipt(receipt)
    expect(hashContextReceipt({
      ...receipt,
      exclusions: [{ reason: 'budget_trimmed', sourceRefHash: hashWorldJson('source', { id: 1 }) }],
    })).not.toBe(baseline)
    expect(hashContextReceipt({ ...receipt, participantKind: 'director', subjectCharacterId: null })).not.toBe(baseline)
  })
})
