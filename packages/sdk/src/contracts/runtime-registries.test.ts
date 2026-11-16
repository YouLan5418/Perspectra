import { describe, expect, it } from 'vitest'
import { hashWorldJson } from './world-json.ts'
import {
  CONTEXT_PROFILES,
  PROVIDER_QUALITY_PROFILE,
  REFLECTION_PROFILE,
  RUNTIME_REGISTRIES,
  RUNTIME_REGISTRY_LOCKS,
  RUNTIME_REGISTRY_SET_HASH,
  SUBMIT_ACTIONS_PROFILE,
} from './runtime-registries.ts'

describe('Runtime registries', () => {
  it('freezes the exact compact, standard, and deep capacity profiles', () => {
    expect(CONTEXT_PROFILES.map(profile => profile.profileId)).toEqual(['compact', 'standard', 'deep'])
    expect(CONTEXT_PROFILES.map(profile => profile.maximumRequestBytes)).toEqual([32768, 98304, 196608])
    expect(CONTEXT_PROFILES[0]).toMatchObject({
      recentInteractionBlocks: 4,
      recallResults: 6,
      checkpointActiveCognition: 12,
      sceneVisibleSubjects: 16,
      activeClaims: 8,
      activeGoals: 4,
      relationshipFacets: 8,
      activeAffects: 4,
      activeInnerTensions: 2,
      activeCommitments: 4,
      openLoops: 6,
    })
    expect(CONTEXT_PROFILES[2]).toMatchObject({
      recentInteractionBlocks: 20,
      recallResults: 32,
      checkpointActiveCognition: 64,
      sceneVisibleSubjects: 96,
      activeClaims: 32,
      activeGoals: 16,
      relationshipFacets: 32,
      activeAffects: 12,
      activeInnerTensions: 8,
      activeCommitments: 16,
      openLoops: 24,
    })
  })

  it('freezes the standard Reflection policy limits', () => {
    expect(REFLECTION_PROFILE).toEqual({
      profileId: 'standard',
      maximumOperations: 4,
      maximumNewActivePerKind: 2,
      maximumMagnitudeChangePermille: 200,
      maximumNarrativeBytesPerOperation: 4096,
      maximumNarrativeBytesPerBatch: 16384,
    })
    expect(Object.isFrozen(REFLECTION_PROFILE)).toBe(true)
  })

  it('exposes the exact Provider quality and submit_actions registry contracts to runtime code', () => {
    expect(PROVIDER_QUALITY_PROFILE).toEqual({
      schemaVersion: 'provider-quality/v1',
      invalidReflectionThreshold: 3,
      reflectionPauseEligibleTicks: 4,
      invalidResponseThreshold: 3,
      probeBackoffEligibleTicks: [1, 2, 4, 8],
    })
    expect(SUBMIT_ACTIONS_PROFILE).toEqual({
      schemaVersion: 'submit_actions/v2',
      maximumExternalActions: 2,
      maximumReflectionOperations: 4,
    })
    expect(Object.isFrozen(PROVIDER_QUALITY_PROFILE)).toBe(true)
    expect(Object.isFrozen(PROVIDER_QUALITY_PROFILE.probeBackoffEligibleTicks)).toBe(true)
    expect(Object.isFrozen(SUBMIT_ACTIONS_PROFILE)).toBe(true)
  })

  it('locks every runtime registry with domain-separated hashes', () => {
    expect(RUNTIME_REGISTRIES.map(registry => registry.registryId)).toEqual([
      'context-registry/v1',
      'scene-registry/v1',
      'memory-registry/v1',
      'cognitive-policy-registry/v1',
      'renderer-registry/v1',
      'tool-schema-registry/v1',
      'context-profile-registry/v1',
    ])
    expect(RUNTIME_REGISTRY_LOCKS).toHaveLength(RUNTIME_REGISTRIES.length)
    for (const [index, registry] of RUNTIME_REGISTRIES.entries()) {
      expect(Object.isFrozen(registry)).toBe(true)
      expect(Object.isFrozen(registry.members)).toBe(true)
      expect(RUNTIME_REGISTRY_LOCKS[index]).toEqual({
        registryId: registry.registryId,
        version: '1.0.0',
        registryHash: hashWorldJson('phase8-registry/v1', registry),
      })
    }
    expect(RUNTIME_REGISTRY_SET_HASH).toBe('sha256:a810b8d50789bcc664b62ba78d855690929c2ea1f4846e70ca8f20512eb0f0a1')
  })

  it('keeps all registry structures deeply immutable at their public boundaries', () => {
    expect(Object.isFrozen(CONTEXT_PROFILES)).toBe(true)
    expect(CONTEXT_PROFILES.every(profile => Object.isFrozen(profile))).toBe(true)
    expect(Object.isFrozen(RUNTIME_REGISTRIES)).toBe(true)
    expect(RUNTIME_REGISTRIES.every(registry => registry.members.every(member => Object.isFrozen(member)))).toBe(true)
    expect(Object.isFrozen(RUNTIME_REGISTRY_LOCKS)).toBe(true)
    expect(RUNTIME_REGISTRY_LOCKS.every(lock => Object.isFrozen(lock))).toBe(true)
  })
})
