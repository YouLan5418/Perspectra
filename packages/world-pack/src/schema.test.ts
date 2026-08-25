import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { canonicalizeWorldJson, hashWorldJson, type WorldJsonValue } from '@harness-world/contracts'
import {
  PHASE7_CORE_PROFILES,
  WORLD_PACK_COMPILED_SCHEMA_VERSION,
  WORLD_PACK_COMPILER_CONTRACT_VERSION,
  WORLD_PACK_COMPILER_ID,
  WORLD_PACK_COMPILER_VERSION,
  WORLD_PACK_LIMITS_PROFILE,
  WORLD_PACK_SOURCE_SCHEMA_VERSION,
  WorldPackContractError,
  failWorldPackContract,
  parseCompiledWorldPack,
  parseWorldPackAssertionsSource,
  parseWorldPackCharactersSource,
  parseWorldPackEntitiesSource,
  parseWorldPackLocationsSource,
  parseWorldPackPlayerSlotsSource,
  parseWorldPackPresentationSource,
  parseWorldPackScenesSource,
  parseWorldPackSourceManifest,
  parseWorldPackWorldSource,
  worldPackErrorCode,
  type CompiledWorldPack,
} from './index.ts'

const ZERO_HASH = `sha256:${'0'.repeat(64)}` as const
const WELCOME_HASH = `sha256:${createHash('sha256').update('Welcome\n').digest('hex')}` as const

function rawTextHash(text: string) {
  return `sha256:${createHash('sha256').update(text).digest('hex')}`
}

function manifest() {
  return {
    sourceSchemaVersion: 'worldpack-source/v1', packId: 'pack:tavern', packVersion: '1.0.0', worldFile: 'world.json',
    characterFiles: ['characters.json'], locationFiles: ['locations.json'], entityFiles: ['entities.json'], sceneFiles: ['scenes.json'],
    playerSlotFiles: ['player-slots.json'], presentationFiles: ['presentation.json'], markdownFiles: [], assetFiles: [],
    assertionFiles: ['assertions.json'],
  }
}

function world() {
  return { schemaVersion: 'worldpack-world/v1', title: 'The Tavern' }
}

function locations() {
  return { schemaVersion: 'worldpack-locations/v1', locations: [{ locationId: 'location:tavern', name: 'Tavern' }] }
}

function entities() {
  return { schemaVersion: 'worldpack-entities/v1', entities: [{ entityId: 'entity:mug', locationId: 'location:tavern', kind: 'mug' }] }
}

function characters() {
  return {
    schemaVersion: 'worldpack-characters/v1',
    characters: [{ characterId: 'character:player', displayName: 'Player', initialLocationId: 'location:tavern' }],
  }
}

function richCharacters() {
  return {
    schemaVersion: 'worldpack-characters/v1',
    characters: [{
      characterId: 'character:bob', displayName: 'Bob', pronouns: 'he/him', initialLocationId: 'location:tavern',
      lifecycle: 'active', portrayal: { summary: 'Innkeeper', speakingStyle: 'brief', backgroundTextRef: 'text/bob.md' },
      initialObservations: [{ observationId: 'observation:bob', value: { text: 'Rain' } }],
      initialClaims: [{ claimId: 'claim:bob', value: { proposition: 'door-open' } }],
      initialGoals: [{ goalId: 'goal:bob', value: { text: 'Close the door' }, priorityPermille: 800, visibility: 'public' }],
    }],
  }
}

function scenes() {
  return { schemaVersion: 'worldpack-scenes/v1', scenes: [{ sceneId: 'scene:tavern', participantIds: ['character:player'] }] }
}

function slots() {
  return { schemaVersion: 'worldpack-player-slots/v1', playerSlots: [{ slotId: 'slot:player', characterId: 'character:player' }] }
}

function presentation() {
  return { schemaVersion: 'worldpack-presentation/v1' }
}

function assertions() {
  return {
    schemaVersion: 'worldpack-assertions/v1',
    assertions: [{ assertionId: 'assertion:private', assertionType: 'view.excludes', parameters: { characterId: 'character:player' } }],
  }
}

function pluginLocks() {
  return [
    { kind: 'rulebook', id: 'builtin:speak-move', version: '2' },
    { kind: 'scene-decision', id: 'builtin:scene-decision', version: '1.0.0' },
    { kind: 'agent-context', id: 'builtin:agent-context', version: '2.0.0' },
    { kind: 'presentation', id: 'builtin:deterministic-presentation', version: '1.0.0' },
  ].map(identity => ({ ...identity, pluginHash: hashWorldJson('world-pack-core-plugin-lock/v1', identity) }))
}

function compiled(): WorldJsonValue {
  return {
    compiledSchemaVersion: 'worldpack/v1', packId: 'pack:tavern', packVersion: '1.0.0', packHash: ZERO_HASH,
    compiler: {
      id: 'harness-world-pack-compiler', version: '0.1.0', contractVersion: 'worldpack-compiler/v1',
      canonicalJsonVersion: 'world-json/v1', limitsProfile: 'worldpack-limits/v1',
    },
    pluginLocks: pluginLocks(),
    content: {
      world: parseWorldPackWorldSource(world()), locations: parseWorldPackLocationsSource(locations()).locations,
      entities: parseWorldPackEntitiesSource(entities()).entities,
      characters: parseWorldPackCharactersSource(characters()).characters, scenes: parseWorldPackScenesSource(scenes()).scenes,
      playerSlots: parseWorldPackPlayerSlotsSource(slots()).playerSlots,
      presentation: parseWorldPackPresentationSource(presentation()),
      markdown: [{ path: 'text/opening.md', text: 'Welcome\n', contentHash: WELCOME_HASH }],
    },
    assets: [{ path: 'assets/map.png', contentHash: ZERO_HASH, size: 12 }],
    acceptanceAssertions: parseWorldPackAssertionsSource(assertions()).assertions,
  }
}

function contractError(run: () => unknown): WorldPackContractError {
  try {
    run()
  } catch (error) {
    expect(error).toBeInstanceOf(WorldPackContractError)
    return error as WorldPackContractError
  }
  throw new Error('expected WorldPackContractError')
}

describe('World Pack Phase 7 contracts', () => {
  it('normalizes the sparse source contracts with frozen safe defaults', () => {
    expect(parseWorldPackSourceManifest(manifest())).toMatchObject({
      sourceSchemaVersion: WORLD_PACK_SOURCE_SCHEMA_VERSION, packId: 'pack:tavern', packVersion: '1.0.0',
    })
    expect(parseWorldPackWorldSource(world())).toEqual({
      schemaVersion: 'worldpack-world/v1', title: 'The Tavern', description: '', timeMode: 'TURN_DRIVEN',
      roundQueueLimit: 8, coreProfiles: PHASE7_CORE_PROFILES, initialFacts: [],
    })
    expect(parseWorldPackCharactersSource(characters()).characters[0]).toMatchObject({
      lifecycle: 'active', pronouns: '', portrayal: { summary: '', speakingStyle: '', backgroundTextRef: null },
      initialObservations: [], initialClaims: [], initialGoals: [],
    })
    expect(parseWorldPackPlayerSlotsSource(slots()).playerSlots[0]?.controlMode).toBe('manual')
    expect(parseWorldPackPresentationSource(presentation())).toEqual({ schemaVersion: 'worldpack-presentation/v1', locale: 'en', style: 'plain' })
  })

  it('accepts explicit Core profiles and materializes rich character cognition', () => {
    const explicitWorld = parseWorldPackWorldSource({
      ...world(), description: 'Open social world', timeMode: 'TURN_DRIVEN', roundQueueLimit: 16,
      coreProfiles: PHASE7_CORE_PROFILES,
      initialFacts: [{ factId: 'fact:cellar', proposition: { door: 'locked' }, initialAudience: ['character:bob'] }],
    })
    expect(explicitWorld).toMatchObject({ description: 'Open social world', roundQueueLimit: 16 })
    expect(explicitWorld.initialFacts[0]).toEqual({ factId: 'fact:cellar', proposition: { door: 'locked' }, initialAudience: ['character:bob'] })
    expect(parseWorldPackLocationsSource(locations())).toEqual(locations())
    expect(parseWorldPackEntitiesSource(entities())).toEqual(entities())
    expect(parseWorldPackScenesSource(scenes())).toEqual(scenes())
    expect(parseWorldPackAssertionsSource(assertions())).toEqual(assertions())
    expect(parseWorldPackCharactersSource(richCharacters()).characters[0]).toMatchObject({
      pronouns: 'he/him', lifecycle: 'active',
      portrayal: { summary: 'Innkeeper', speakingStyle: 'brief', backgroundTextRef: 'text/bob.md' },
      initialGoals: [{ priorityPermille: 800, visibility: 'public' }],
    })
    const richBob = richCharacters().characters[0]!
    const defaults = {
      ...richCharacters(),
      characters: [{
        ...richBob,
        portrayal: { ...richBob.portrayal, backgroundTextRef: null },
        initialGoals: [{ goalId: 'goal:bob', value: { text: 'Close the door' } }],
      }],
    }
    expect(parseWorldPackCharactersSource(defaults).characters[0]?.initialGoals[0]).toMatchObject({ priorityPermille: 500, visibility: 'private' })
    expect(parseWorldPackCharactersSource(defaults).characters[0]?.portrayal.backgroundTextRef).toBeNull()
  })

  it('validates an immutable compiled envelope identity without recomputing its P7.2 hash', () => {
    const value = parseCompiledWorldPack(compiled())
    expect(value).toMatchObject({
      compiledSchemaVersion: WORLD_PACK_COMPILED_SCHEMA_VERSION,
      compiler: {
        id: WORLD_PACK_COMPILER_ID, version: WORLD_PACK_COMPILER_VERSION,
        contractVersion: WORLD_PACK_COMPILER_CONTRACT_VERSION, limitsProfile: WORLD_PACK_LIMITS_PROFILE,
      },
      packHash: ZERO_HASH,
    })
    expect(value.pluginLocks.map(lock => lock.kind)).toEqual(['rulebook', 'scene-decision', 'agent-context', 'presentation'])
    expect(value.content.markdown[0]?.text).toBe('Welcome\n')
    expect(value.assets[0]?.size).toBe(12)
    expect(canonicalizeWorldJson(value).byteLength).toBeGreaterThan(100)
    expect(hashWorldJson('world-pack-contract-golden/v1', value)).toBe(
      'sha256:e99920fb9871639a0c4841ccc31f0a175b155700dfb29f9c4fe341779461bf71',
    )
  })

  it('carries structured diagnostics and maps compiler error categories', () => {
    const error = contractError(() => failWorldPackContract('PACK_LIMIT_EXCEEDED', 'world.json', '/characters', 'too many', 'remove one'))
    expect(error).toMatchObject({ name: 'WorldPackContractError', diagnostics: [{
      severity: 'error', code: 'PACK_LIMIT_EXCEEDED', file: 'world.json', jsonPointer: '/characters',
      message: 'too many', suggestion: 'remove one',
    }] })
    expect(error.message).toBe('world.json/characters: too many')
    expect(worldPackErrorCode('PACK_REFERENCE_INVALID')).toBe('PACK_REFERENCE_INVALID')
    expect(worldPackErrorCode('PACK_VERSION_DIVERGED')).toBe('PACK_VERSION_DIVERGED')
    expect(worldPackErrorCode('PLUGIN_NOT_REGISTERED')).toBe('PLUGIN_NOT_REGISTERED')
    expect(worldPackErrorCode('REGISTRY_HASH_MISMATCH')).toBe('REGISTRY_HASH_MISMATCH')
    expect(worldPackErrorCode('PACK_UNKNOWN_FIELD')).toBe('PACK_SOURCE_INVALID')
  })

  it.each([
    [undefined, 'PACK_SOURCE_INVALID'],
    [null, 'PACK_SOURCE_INVALID'],
    [{ ...manifest(), extra: true }, 'PACK_UNKNOWN_FIELD'],
    [(({ packId: _removed, ...value }) => value)(manifest()), 'PACK_SOURCE_INVALID'],
    [{ ...manifest(), sourceSchemaVersion: 'worldpack-source/v2' }, 'PACK_SOURCE_INVALID'],
    [{ ...manifest(), packId: 1 }, 'PACK_SOURCE_INVALID'],
    [{ ...manifest(), packId: ' padded ' }, 'PACK_SOURCE_INVALID'],
    [{ ...manifest(), packVersion: 'latest' }, 'PACK_SOURCE_INVALID'],
    [{ ...manifest(), characterFiles: {} }, 'PACK_SOURCE_INVALID'],
    [{ ...manifest(), characterFiles: [] }, 'PACK_SOURCE_INVALID'],
    [{ ...manifest(), characterFiles: [1] }, 'PACK_SOURCE_INVALID'],
    [{ ...manifest(), worldFile: 'characters.json' }, 'PACK_DUPLICATE_ID'],
    [{ ...manifest(), markdownFiles: ['same.md'], assetFiles: ['same.md'] }, 'PACK_DUPLICATE_ID'],
    [{ ...manifest(), markdownFiles: Array.from({ length: 506 }, (_, index) => `text/${index}.md`) }, 'PACK_LIMIT_EXCEEDED'],
  ])('rejects malformed source manifests %#', (value, code) => {
    expect(contractError(() => parseWorldPackSourceManifest(value)).diagnostics[0].code).toBe(code)
  })

  it.each([
    [() => parseWorldPackWorldSource({ ...world(), schemaVersion: 'worldpack-world/v2' }), 'PACK_SOURCE_INVALID'],
    [() => parseWorldPackWorldSource({ ...world(), title: '' }), 'PACK_SOURCE_INVALID'],
    [() => parseWorldPackWorldSource({ ...world(), description: 1 }), 'PACK_SOURCE_INVALID'],
    [() => parseWorldPackWorldSource({ ...world(), timeMode: 'REALTIME' }), 'PACK_SOURCE_INVALID'],
    [() => parseWorldPackWorldSource({ ...world(), roundQueueLimit: 0 }), 'PACK_SOURCE_INVALID'],
    [() => parseWorldPackWorldSource({ ...world(), roundQueueLimit: 1025 }), 'PACK_SOURCE_INVALID'],
    [() => parseWorldPackWorldSource({ ...world(), description: 'x'.repeat(1024 * 1024) }), 'PACK_LIMIT_EXCEEDED'],
    [() => parseWorldPackWorldSource({ ...world(), initialFacts: {} }), 'PACK_SOURCE_INVALID'],
    [() => parseWorldPackWorldSource({ ...world(), initialFacts: [null] }), 'PACK_SOURCE_INVALID'],
    [() => parseWorldPackWorldSource({ ...world(), initialFacts: [{ factId: 'fact:a', proposition: true, initialAudience: [] }] }), 'PACK_SOURCE_INVALID'],
    [() => parseWorldPackWorldSource({ ...world(), initialFacts: [{ factId: 'fact:a', proposition: true, initialAudience: ['character:a', 'character:a'] }] }), 'PACK_DUPLICATE_ID'],
    [() => parseWorldPackWorldSource({ ...world(), initialFacts: [
      { factId: 'fact:a', proposition: true, initialAudience: ['character:a'] },
      { factId: 'fact:a', proposition: false, initialAudience: ['character:b'] },
    ] }), 'PACK_DUPLICATE_ID'],
    [() => parseWorldPackWorldSource({ ...world(), coreProfiles: { ...PHASE7_CORE_PROFILES, extra: true } }), 'PACK_UNKNOWN_FIELD'],
    [() => parseWorldPackWorldSource({ ...world(), coreProfiles: { ...PHASE7_CORE_PROFILES, rulebook: null } }), 'PACK_SOURCE_INVALID'],
    [() => parseWorldPackWorldSource({ ...world(), coreProfiles: { ...PHASE7_CORE_PROFILES, rulebook: { rulebookId: 'builtin:speak-move', version: 1 } } }), 'PACK_PROFILE_NOT_ALLOWED'],
    [() => parseWorldPackWorldSource({ ...world(), coreProfiles: { ...PHASE7_CORE_PROFILES, sceneDecision: { pluginId: 'builtin:scene-decision', version: 'latest' } } }), 'PACK_SOURCE_INVALID'],
    [() => parseWorldPackWorldSource({ ...world(), coreProfiles: { ...PHASE7_CORE_PROFILES, agentContext: { pluginId: 'other', version: '2.0.0' } } }), 'PACK_PROFILE_NOT_ALLOWED'],
    [() => parseWorldPackWorldSource({ ...world(), coreProfiles: { ...PHASE7_CORE_PROFILES, presentation: { profileId: 'other', version: '1.0.0' } } }), 'PACK_PROFILE_NOT_ALLOWED'],
  ])('rejects invalid world-level contracts %#', (run, code) => {
    expect(contractError(run).diagnostics[0].code).toBe(code)
  })

  it.each([
    [() => parseWorldPackLocationsSource({ ...locations(), schemaVersion: 'bad' }), 'PACK_SOURCE_INVALID'],
    [() => parseWorldPackLocationsSource({ ...locations(), locations: [] }), 'PACK_SOURCE_INVALID'],
    [() => parseWorldPackLocationsSource({ ...locations(), locations: [locations().locations[0], locations().locations[0]] }), 'PACK_DUPLICATE_ID'],
    [() => parseWorldPackLocationsSource({ ...locations(), locations: [null] }), 'PACK_SOURCE_INVALID'],
    [() => parseWorldPackLocationsSource({ ...locations(), locations: [{ ...locations().locations[0], extra: true }] }), 'PACK_UNKNOWN_FIELD'],
    [() => parseWorldPackLocationsSource({ ...locations(), locations: Array.from({ length: 513 }, (_, index) => ({ locationId: `location:${index}`, name: `${index}` })) }), 'PACK_LIMIT_EXCEEDED'],
    [() => parseWorldPackEntitiesSource({ ...entities(), schemaVersion: 'bad' }), 'PACK_SOURCE_INVALID'],
    [() => parseWorldPackEntitiesSource({ ...entities(), entities: [entities().entities[0], entities().entities[0]] }), 'PACK_DUPLICATE_ID'],
    [() => parseWorldPackEntitiesSource({ ...entities(), entities: [{ ...entities().entities[0], extra: true }] }), 'PACK_UNKNOWN_FIELD'],
    [() => parseWorldPackEntitiesSource({ ...entities(), entities: Array.from({ length: 513 }, (_, index) => ({ entityId: `entity:${index}`, locationId: 'location:tavern', kind: 'item' })) }), 'PACK_LIMIT_EXCEEDED'],
    [() => parseWorldPackCharactersSource({ ...characters(), schemaVersion: 'bad' }), 'PACK_SOURCE_INVALID'],
    [() => parseWorldPackCharactersSource({ ...characters(), characters: [] }), 'PACK_SOURCE_INVALID'],
    [() => parseWorldPackCharactersSource({ ...characters(), characters: [characters().characters[0], characters().characters[0]] }), 'PACK_DUPLICATE_ID'],
    [() => parseWorldPackCharactersSource({ ...characters(), characters: [{ ...characters().characters[0], lifecycle: 'ghost' }] }), 'PACK_SOURCE_INVALID'],
    [() => parseWorldPackCharactersSource({ ...characters(), characters: [{ ...characters().characters[0], portrayal: { extra: true } }] }), 'PACK_UNKNOWN_FIELD'],
    [() => parseWorldPackCharactersSource({ ...characters(), characters: [{ ...characters().characters[0], initialObservations: [
      { observationId: 'o', value: 1 }, { observationId: 'o', value: 2 },
    ] }] }), 'PACK_DUPLICATE_ID'],
    [() => parseWorldPackCharactersSource({ ...characters(), characters: [{ ...characters().characters[0], initialClaims: [
      { claimId: 'c', value: 1 }, { claimId: 'c', value: 2 },
    ] }] }), 'PACK_DUPLICATE_ID'],
    [() => parseWorldPackCharactersSource({ ...characters(), characters: [{ ...characters().characters[0], initialGoals: [
      { goalId: 'g', value: 1 }, { goalId: 'g', value: 2 },
    ] }] }), 'PACK_DUPLICATE_ID'],
    [() => parseWorldPackCharactersSource({ ...characters(), characters: [{ ...characters().characters[0], initialGoals: [{ goalId: 'g', value: 1, visibility: 'author' }] }] }), 'PACK_SOURCE_INVALID'],
    [() => parseWorldPackCharactersSource({ ...characters(), characters: [{ ...characters().characters[0], initialGoals: [{ goalId: 'g', value: 1, priorityPermille: -1 }] }] }), 'PACK_SOURCE_INVALID'],
    [() => parseWorldPackCharactersSource({ ...characters(), characters: Array.from({ length: 257 }, (_, index) => ({
      characterId: `character:${index}`, displayName: `${index}`, initialLocationId: 'location:room',
    })) }), 'PACK_LIMIT_EXCEEDED'],
    [() => parseWorldPackScenesSource({ ...scenes(), schemaVersion: 'bad' }), 'PACK_SOURCE_INVALID'],
    [() => parseWorldPackScenesSource({ ...scenes(), scenes: [] }), 'PACK_SOURCE_INVALID'],
    [() => parseWorldPackScenesSource({ ...scenes(), scenes: [scenes().scenes[0], scenes().scenes[0]] }), 'PACK_SOURCE_INVALID'],
    [() => parseWorldPackScenesSource({ ...scenes(), scenes: [{ ...scenes().scenes[0], participantIds: [] }] }), 'PACK_SOURCE_INVALID'],
    [() => parseWorldPackScenesSource({ ...scenes(), scenes: [{ ...scenes().scenes[0], participantIds: ['character:player', 'character:player'] }] }), 'PACK_DUPLICATE_ID'],
    [() => parseWorldPackPlayerSlotsSource({ ...slots(), schemaVersion: 'bad' }), 'PACK_SOURCE_INVALID'],
    [() => parseWorldPackPlayerSlotsSource({ ...slots(), playerSlots: [] }), 'PACK_SOURCE_INVALID'],
    [() => parseWorldPackPlayerSlotsSource({ ...slots(), playerSlots: [slots().playerSlots[0], slots().playerSlots[0]] }), 'PACK_SOURCE_INVALID'],
    [() => parseWorldPackPlayerSlotsSource({ ...slots(), playerSlots: [{ ...slots().playerSlots[0], controlMode: 'agent' }] }), 'PACK_SOURCE_INVALID'],
    [() => parseWorldPackPresentationSource({ ...presentation(), schemaVersion: 'bad' }), 'PACK_SOURCE_INVALID'],
    [() => parseWorldPackPresentationSource({ ...presentation(), locale: 'fr' }), 'PACK_SOURCE_INVALID'],
    [() => parseWorldPackPresentationSource({ ...presentation(), style: 'rich' }), 'PACK_SOURCE_INVALID'],
    [() => parseWorldPackAssertionsSource({ ...assertions(), schemaVersion: 'bad' }), 'PACK_SOURCE_INVALID'],
    [() => parseWorldPackAssertionsSource({ ...assertions(), assertions: [assertions().assertions[0], assertions().assertions[0]] }), 'PACK_DUPLICATE_ID'],
  ])('rejects malformed content documents %#', (run, code) => {
    expect(contractError(run).diagnostics[0].code).toBe(code)
  })

  it.each([
    [() => parseCompiledWorldPack({ ...compiled() as object, compiledSchemaVersion: 'worldpack/v2' }), 'PACK_SOURCE_INVALID'],
    [() => parseCompiledWorldPack({ ...compiled() as object, packVersion: 'latest' }), 'PACK_SOURCE_INVALID'],
    [() => parseCompiledWorldPack({ ...compiled() as object, packHash: 'sha256:ABC' }), 'PACK_SOURCE_INVALID'],
    [() => parseCompiledWorldPack({ ...compiled() as object, compiler: { ...(compiled() as CompiledWorldPack).compiler, version: '0.2.0' } }), 'PACK_SOURCE_INVALID'],
    [() => parseCompiledWorldPack({ ...compiled() as object, pluginLocks: pluginLocks().slice(0, 3) }), 'PLUGIN_NOT_REGISTERED'],
    [() => parseCompiledWorldPack({ ...compiled() as object, pluginLocks: [...pluginLocks(), pluginLocks()[0]] }), 'PACK_DUPLICATE_ID'],
    [() => parseCompiledWorldPack({ ...compiled() as object, pluginLocks: [{ ...pluginLocks()[0], kind: 'other', id: 'x' }, ...pluginLocks().slice(1) ] }), 'PLUGIN_NOT_REGISTERED'],
    [() => parseCompiledWorldPack({ ...compiled() as object, pluginLocks: [{ ...pluginLocks()[0], id: 'other' }, ...pluginLocks().slice(1) ] }), 'PLUGIN_NOT_REGISTERED'],
    [() => parseCompiledWorldPack({ ...compiled() as object, pluginLocks: [{ ...pluginLocks()[0], pluginHash: ZERO_HASH }, ...pluginLocks().slice(1) ] }), 'REGISTRY_HASH_MISMATCH'],
    [() => parseCompiledWorldPack({ ...compiled() as object, content: { ...(compiled() as CompiledWorldPack).content, extra: true } }), 'PACK_UNKNOWN_FIELD'],
    [() => parseCompiledWorldPack({ ...compiled() as object, content: { ...(compiled() as CompiledWorldPack).content, markdown: [
      { path: 'same.md', text: 'a', contentHash: rawTextHash('a') }, { path: 'same.md', text: 'b', contentHash: rawTextHash('b') },
    ] } }), 'PACK_DUPLICATE_ID'],
    [() => parseCompiledWorldPack({ ...compiled() as object, content: { ...(compiled() as CompiledWorldPack).content, markdown: [
      { path: 'text/opening.md', text: 'Changed', contentHash: WELCOME_HASH },
    ] } }), 'PACK_SOURCE_INVALID'],
    [() => parseCompiledWorldPack({ ...compiled() as object, assets: [
      { path: 'same.png', contentHash: ZERO_HASH, size: 1 }, { path: 'same.png', contentHash: ZERO_HASH, size: 2 },
    ] }), 'PACK_DUPLICATE_ID'],
    [() => parseCompiledWorldPack({ ...compiled() as object, content: { ...(compiled() as CompiledWorldPack).content, markdown: [
      { path: 'large.md', text: 'x'.repeat(256 * 1024 + 1), contentHash: ZERO_HASH },
    ] } }), 'PACK_LIMIT_EXCEEDED'],
    [() => parseCompiledWorldPack({ ...compiled() as object, assets: [{ path: 'large', contentHash: ZERO_HASH, size: 8 * 1024 * 1024 + 1 }] }), 'PACK_LIMIT_EXCEEDED'],
    [() => parseCompiledWorldPack({ ...compiled() as object, extra: 'x'.repeat(16 * 1024 * 1024) }), 'PACK_LIMIT_EXCEEDED'],
    [() => parseCompiledWorldPack({ ...compiled() as object, acceptanceAssertions: [assertions().assertions[0], assertions().assertions[0]] }), 'PACK_DUPLICATE_ID'],
  ])('rejects malformed compiled envelopes %#', (run, code) => {
    expect(contractError(run).diagnostics[0].code).toBe(code)
  })
})
