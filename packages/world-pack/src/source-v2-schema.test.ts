import { describe, expect, it } from 'vitest'
import { hashWorldJson } from '@harness-world/contracts'
import {
  WorldPackContractError,
  parseWorldPackCharactersSourceV2,
  parseWorldPackDocumentsSourceV2,
  parseWorldPackMemorySourceV2,
  parseWorldPackScenesSourceV2,
} from './index.ts'

function errorOf(run: () => unknown): WorldPackContractError {
  try {
    run()
  } catch (error) {
    expect(error).toBeInstanceOf(WorldPackContractError)
    return error as WorldPackContractError
  }
  throw new Error('expected WorldPackContractError')
}

function charactersV2() {
  return {
    schemaVersion: 'worldpack-characters/v2',
    characters: [{ characterId: 'character:player', displayName: 'Player', controllerClass: 'manual' }],
  }
}

function scenesV2() {
  return {
    schemaVersion: 'worldpack-scenes/v2',
    scenes: [{ sceneId: 'scene:road', lifecycle: 'active', participantIds: ['character:player'] }],
  }
}

function memoryV2() {
  return {
    schemaVersion: 'worldpack-memory/v2',
    characters: [{ characterId: 'character:alice', profile: 'standard' }],
  }
}

function documentsV2() {
  return {
    schemaVersion: 'worldpack-documents/v2',
    documents: [{ documentId: 'document:road', contentRef: 'text/road.md', usage: 'world_context', audience: 'public' }],
  }
}

describe('World Pack v2 character sources', () => {
  it('materializes a minimal character without inventing portrayal or location', () => {
    const parsed = parseWorldPackCharactersSourceV2(charactersV2())
    expect(parsed).toEqual({
      schemaVersion: 'worldpack-characters/v2',
      characters: [{
        characterId: 'character:player', displayName: 'Player', controllerClass: 'manual', pronouns: '',
        initialLocationId: null, lifecycle: 'active', portrayal: null,
      }],
    })
    expect(hashWorldJson('world-pack-characters-source/v2', parsed)).toBe(
      'sha256:5146021cd8973c3f573177681374beecf687a7c161d1f82cd830318ef825c633',
    )
  })

  it('preserves explicit scripted controller, lifecycle, location, and portrayal terms', () => {
    const input = {
      schemaVersion: 'worldpack-characters/v2',
      characters: [{
        characterId: 'character:alice', displayName: 'Alice', controllerClass: 'scripted', pronouns: 'she/her',
        initialLocationId: 'location:road', lifecycle: 'incapacitated',
        portrayal: {
          summary: 'A careful traveler', speakingStyle: 'direct', backgroundTextRef: 'text/alice.md',
          drives: [{ key: 'drive:arrive', text: 'Reach the station' }],
          principles: [{ key: 'principle:honesty', text: 'Do not lie' }],
        },
      }, {
        characterId: 'character:bob', displayName: 'Bob', controllerClass: 'scripted', lifecycle: 'dead', portrayal: {},
      }, {
        characterId: 'character:departed', displayName: 'Departed', controllerClass: 'manual', lifecycle: 'departed',
        initialLocationId: null, portrayal: null,
      }],
    }
    const parsed = parseWorldPackCharactersSourceV2(input)
    expect(parsed.characters[0]).toEqual(input.characters[0])
    expect(parsed.characters[1]?.portrayal).toEqual({ summary: '', speakingStyle: '', backgroundTextRef: null, drives: [], principles: [] })
    expect(parsed.characters[2]?.portrayal).toBeNull()
  })

  it.each([
    [null, 'PACK_SOURCE_INVALID'],
    [{ ...charactersV2(), schemaVersion: 'worldpack-characters/v1' }, 'PACK_SOURCE_INVALID'],
    [{ ...charactersV2(), characters: {} }, 'PACK_SOURCE_INVALID'],
    [{ ...charactersV2(), characters: Array.from({ length: 257 }, (_, index) => ({ characterId: `character:${index}`, displayName: 'X', controllerClass: 'manual' })) }, 'PACK_LIMIT_EXCEEDED'],
    [{ ...charactersV2(), characters: [charactersV2().characters[0], charactersV2().characters[0]] }, 'PACK_DUPLICATE_ID'],
    [{ ...charactersV2(), characters: [{ ...charactersV2().characters[0], extra: true }] }, 'PACK_UNKNOWN_FIELD'],
    [{ ...charactersV2(), characters: [{ ...charactersV2().characters[0], controllerClass: 'network' }] }, 'PACK_SOURCE_INVALID'],
    [{ ...charactersV2(), characters: [{ ...charactersV2().characters[0], pronouns: 1 }] }, 'PACK_SOURCE_INVALID'],
    [{ ...charactersV2(), characters: [{ ...charactersV2().characters[0], initialLocationId: 1 }] }, 'PACK_SOURCE_INVALID'],
    [{ ...charactersV2(), characters: [{ ...charactersV2().characters[0], lifecycle: 'missing' }] }, 'PACK_SOURCE_INVALID'],
    [{ ...charactersV2(), characters: [{ ...charactersV2().characters[0], portrayal: [] }] }, 'PACK_SOURCE_INVALID'],
    [{ ...charactersV2(), characters: [{ ...charactersV2().characters[0], portrayal: { extra: true } }] }, 'PACK_UNKNOWN_FIELD'],
    [{ ...charactersV2(), characters: [{ ...charactersV2().characters[0], portrayal: { summary: 1 } }] }, 'PACK_SOURCE_INVALID'],
    [{ ...charactersV2(), characters: [{ ...charactersV2().characters[0], portrayal: { speakingStyle: 1 } }] }, 'PACK_SOURCE_INVALID'],
    [{ ...charactersV2(), characters: [{ ...charactersV2().characters[0], portrayal: { backgroundTextRef: 1 } }] }, 'PACK_SOURCE_INVALID'],
    [{ ...charactersV2(), characters: [{ ...charactersV2().characters[0], portrayal: { drives: {} } }] }, 'PACK_SOURCE_INVALID'],
    [{ ...charactersV2(), characters: [{ ...charactersV2().characters[0], portrayal: { drives: Array.from({ length: 129 }, (_, index) => ({ key: `drive:${index}`, text: 'x' })) } }] }, 'PACK_LIMIT_EXCEEDED'],
    [{ ...charactersV2(), characters: [{ ...charactersV2().characters[0], portrayal: { drives: [{ key: 'same', text: 'a' }, { key: 'same', text: 'b' }] } }] }, 'PACK_DUPLICATE_ID'],
    [{ ...charactersV2(), characters: [{ ...charactersV2().characters[0], portrayal: { principles: [{ key: 'p', text: '' }] } }] }, 'PACK_SOURCE_INVALID'],
    [{ ...charactersV2(), characters: [{ ...charactersV2().characters[0], portrayal: { principles: [{ key: 'p', text: 'x', extra: true }] } }] }, 'PACK_UNKNOWN_FIELD'],
  ])('rejects malformed character sources %#', (value, code) => {
    expect(errorOf(() => parseWorldPackCharactersSourceV2(value)).diagnostics[0].code).toBe(code)
  })
})

describe('World Pack v2 Scene sources', () => {
  it('materializes nullable locations and permits empty non-active scenes', () => {
    const input = {
      ...scenesV2(),
      scenes: [
        { sceneId: 'scene:road', lifecycle: 'active', locationId: 'location:road', participantIds: ['character:player', 'character:alice'] },
        { sceneId: 'scene:future', lifecycle: 'created', participantIds: [] },
        { sceneId: 'scene:past', lifecycle: 'closed', locationId: null, participantIds: [] },
      ],
    }
    const parsed = parseWorldPackScenesSourceV2(input)
    expect(parsed.scenes[0]).toEqual(input.scenes[0])
    expect(parsed.scenes[1]?.locationId).toBeNull()
    expect(hashWorldJson('world-pack-scenes-source/v2', parsed)).toBe(
      'sha256:7f3392406bbea903a98de3d9799278a450a92b0bc2a26ecc4bb9e3ba965de540',
    )
  })

  it.each([
    [{ ...scenesV2(), schemaVersion: 'worldpack-scenes/v1' }, 'PACK_SOURCE_INVALID'],
    [{ ...scenesV2(), scenes: {} }, 'PACK_SOURCE_INVALID'],
    [{ ...scenesV2(), scenes: Array.from({ length: 513 }, (_, index) => ({ sceneId: `scene:${index}`, lifecycle: 'closed', participantIds: [] })) }, 'PACK_LIMIT_EXCEEDED'],
    [{ ...scenesV2(), scenes: [scenesV2().scenes[0], scenesV2().scenes[0]] }, 'PACK_DUPLICATE_ID'],
    [{ ...scenesV2(), scenes: [{ ...scenesV2().scenes[0], extra: true }] }, 'PACK_UNKNOWN_FIELD'],
    [{ ...scenesV2(), scenes: [{ ...scenesV2().scenes[0], lifecycle: 'paused' }] }, 'PACK_SOURCE_INVALID'],
    [{ ...scenesV2(), scenes: [{ ...scenesV2().scenes[0], participantIds: [] }] }, 'PACK_SOURCE_INVALID'],
    [{ ...scenesV2(), scenes: [{ ...scenesV2().scenes[0], participantIds: ['character:player', 'character:player'] }] }, 'PACK_DUPLICATE_ID'],
    [{ ...scenesV2(), scenes: [{ ...scenesV2().scenes[0], participantIds: {} }] }, 'PACK_SOURCE_INVALID'],
    [{ ...scenesV2(), scenes: [{ ...scenesV2().scenes[0], locationId: 1 }] }, 'PACK_SOURCE_INVALID'],
  ])('rejects malformed Scene sources %#', (value, code) => {
    expect(errorOf(() => parseWorldPackScenesSourceV2(value)).diagnostics[0].code).toBe(code)
  })
})

describe('World Pack v2 Memory profile sources', () => {
  it('materializes empty attention topics and accepts each registered logical profile', () => {
    const input = {
      ...memoryV2(),
      characters: [
        { characterId: 'character:alice', profile: 'compact', attentionTopics: ['late arrival'] },
        { characterId: 'character:bob', profile: 'standard' },
        { characterId: 'character:player', profile: 'deep', attentionTopics: [] },
      ],
    }
    const parsed = parseWorldPackMemorySourceV2(input)
    expect(parsed.characters).toEqual([
      input.characters[0],
      { characterId: 'character:bob', profile: 'standard', attentionTopics: [] },
      input.characters[2],
    ])
  })

  it.each([
    [{ ...memoryV2(), schemaVersion: 'worldpack-memory/v1' }, 'PACK_SOURCE_INVALID'],
    [{ ...memoryV2(), characters: {} }, 'PACK_SOURCE_INVALID'],
    [{ ...memoryV2(), characters: Array.from({ length: 257 }, (_, index) => ({ characterId: `character:${index}`, profile: 'standard' })) }, 'PACK_LIMIT_EXCEEDED'],
    [{ ...memoryV2(), characters: [memoryV2().characters[0], memoryV2().characters[0]] }, 'PACK_DUPLICATE_ID'],
    [{ ...memoryV2(), characters: [{ ...memoryV2().characters[0], extra: true }] }, 'PACK_UNKNOWN_FIELD'],
    [{ ...memoryV2(), characters: [{ ...memoryV2().characters[0], profile: 'unbounded' }] }, 'PACK_SOURCE_INVALID'],
    [{ ...memoryV2(), characters: [{ ...memoryV2().characters[0], attentionTopics: {} }] }, 'PACK_SOURCE_INVALID'],
    [{ ...memoryV2(), characters: [{ ...memoryV2().characters[0], attentionTopics: ['same', 'same'] }] }, 'PACK_DUPLICATE_ID'],
  ])('rejects malformed Memory profile sources %#', (value, code) => {
    expect(errorOf(() => parseWorldPackMemorySourceV2(value)).diagnostics[0].code).toBe(code)
  })
})

describe('World Pack v2 Document metadata', () => {
  it('accepts registered usage/audience pairs and materializes character scope', () => {
    const input = {
      ...documentsV2(),
      documents: [
        documentsV2().documents[0],
        { documentId: 'document:director', contentRef: 'text/director.md', usage: 'world_context', audience: 'director_visible' },
        { documentId: 'document:alice', contentRef: 'text/alice.md', usage: 'portrayal', audience: 'character_private', characterIds: ['character:alice'] },
        { documentId: 'document:memory', contentRef: 'text/bob.md', usage: 'memory_seed', audience: 'character_private', characterIds: ['character:bob'] },
        { documentId: 'document:author', contentRef: 'text/author.md', usage: 'author_note', audience: 'author_only' },
      ],
    }
    const parsed = parseWorldPackDocumentsSourceV2(input)
    expect(parsed.documents[0]?.characterIds).toEqual([])
    expect(parsed.documents[2]).toEqual(input.documents[2])
  })

  it.each([
    [{ ...documentsV2(), schemaVersion: 'worldpack-documents/v1' }, 'PACK_SOURCE_INVALID'],
    [{ ...documentsV2(), documents: {} }, 'PACK_SOURCE_INVALID'],
    [{ ...documentsV2(), documents: Array.from({ length: 513 }, (_, index) => ({ documentId: `document:${index}`, contentRef: `text/${index}.md`, usage: 'world_context', audience: 'public' })) }, 'PACK_LIMIT_EXCEEDED'],
    [{ ...documentsV2(), documents: [documentsV2().documents[0], documentsV2().documents[0]] }, 'PACK_DUPLICATE_ID'],
    [{ ...documentsV2(), documents: [{ ...documentsV2().documents[0], extra: true }] }, 'PACK_UNKNOWN_FIELD'],
    [{ ...documentsV2(), documents: [{ ...documentsV2().documents[0], usage: 'system_prompt' }] }, 'PACK_SOURCE_INVALID'],
    [{ ...documentsV2(), documents: [{ ...documentsV2().documents[0], audience: 'everyone' }] }, 'PACK_SOURCE_INVALID'],
    [{ ...documentsV2(), documents: [{ ...documentsV2().documents[0], audience: 'character_private' }] }, 'PACK_SOURCE_INVALID'],
    [{ ...documentsV2(), documents: [{ ...documentsV2().documents[0], characterIds: ['character:alice'] }] }, 'PACK_SOURCE_INVALID'],
    [{ ...documentsV2(), documents: [{ ...documentsV2().documents[0], usage: 'portrayal' }] }, 'PACK_SOURCE_INVALID'],
    [{ ...documentsV2(), documents: [{ ...documentsV2().documents[0], usage: 'memory_seed' }] }, 'PACK_SOURCE_INVALID'],
    [{ ...documentsV2(), documents: [{ ...documentsV2().documents[0], usage: 'author_note' }] }, 'PACK_SOURCE_INVALID'],
    [{ ...documentsV2(), documents: [{ ...documentsV2().documents[0], characterIds: {} }] }, 'PACK_SOURCE_INVALID'],
    [{ ...documentsV2(), documents: [{ ...documentsV2().documents[0], audience: 'character_private', characterIds: ['character:alice', 'character:alice'] }] }, 'PACK_DUPLICATE_ID'],
  ])('rejects malformed Document metadata %#', (value, code) => {
    expect(errorOf(() => parseWorldPackDocumentsSourceV2(value)).diagnostics[0].code).toBe(code)
  })
})
