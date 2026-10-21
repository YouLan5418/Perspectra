import { describe, expect, it } from 'vitest'
import {
  AFFECT_DURATIONS,
  AFFECT_EXPRESSION_MODES,
  AFFECT_TYPES,
  AWARENESS_LEVELS,
  CLAIM_STANCES,
  COMMITMENT_ORIGINS,
  COMMITMENT_STATUSES,
  GOAL_OBJECTIVE_KINDS,
  COGNITIVE_EPISTEMIC_KINDS,
  COGNITIVE_MEMORY_KINDS,
  GOAL_STATUSES,
  OPEN_LOOP_KINDS,
  OPEN_LOOP_STATUSES,
  BASIC_VOCABULARIES,
  BASIC_VOCABULARY_LOCKS,
  BASIC_VOCABULARY_REGISTRY_HASH,
  RELATIONSHIP_TYPES,
  TENSION_POLE_TENDENCIES,
  TENSION_RESOLUTION_KINDS,
  createErrorEnvelope,
} from './index.ts'

describe('Basic v1 cognition vocabularies', () => {
  it('freezes the complete vocabulary without compatibility aliases', () => {
    expect(AWARENESS_LEVELS).toEqual(['conscious', 'partially_conscious', 'unrecognized'])
    expect(CLAIM_STANCES).toEqual(['believed', 'suspected', 'doubted', 'denied'])
    expect(RELATIONSHIP_TYPES).toEqual([
      'affection',
      'trust',
      'distrust',
      'respect',
      'dependence',
      'obligation',
      'resentment',
      'fear',
      'envy',
      'rivalry',
    ])
    expect(AFFECT_TYPES).toEqual([
      'joy',
      'sadness',
      'anger',
      'fear',
      'anxiety',
      'shame',
      'guilt',
      'relief',
      'hope',
      'disgust',
      'pride',
      'loneliness',
      'surprise',
      'curiosity',
    ])
    expect(AFFECT_EXPRESSION_MODES).toEqual(['concealed', 'restrained', 'leaking', 'overt'])
    expect(AFFECT_DURATIONS).toEqual(['momentary', 'short_lived', 'sustained', 'persistent_until_resolved'])
    expect(TENSION_POLE_TENDENCIES).toEqual(['pursue', 'avoid', 'preserve', 'change', 'express', 'conceal'])
    expect(TENSION_RESOLUTION_KINDS).toEqual([
      'choice_made',
      'integrated',
      'external_condition_changed',
      'source_state_resolved',
      'superseded',
    ])
    expect(GOAL_OBJECTIVE_KINDS).toEqual(['registered', 'narrative'])
    expect(COGNITIVE_MEMORY_KINDS).toEqual(['episodic', 'communication', 'belief', 'intention'])
    expect(COGNITIVE_EPISTEMIC_KINDS).toEqual([
      'direct_observation',
      'observed_action',
      'reported_speech',
      'subjective_inference',
      'self_intention',
      'derived_summary',
    ])
    expect(GOAL_STATUSES).toEqual(['active', 'blocked', 'completed', 'abandoned', 'failed'])
    expect(COMMITMENT_ORIGINS).toEqual(['promise', 'agreement', 'accepted_request', 'duty', 'self_commitment'])
    expect(COMMITMENT_STATUSES).toEqual(['active', 'fulfilled', 'breached', 'released', 'renounced'])
    expect(OPEN_LOOP_KINDS).toEqual(['question', 'request', 'offer', 'decision_pending', 'follow_up'])
    expect(OPEN_LOOP_STATUSES).toEqual(['open', 'answered', 'resolved', 'dismissed', 'expired'])
    expect(JSON.stringify(BASIC_VOCABULARIES)).not.toContain('mistaken')
    expect(Object.isFrozen(AWARENESS_LEVELS)).toBe(true)
    expect(Object.isFrozen(BASIC_VOCABULARIES)).toBe(true)
    expect(BASIC_VOCABULARIES.every(entry => Object.isFrozen(entry) && Object.isFrozen(entry.termGroups))).toBe(true)
  })

  it('matches the domain-separated vocabulary registry Golden', () => {
    expect(BASIC_VOCABULARY_LOCKS).toEqual([
      {
        vocabularyId: 'cognition-basic/v1',
        vocabularyHash: 'sha256:19a60df85f7f2868c9b1108ef4b31cdfe813b2603a9798210f22b92d7958c67f',
      },
      {
        vocabularyId: 'relationship-basic/v1',
        vocabularyHash: 'sha256:5009614e777f685fab0f97b81ddb0017c50666cb898aa9b724e2c0ffad069dbd',
      },
      {
        vocabularyId: 'affect-basic/v1',
        vocabularyHash: 'sha256:192aa902c51a90824502599e29ed863ee51e68d4683572e6a0790211fa15f106',
      },
      {
        vocabularyId: 'inner-tension-basic/v1',
        vocabularyHash: 'sha256:934ee4640a8ee1dc35a56333fdad8e6f1cff863c35f0dd0753bc301a969aed47',
      },
    ])
    expect(BASIC_VOCABULARY_REGISTRY_HASH).toBe(
      'sha256:6d9f4c810955104568d2d11176b92b8179ba40254ca55bef80b66b83363b7c93',
    )
  })

  it('exposes every Phase 8 failure as a canonical ErrorEnvelope code', () => {
    const codes = [
      'COGNITION_VOCABULARY_UNAVAILABLE',
      'COGNITION_STATE_LIMIT',
      'REFLECTION_SOURCE_FORBIDDEN',
      'CONTEXT_SOURCE_UNVERIFIED',
      'CONTEXT_REBUILD_DIVERGED',
      'MEMORY_CATCHUP_FAILED',
      'MODEL_PROFILE_INCOMPATIBLE',
      'TOKEN_COUNTER_UNAVAILABLE',
      'OUTPUT_RESERVE_INSUFFICIENT',
      'PROVIDER_CALL_AMBIGUOUS',
    ] as const
    expect(
      codes.map(
        errorCode =>
          createErrorEnvelope({
            errorCode,
            category: errorCode === 'PROVIDER_CALL_AMBIGUOUS' ? 'provider' : 'runtime',
            message: errorCode,
            retryable: false,
            correlationId: `phase8:${errorCode}`,
          }).errorCode,
      ),
    ).toEqual(codes)
  })
})
