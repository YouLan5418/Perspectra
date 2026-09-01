import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import {
  brandId,
  deterministicId,
  hashWorldJson,
  PHASE8_REGISTRY_LOCKS,
  PHASE8_VOCABULARY_LOCKS,
  type WorldJsonValue,
} from '@harness-world/contracts'
import { WorldStore } from '@harness-world/store-sqlite'
import { WorldBootstrap } from './world-bootstrap.ts'
import {
  reactionPolicyFromManifest,
  runtimeManifestFromStored,
  runtimeManifestFromStoredRecord,
  WorldSpecCompiler,
  type CompiledWorldManifestV5,
  type CompiledWorldSpec,
} from './world-spec.ts'

const directories: string[] = []

function database(name: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'hcw-kernel-'))
  directories.push(directory)
  return join(directory, name)
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function spec() {
  return {
    schemaVersion: 1,
    address: { tenantId: 'tenant:spec', worldId: 'world:spec', branchId: 'branch:main' },
    timeMode: 'TURN_DRIVEN',
    roundQueueLimit: 8,
    rulebook: { rulebookId: 'builtin:speak-move', version: 1 },
    locations: [
      { locationId: 'location:z', name: 'Zed' },
      { locationId: 'location:a', name: 'Alpha' },
    ],
    characters: [
      { characterId: 'character:b', name: 'Beta', locationId: 'location:z' },
      { characterId: 'character:a', name: 'Alpha', locationId: 'location:a' },
    ],
    playerBindings: [
      { principalId: 'principal:b', characterId: 'character:b', sessionId: 'session:b' },
      { principalId: 'principal:a', characterId: 'character:a', sessionId: 'session:a' },
    ],
    plugins: [
      { pluginId: 'plugin:z', version: '2.0.0-rc.1' },
      { pluginId: 'plugin:a', version: '1.0.0' },
    ],
  }
}

function specV2() {
  return {
    schemaVersion: 2,
    address: { tenantId: 'tenant:spec', worldId: 'world:spec', branchId: 'branch:main' },
    metadata: { title: 'Specification World', description: 'complete frozen contract' },
    timeMode: 'TURN_DRIVEN',
    roundQueueLimit: 8,
    runtimePolicy: { npcInitialAvailability: 'provisioning', playerInitialAvailability: 'ready' },
    rulebook: { rulebookId: 'builtin:speak-move', version: 1 },
    locations: [{ locationId: 'location:a', name: 'Alpha' }],
    entities: [{ entityId: 'entity:key', locationId: 'location:a', kind: 'key' }],
    characters: [{ characterId: 'character:a', name: 'Alpha', locationId: 'location:a' }],
    scenes: [{ sceneId: 'scene:a', participantIds: ['character:a'] }],
    goals: [{ goalId: 'goal:a', characterId: 'character:a', value: { intent: 'explore' } }],
    claims: [{ claimId: 'claim:a', characterId: 'character:a', value: { proposition: 'key exists' } }],
    observations: [{ observationId: 'observation:a', observerId: 'character:a', value: { content: 'a key' } }],
    playerBindings: [{ principalId: 'principal:a', characterId: 'character:a', sessionId: 'session:a' }],
    plugins: [{ pluginId: 'plugin:a', version: '1.0.0' }],
  }
}

function activation(compiled: CompiledWorldSpec) {
  const identity = { address: compiled.manifest.address, manifestHash: compiled.manifestHash, genesisHash: compiled.genesisHash }
  return {
    address: compiled.manifest.address,
    manifest: compiled.manifest,
    manifestHash: compiled.manifestHash,
    genesisEvents: compiled.genesisEvents,
    genesisHash: compiled.genesisHash,
    transactionId: brandId(deterministicId('transaction:genesis', identity), 'TransactionId'),
    roundId: brandId(deterministicId('round:genesis', identity), 'InteractionRoundId'),
    correlationId: 'test-genesis',
  }
}

describe('WorldSpecCompiler and WorldBootstrap', () => {
  it('derives a V2 runtime view from immutable stored V1 Manifest bytes', () => {
    const legacy = spec() as unknown as WorldJsonValue
    const runtime = runtimeManifestFromStored(legacy)
    expect(runtime).toMatchObject({
      schemaVersion: 2,
      runtimePolicy: { npcInitialAvailability: 'ready', playerInitialAvailability: 'ready' },
      roundQueueLimit: 8,
    })
    expect(hashWorldJson('compiled-world-manifest', legacy)).not.toBe(hashWorldJson('compiled-world-manifest', runtime))
    expect(runtimeManifestFromStored(new WorldSpecCompiler().compile(specV2()).manifest)).toMatchObject({ schemaVersion: 2 })
    expect(runtimeManifestFromStoredRecord({ manifest: legacy })).toMatchObject({ schemaVersion: 2 })
    expect(() => runtimeManifestFromStoredRecord(undefined)).toThrow('no stored Manifest')
  })

  it('accepts a content-bound V3 Manifest without rewriting its stored bytes', () => {
    const v2 = new WorldSpecCompiler().compile(specV2()).manifest
    const contentPack = {
      schemaVersion: 1 as const,
      packId: 'pack:test',
      packVersion: '1.0.0',
      packHash: hashWorldJson('pack:test', null),
      compiler: {
        id: 'compiler:test', version: '0.1.0', contractVersion: 'compiler/v1',
        canonicalJsonVersion: 'world-json/v1', limitsProfile: 'limits/v1',
      },
      pluginLocks: [{
        kind: 'presentation', id: 'presentation:test', version: '1.0.0',
        pluginHash: hashWorldJson('plugin:test', null),
      }],
      runtimeCapabilities: { publicSpeechObservationVersion: 1 as const },
      presentation: { schemaVersion: 'worldpack-presentation/v1', locale: 'en', style: 'plain' },
      initialFacts: [{ factId: 'fact:test', proposition: true, initialAudience: ['character:a'] }],
    }
    const v3 = { ...v2, schemaVersion: 3 as const, contentPack }
    expect(runtimeManifestFromStored(v3)).toBe(v3)
    expect(runtimeManifestFromStored({
      ...v3,
      contentPack: { ...contentPack, presentation: { ...contentPack.presentation, locale: 'zh-CN' } },
    } as unknown as WorldJsonValue)).toMatchObject({ schemaVersion: 3 })
    for (const [manifest, message] of [
      [{ ...v3, contentPack: null }, 'contentPack'],
      [{ ...v3, contentPack: { ...contentPack, schemaVersion: 2 } }, 'schemaVersion'],
      [{ ...v3, contentPack: { ...contentPack, packId: '' } }, 'packId'],
      [{ ...v3, contentPack: { ...contentPack, packVersion: '' } }, 'packVersion'],
      [{ ...v3, contentPack: { ...contentPack, packHash: '' } }, 'packHash'],
      [{ ...v3, contentPack: { ...contentPack, packHash: `sha256:${'A'.repeat(64)}` } }, 'lowercase SHA-256'],
      [{ ...v3, contentPack: { ...contentPack, compiler: null } }, 'compiler'],
      [{ ...v3, contentPack: { ...contentPack, compiler: { ...contentPack.compiler, extra: true } } }, 'missing or unknown'],
      [{ ...v3, contentPack: { ...contentPack, compiler: { ...contentPack.compiler, id: '' } } }, 'compiler.id'],
      [{ ...v3, contentPack: { ...contentPack, compiler: { ...contentPack.compiler, canonicalJsonVersion: 'json/v2' } } }, 'canonicalJsonVersion'],
      [{ ...v3, contentPack: { ...contentPack, pluginLocks: null } }, 'pluginLocks'],
      [{ ...v3, contentPack: { ...contentPack, pluginLocks: [null] } }, 'pluginLocks[0]'],
      [{ ...v3, contentPack: { ...contentPack, pluginLocks: [{ ...contentPack.pluginLocks[0], extra: true }] } }, 'missing or unknown'],
      [{ ...v3, contentPack: { ...contentPack, pluginLocks: [{ ...contentPack.pluginLocks[0], kind: '' }] } }, '.kind'],
      [{ ...v3, contentPack: { ...contentPack, pluginLocks: [{ ...contentPack.pluginLocks[0], pluginHash: '' }] } }, 'pluginHash'],
      [{ ...v3, contentPack: { ...contentPack, pluginLocks: [contentPack.pluginLocks[0], contentPack.pluginLocks[0]] } }, 'duplicate'],
      [{ ...v3, contentPack: { ...contentPack, runtimeCapabilities: null } }, 'runtimeCapabilities'],
      [{ ...v3, contentPack: { ...contentPack, runtimeCapabilities: { publicSpeechObservationVersion: 2 } } }, 'publicSpeechObservationVersion'],
      [{ ...v3, contentPack: { ...contentPack, runtimeCapabilities: { ...contentPack.runtimeCapabilities, extra: true } } }, 'missing or unknown'],
      [{ ...v3, contentPack: { ...contentPack, presentation: null } }, 'presentation'],
      [{ ...v3, contentPack: { ...contentPack, presentation: { ...contentPack.presentation, schemaVersion: 'v2' } } }, 'presentation schemaVersion'],
      [{ ...v3, contentPack: { ...contentPack, presentation: { ...contentPack.presentation, locale: 'fr' } } }, 'presentation locale'],
      [{ ...v3, contentPack: { ...contentPack, presentation: { ...contentPack.presentation, style: 'rich' } } }, 'presentation style'],
      [{ ...v3, contentPack: { ...contentPack, initialFacts: null } }, 'initialFacts'],
      [{ ...v3, contentPack: { ...contentPack, initialFacts: [null] } }, 'initialFacts[0]'],
      [{ ...v3, contentPack: { ...contentPack, initialFacts: [{ ...contentPack.initialFacts[0], extra: true }] } }, 'missing or unknown'],
      [{ ...v3, contentPack: { ...contentPack, initialFacts: [{ ...contentPack.initialFacts[0], factId: '' }] } }, 'factId'],
      [{ ...v3, contentPack: { ...contentPack, initialFacts: [{ ...contentPack.initialFacts[0], initialAudience: null }] } }, 'initialAudience'],
      [{ ...v3, contentPack: { ...contentPack, initialFacts: [{ ...contentPack.initialFacts[0], initialAudience: [''] }] } }, 'initialAudience[0]'],
      [{ ...v3, contentPack: { ...contentPack, initialFacts: [{ ...contentPack.initialFacts[0], initialAudience: ['character:a', 'character:a'] }] } }, 'duplicate'],
      [{ ...v3, contentPack: { ...contentPack, initialFacts: [contentPack.initialFacts[0], contentPack.initialFacts[0]] } }, 'duplicate'],
      [{ ...v3, contentPack: { ...contentPack, extra: true } }, 'missing or unknown'],
    ] as const) {
      expect(() => runtimeManifestFromStored(manifest as unknown as WorldJsonValue)).toThrow(message)
    }
  })

  it('accepts only an exactly locked Phase 8 Manifest V4', () => {
    const v2 = new WorldSpecCompiler().compile(specV2()).manifest
    const contentPack = {
      schemaVersion: 2 as const,
      packId: 'pack:phase8',
      packVersion: '2.0.0',
      packHash: hashWorldJson('pack:phase8', null),
      compiler: {
        id: 'compiler:world-pack', version: '0.2.0', contractVersion: 'worldpack-compiler/v2',
        canonicalJsonVersion: 'world-json/v1', limitsProfile: 'worldpack-limits/v2',
      },
      pluginLocks: [{
        kind: 'agent-context', id: 'builtin:agent-context', version: '2.0.0',
        pluginHash: hashWorldJson('plugin:phase8', null),
      }],
      vocabularyLocks: PHASE8_VOCABULARY_LOCKS,
      registryLocks: PHASE8_REGISTRY_LOCKS,
      runtimeCapabilities: {
        publicSpeechObservationVersion: 1 as const,
        cognitionProjectionVersion: 1 as const,
        sceneDecisionVersion: 2 as const,
        cognitiveMemoryVersion: 2 as const,
        agentContextVersion: 2 as const,
      },
      presentation: { schemaVersion: 'worldpack-presentation/v1', locale: 'zh-CN', style: 'plain' },
      initialFacts: [], memory: [], documents: [], markdown: [],
    }
    const v4 = { ...v2, schemaVersion: 4 as const, contentPack }
    expect(runtimeManifestFromStored(v4)).toBe(v4)
    expect(reactionPolicyFromManifest(v4)).toEqual({ version: 'reaction-policy/v1', mode: 'disabled' })

    const responsivePolicy = {
      version: 'reaction-policy/v1' as const,
      mode: 'responsive' as const,
      profile: 'responsive/v1' as const,
    }
    const v5 = { ...v4, schemaVersion: 5, reactionPolicy: responsivePolicy } as unknown as CompiledWorldManifestV5
    expect(runtimeManifestFromStored(v5)).toBe(v5)
    expect(reactionPolicyFromManifest(v5)).toBe(responsivePolicy)
    expect(runtimeManifestFromStored({
      ...v5,
      reactionPolicy: { version: 'reaction-policy/v1', mode: 'disabled' },
    })).toMatchObject({ reactionPolicy: { version: 'reaction-policy/v1', mode: 'disabled' } })

    const invalid: readonly (readonly [WorldJsonValue, string])[] = [
      [{ ...v4, contentPack: { ...contentPack, schemaVersion: 1 } }, 'schemaVersion'],
      [{ ...v4, contentPack: { ...contentPack, extra: true } }, 'missing or unknown'],
      [{ ...v4, contentPack: { ...contentPack, vocabularyLocks: null } }, 'vocabularyLocks'],
      [{ ...v4, contentPack: { ...contentPack, vocabularyLocks: PHASE8_VOCABULARY_LOCKS.slice(1) } }, 'does not match'],
      [{ ...v4, contentPack: {
        ...contentPack,
        vocabularyLocks: PHASE8_VOCABULARY_LOCKS.map((lock, index) => index === 0
          ? { ...lock, vocabularyHash: hashWorldJson('changed', null) }
          : lock),
      } }, 'does not match'],
      [{ ...v4, contentPack: { ...contentPack, registryLocks: PHASE8_REGISTRY_LOCKS.slice(1) } }, 'does not match'],
      [{ ...v4, contentPack: { ...contentPack, memory: null } }, 'memory'],
      [{ ...v4, contentPack: { ...contentPack, documents: null } }, 'documents'],
      [{ ...v4, contentPack: { ...contentPack, markdown: null } }, 'markdown'],
      ...(['cognitionProjectionVersion', 'sceneDecisionVersion', 'cognitiveMemoryVersion', 'agentContextVersion'] as const).map(field => ([{
        ...v4,
        contentPack: {
          ...contentPack,
          runtimeCapabilities: { ...contentPack.runtimeCapabilities, [field]: 99 },
        },
      } as WorldJsonValue, 'runtime capability'] as const)),
      [{ ...v4, reactionPolicy: responsivePolicy }, 'requires schemaVersion 5'],
      [{ ...v5, reactionPolicy: null }, 'reactionPolicy must be an object'],
      [{ ...v5, reactionPolicy: { version: 'reaction-policy/v1', mode: 'disabled', profile: 'responsive/v1' } }, 'missing or unknown'],
      [{ ...v5, reactionPolicy: { version: 'reaction-policy/v2', mode: 'disabled' } }, 'version'],
      [{ ...v5, reactionPolicy: { version: 'reaction-policy/v1', mode: 'unknown' } }, 'mode'],
      [{ ...v5, reactionPolicy: { version: 'reaction-policy/v1', mode: 'responsive' } }, 'missing or unknown'],
      [{ ...v5, reactionPolicy: { version: 'reaction-policy/v2', mode: 'responsive', profile: 'responsive/v1' } }, 'version'],
      [{ ...v5, reactionPolicy: { version: 'reaction-policy/v1', mode: 'responsive', profile: 'responsive/v2' } }, 'profile'],
      [{ ...v5, reactionPolicy: { ...responsivePolicy, extra: true } }, 'missing or unknown'],
    ]
    for (const [manifest, message] of invalid) expect(() => runtimeManifestFromStored(manifest)).toThrow(message)
  })

  it.each([
    [{ schemaVersion: 6 }, 'schemaVersion'],
    [{ ...new WorldSpecCompiler().compile(specV2()).manifest, runtimePolicy: null }, 'runtimePolicy'],
    [{ ...new WorldSpecCompiler().compile(specV2()).manifest, runtimePolicy: { npcInitialAvailability: 'offline', playerInitialAvailability: 'ready' } }, 'npcInitialAvailability'],
    [{ ...new WorldSpecCompiler().compile(specV2()).manifest, runtimePolicy: { npcInitialAvailability: 'ready', playerInitialAvailability: 'offline' } }, 'playerInitialAvailability'],
    [{ ...new WorldSpecCompiler().compile(specV2()).manifest, locations: null }, 'locations'],
    [{ ...new WorldSpecCompiler().compile(specV2()).manifest, characters: null }, 'characters'],
    [{ ...new WorldSpecCompiler().compile(specV2()).manifest, playerBindings: null }, 'playerBindings'],
  ] as const)('rejects an incompatible stored Manifest %#', (manifest, message) => {
    expect(() => runtimeManifestFromStored(manifest as unknown as WorldJsonValue)).toThrow(message)
  })

  it('compiles stable sorted inputs and atomically replays Tick 0 Genesis', () => {
    const compiler = new WorldSpecCompiler()
    const compiled = compiler.compile(spec())
    expect(compiled.manifest.locations.map(value => value.locationId)).toEqual(['location:a', 'location:z'])
    expect(compiled.manifest.characters.map(value => value.characterId)).toEqual(['character:a', 'character:b'])
    expect(compiled.manifest.playerBindings.map(value => value.principalId)).toEqual(['principal:a', 'principal:b'])
    expect(compiled.manifest.plugins.map(value => value.pluginId)).toEqual(['plugin:a', 'plugin:z'])
    expect(compiled.genesisEvents.map(event => event.eventType)).toEqual([
      'world.created', 'world.manifest-locked', 'location.upsert', 'location.upsert',
      'character.created', 'character.created', 'player.binding.upsert', 'player.binding.upsert',
      'world.lifecycle-changed',
    ])
    expect(compiled.manifest).toMatchObject({
      schemaVersion: 2,
      canonicalVersion: 'world-json/v1',
      hashVersion: 'sha256/v1',
      specHash: expect.stringMatching(/^sha256:/),
      genesisPlanHash: expect.stringMatching(/^sha256:/),
    })

    const path = database('bootstrap.sqlite')
    const store = new WorldStore(path)
    expect(store.readManifest(compiled.manifest.address)).toBeUndefined()
    const bootstrap = new WorldBootstrap(store)
    const activated = bootstrap.activate(compiled)
    expect(activated).toMatchObject({ status: 'activated', tick: 0, headSeq: compiled.genesisEvents.length })
    expect(bootstrap.activate(compiled, 'retry')).toEqual({ ...activated, status: 'already_active' })
    expect(store.head(compiled.manifest.address).tick).toBe(0)
    expect(store.readEvents(compiled.manifest.address).every(event => event.tick === 0)).toBe(true)
    expect(store.readManifest(compiled.manifest.address)).toEqual({ manifest: compiled.manifest, manifestHash: compiled.manifestHash })
    store.close()

    const restarted = new WorldStore(path)
    expect(new WorldBootstrap(restarted).activate(compiled).bundleHash).toBe(activated.bundleHash)
    expect(restarted.readManifest(compiled.manifest.address)?.manifestHash).toBe(compiled.manifestHash)
    restarted.close()
  })

  it('atomically enqueues one Genesis cognitive job per Manifest v4 character', () => {
    const compiled = new WorldSpecCompiler().compile(spec())
    const manifest = { ...compiled.manifest, schemaVersion: 4 as const }
    const phase8 = {
      ...compiled,
      manifest: manifest as unknown as CompiledWorldSpec['manifest'],
      manifestHash: hashWorldJson('compiled-world-manifest', manifest),
    }
    const store = new WorldStore(database('bootstrap-v4-jobs.sqlite'))
    const bootstrap = new WorldBootstrap(store)
    const activated = bootstrap.activate(phase8)
    expect(store.readCognitiveJobs(phase8.manifest.address)).toMatchObject([
      { characterId: 'character:a', asOfWorldSeq: phase8.genesisEvents.length, status: 'pending' },
      { characterId: 'character:b', asOfWorldSeq: phase8.genesisEvents.length, status: 'pending' },
    ])
    expect(bootstrap.activate(phase8)).toEqual({ ...activated, status: 'already_active' })
    expect(store.readCognitiveJobs(phase8.manifest.address)).toHaveLength(2)
    expect(() => store.activateBranch({
      address: phase8.manifest.address, manifest: phase8.manifest, manifestHash: phase8.manifestHash,
      genesisEvents: phase8.genesisEvents, genesisHash: phase8.genesisHash,
      transactionId: brandId('transaction:duplicate-genesis-jobs', 'TransactionId'),
      roundId: brandId('round:duplicate-genesis-jobs', 'InteractionRoundId'),
      cognitiveJobs: [
        { characterId: phase8.manifest.characters[0]!.characterId },
        { characterId: phase8.manifest.characters[0]!.characterId },
      ],
      correlationId: 'duplicate-genesis-jobs',
    })).toThrow('must be unique')
    store.close()
  })

  it('prevents the generic bootstrap from creating a new historical v3 world', () => {
    const historical = new WorldSpecCompiler().compile({
      ...spec(), rulebook: { rulebookId: 'builtin:speak-move', version: 3 },
    })
    const store = new WorldStore(database('historical-v3.sqlite'))
    expect(() => new WorldBootstrap(store).activate(historical)).toThrow('historical-only')
    store.close()
  })

  it('rejects malformed specs at every strict boundary', () => {
    const compiler = new WorldSpecCompiler()
    const invalid: unknown[] = [
      null,
      { ...spec(), extra: true },
      { ...spec(), schemaVersion: 2 },
      { ...spec(), timeMode: 'REALTIME' },
      { ...spec(), roundQueueLimit: 0 },
      { ...spec(), roundQueueLimit: 1.5 },
      { ...spec(), address: [] },
      { ...spec(), address: { ...spec().address, extra: true } },
      { ...spec(), address: { ...spec().address, tenantId: ' padded ' } },
      { ...spec(), address: { ...spec().address, worldId: 1 } },
      { ...spec(), rulebook: null },
      { ...spec(), rulebook: { ...spec().rulebook, extra: true } },
      { ...spec(), rulebook: { rulebookId: 'other', version: 1 } },
      { ...spec(), rulebook: { rulebookId: 'builtin:speak-move', version: 5 } },
      { ...spec(), locations: {} },
      { ...spec(), locations: [] },
      { ...spec(), locations: [null] },
      { ...spec(), locations: [{ locationId: 'location:a', name: 'Alpha', extra: true }] },
      { ...spec(), locations: [{ locationId: '', name: 'Alpha' }] },
      { ...spec(), locations: [{ locationId: 'location:a', name: 1 }] },
      { ...spec(), locations: [{ locationId: 'location:a', name: 'A' }, { locationId: 'location:a', name: 'B' }] },
      { ...spec(), characters: {} },
      { ...spec(), characters: [] },
      { ...spec(), characters: [null] },
      { ...spec(), characters: [{ characterId: 'character:a', name: 'A', locationId: 'location:a', extra: true }] },
      { ...spec(), characters: [{ characterId: '', name: 'A', locationId: 'location:a' }] },
      { ...spec(), characters: [{ characterId: 'character:a', name: 1, locationId: 'location:a' }] },
      { ...spec(), characters: [{ characterId: 'character:a', name: 'A', locationId: 'missing' }] },
      { ...spec(), characters: [spec().characters[0]!, spec().characters[0]!] },
      { ...spec(), playerBindings: {} },
      { ...spec(), playerBindings: [] },
      { ...spec(), playerBindings: [null] },
      { ...spec(), playerBindings: [{ principalId: 'p', characterId: 'character:a', sessionId: 's', extra: true }] },
      { ...spec(), playerBindings: [{ principalId: '', characterId: 'character:a', sessionId: 's' }] },
      { ...spec(), playerBindings: [{ principalId: 'p', characterId: 'missing', sessionId: 's' }] },
      { ...spec(), playerBindings: [{ principalId: 'p', characterId: 'character:a', sessionId: 1 }] },
      { ...spec(), playerBindings: [spec().playerBindings[0]!, { ...spec().playerBindings[1]!, principalId: spec().playerBindings[0]!.principalId }] },
      { ...spec(), playerBindings: [spec().playerBindings[0]!, { ...spec().playerBindings[1]!, characterId: spec().playerBindings[0]!.characterId }] },
      { ...spec(), plugins: {} },
      { ...spec(), plugins: [null] },
      { ...spec(), plugins: [{ pluginId: 'plugin:a', version: '1.0.0', extra: true }] },
      { ...spec(), plugins: [{ pluginId: '', version: '1.0.0' }] },
      { ...spec(), plugins: [{ pluginId: 'plugin:a', version: 'latest' }] },
      { ...spec(), plugins: [{ pluginId: 'plugin:a', version: '1.0.0' }, { pluginId: 'plugin:a', version: '2.0.0' }] },
    ]
    for (const value of invalid) expect(() => compiler.compile(value)).toThrow(TypeError)
  })

  it('compiles the complete V2 manifest, registries, and ordered Genesis seed plan', () => {
    const compiled = new WorldSpecCompiler().compile(specV2())
    expect(compiled.manifest).toMatchObject({
      metadata: specV2().metadata,
      runtimePolicy: specV2().runtimePolicy,
      entities: specV2().entities,
      scenes: specV2().scenes,
      goals: specV2().goals,
      claims: specV2().claims,
      observations: specV2().observations,
    })
    expect([
      compiled.manifest.registries.events, compiled.manifest.registries.actions,
      compiled.manifest.registries.projections, compiled.manifest.registries.rules,
    ].every(value => value.registryHash.startsWith('sha256:'))).toBe(true)
    expect(compiled.genesisEvents.map(event => event.eventType)).toEqual([
      'world.created', 'world.manifest-locked', 'location.upsert', 'entity.upsert', 'character.created',
      'scene.upsert', 'goal.upsert', 'claim.upsert', 'observation.upsert', 'player.binding.upsert',
      'world.lifecycle-changed',
    ])
    expect(new WorldSpecCompiler().compile(structuredClone(specV2()))).toEqual(compiled)

    const investigation = new WorldSpecCompiler().compile({
      ...specV2(),
      rulebook: { rulebookId: 'builtin:speak-move', version: 2 },
    })
    expect(investigation.manifest.registries.actions.definitions.map(value => value.name)).toContain('take')
    expect(investigation.manifest.registries.events.definitions.map(value => value.name)).toContain('entity.taken')
    expect(investigation.manifest.registries.rules.definitions.map(value => value.name)).toEqual(['builtin:speak-move/v2'])
    expect(investigation.manifestHash).not.toBe(compiled.manifestHash)

    const narrative = new WorldSpecCompiler().compile({
      ...specV2(),
      rulebook: { rulebookId: 'builtin:speak-move', version: 3 },
    })
    expect(narrative.manifest.registries.actions.definitions.map(value => value.name)).toEqual([
      'accuse', 'ask', 'inspect', 'move', 'present_evidence', 'speak', 'take',
    ])
    expect(narrative.manifest.registries.events.definitions.map(value => value.name)).toEqual(expect.arrayContaining([
      'character.asked', 'entity.inspected', 'evidence.presented',
      'investigation.accusation-resolved', 'investigation.case-closed',
    ]))
    expect(narrative.manifest.registries.rules.definitions.map(value => value.name)).toEqual(['builtin:speak-move/v3'])
    expect(narrative.manifestHash).not.toBe(investigation.manifestHash)

    const secureNarrative = new WorldSpecCompiler().compile({
      ...specV2(),
      rulebook: { rulebookId: 'builtin:speak-move', version: 4 },
      claims: [
        {
          claimId: 'claim:culprit', characterId: 'character:a',
          value: {
            source: 'author-secret',
            proposition: { subject: 'character:a', predicate: 'is_culprit', object: true },
          },
        },
        { claimId: 'claim:primitive', characterId: 'character:a', value: 'not a culprit seed' },
      ],
    })
    expect(secureNarrative.manifest.registries.events.definitions.map(value => value.name))
      .toContain('investigation.culprit-seeded')
    expect(secureNarrative.manifest.registries.rules.definitions.map(value => value.name))
      .toEqual(['builtin:speak-move/v4'])
    expect(secureNarrative.genesisEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        eventType: 'investigation.culprit-seeded',
        data: { culpritId: 'character:a', sourceClaimId: 'claim:culprit' },
      }),
    ]))
    expect(secureNarrative.manifestHash).not.toBe(narrative.manifestHash)
  })

  it('rejects malformed complete V2 authoring fields and reference graphs', () => {
    const compiler = new WorldSpecCompiler()
    const base = specV2()
    const invalid: unknown[] = [
      { ...base, schemaVersion: 3 },
      { ...base, metadata: null },
      { ...base, metadata: { ...base.metadata, extra: true } },
      { ...base, metadata: { title: '', description: '' } },
      { ...base, metadata: { title: 'ok', description: 1 } },
      { ...base, runtimePolicy: null },
      { ...base, runtimePolicy: { ...base.runtimePolicy, extra: true } },
      { ...base, runtimePolicy: { ...base.runtimePolicy, npcInitialAvailability: 'offline' } },
      { ...base, runtimePolicy: { ...base.runtimePolicy, playerInitialAvailability: 'provisioning' } },
      { ...base, entities: {} },
      { ...base, entities: [null] },
      { ...base, entities: [{ ...base.entities[0]!, extra: true }] },
      { ...base, entities: [{ ...base.entities[0]!, entityId: '' }] },
      { ...base, entities: [{ ...base.entities[0]!, locationId: 'missing' }] },
      { ...base, entities: [{ ...base.entities[0]!, kind: '' }] },
      { ...base, entities: [base.entities[0]!, base.entities[0]!] },
      { ...base, goals: {} },
      { ...base, goals: [null] },
      { ...base, goals: [{ ...base.goals[0]!, extra: true }] },
      { ...base, goals: [{ ...base.goals[0]!, characterId: 'missing' }] },
      { ...base, goals: [{ ...base.goals[0]!, goalId: '' }] },
      { ...base, goals: [base.goals[0]!, base.goals[0]!] },
      { ...base, claims: [base.claims[0]!, base.claims[0]!] },
      { ...base, observations: [base.observations[0]!, base.observations[0]!] },
      { ...base, scenes: {} },
      { ...base, scenes: [null] },
      { ...base, scenes: [{ ...base.scenes[0]!, extra: true }] },
      { ...base, scenes: [{ ...base.scenes[0]!, participantIds: {} }] },
      { ...base, scenes: [{ ...base.scenes[0]!, participantIds: [''] }] },
      { ...base, scenes: [{ ...base.scenes[0]!, participantIds: ['character:a', 'character:a'] }] },
      { ...base, scenes: [{ ...base.scenes[0]!, participantIds: ['missing'] }] },
      { ...base, scenes: [{ ...base.scenes[0]!, sceneId: '' }] },
      { ...base, scenes: [base.scenes[0]!, base.scenes[0]!] },
    ]
    for (const value of invalid) expect(() => compiler.compile(value)).toThrow(TypeError)
  })

  it('fails closed on conflicting or corrupted activation inputs', () => {
    const compiler = new WorldSpecCompiler()
    const compiled = compiler.compile(spec())
    const path = database('activation-errors.sqlite')
    const store = new WorldStore(path)
    expect(() => store.activateBranch({ ...activation(compiled), genesisEvents: [] })).toThrow('at least one')
    expect(() => store.activateBranch({ ...activation(compiled), manifestHash: hashWorldJson('wrong', 1) })).toThrow('manifestHash')
    expect(() => store.activateBranch({ ...activation(compiled), genesisHash: hashWorldJson('wrong', 1) })).toThrow('genesisHash')
    new WorldBootstrap(store).activate(compiled)
    const changed = compiler.compile({ ...spec(), roundQueueLimit: 9 })
    expect(() => new WorldBootstrap(store).activate(changed)).toThrow('already active')
    store.close()

    const occupiedPath = database('occupied.sqlite')
    const occupied = new WorldStore(occupiedPath)
    occupied.createBranch(compiled.manifest.address)
    expect(() => new WorldBootstrap(occupied).activate(compiled)).toThrow('unactivated branch')
    occupied.close()

    const collisionPath = database('manifest-collision.sqlite')
    const initialized = new WorldStore(collisionPath)
    initialized.close()
    const raw = new DatabaseSync(collisionPath)
    raw.prepare(`INSERT INTO world_manifests(manifest_hash, manifest_json) VALUES (?, ?)`)
      .run(compiled.manifestHash, '{}')
    raw.close()
    const collision = new WorldStore(collisionPath)
    expect(() => collision.activateBranch(activation(compiled))).toThrow('different bytes')
    collision.close()
  })

  it('enforces the frozen Event Registry at activation and every later commit', async () => {
    const compiled = new WorldSpecCompiler().compile(specV2())
    for (const [index, manifest] of ([null, [], { schemaVersion: 1 }] as const).entries()) {
      const legacyStore = new WorldStore(database(`registry-legacy-${index}.sqlite`))
      const genesisEvents = [{ eventType: 'legacy.genesis', eventVersion: 1, data: null }]
      expect(legacyStore.activateBranch({
        ...activation(compiled), manifest, manifestHash: hashWorldJson('compiled-world-manifest', manifest),
        genesisEvents, genesisHash: hashWorldJson('world-genesis-plan', genesisEvents),
        transactionId: brandId(`transaction:legacy:${index}`, 'TransactionId'),
        roundId: brandId(`round:legacy:${index}`, 'InteractionRoundId'),
      }).status).toBe('activated')
      legacyStore.close()
    }
    const invalidManifests: WorldJsonValue[] = [
      { ...compiled.manifest, registries: null },
      { ...compiled.manifest, registries: { ...compiled.manifest.registries, events: null } },
      { ...compiled.manifest, registries: { ...compiled.manifest.registries, events: { definitions: null, registryHash: compiled.manifest.registries.events.registryHash } } },
      { ...compiled.manifest, registries: { ...compiled.manifest.registries, events: { definitions: [null], registryHash: compiled.manifest.registries.events.registryHash } } },
      { ...compiled.manifest, registries: { ...compiled.manifest.registries, events: { definitions: [{ name: 1, version: 1 }], registryHash: compiled.manifest.registries.events.registryHash } } },
      { ...compiled.manifest, registries: { ...compiled.manifest.registries, events: { definitions: [{ name: 'world.created', version: 0 }], registryHash: compiled.manifest.registries.events.registryHash } } },
    ]
    for (const [index, manifest] of invalidManifests.entries()) {
      const store = new WorldStore(database(`registry-malformed-${index}.sqlite`))
      expect(() => store.activateBranch({ ...activation(compiled), manifest, manifestHash: hashWorldJson('compiled-world-manifest', manifest) }))
        .toThrow(/malformed/i)
      store.close()
    }

    const unknownGenesis = [{ ...compiled.genesisEvents[0]!, eventType: 'world.unknown' }, ...compiled.genesisEvents.slice(1)]
    const activationStore = new WorldStore(database('registry-unknown-genesis.sqlite'))
    expect(() => activationStore.activateBranch({
      ...activation(compiled), genesisEvents: unknownGenesis, genesisHash: hashWorldJson('world-genesis-plan', unknownGenesis),
    })).toThrow('not locked')
    activationStore.close()

    const store = new WorldStore(database('registry-round.sqlite'))
    new WorldBootstrap(store).activate(compiled)
    for (const event of [
      { eventType: 'world.unknown', eventVersion: 1, data: null },
      { eventType: 'character.speak', eventVersion: 2, data: null },
    ]) {
      const head = store.head(compiled.manifest.address)
      await expect(store.commitRound({
        address: compiled.manifest.address,
        transactionId: brandId(`transaction:${event.eventType}:${event.eventVersion}`, 'TransactionId'),
        roundId: brandId(`round:${event.eventType}:${event.eventVersion}`, 'InteractionRoundId'),
        expectedHeadSeq: head.headSeq, expectedTick: head.tick, nextTick: head.tick + 1,
        events: [event], outbox: [], correlationId: 'registry-round',
      })).rejects.toThrow('not locked')
    }
    store.close()
  })

  it('rejects values outside World JSON before interpreting fields', () => {
    const value = spec() as Record<string, WorldJsonValue | undefined>
    value.plugins = undefined
    expect(() => new WorldSpecCompiler().compile(value)).toThrow('does not support undefined')
  })
})
