import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { canonicalizeWorldJson, PHASE8_REGISTRY_LOCKS, PHASE8_VOCABULARY_LOCKS, type WorldJsonValue } from '@harness-world/contracts'
import {
  WorldPackCompilerV2,
  canonicalWorldPackBytesV2,
  verifyCompiledWorldPackV2,
} from './compiler.ts'
import { WorldPackContractError } from './diagnostics.ts'

const roots: string[] = []

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'world-pack-v2-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

function sourceManifest(overrides: Record<string, unknown> = {}): WorldJsonValue {
  return {
    sourceSchemaVersion: 'worldpack-source/v2', packId: 'pack:rain-road', packVersion: '2.0.0',
    worldFile: 'world.json', characterFiles: ['characters.json'], locationFiles: ['locations.json'],
    entityFiles: ['entities.json'], sceneFiles: ['scenes.json'], playerSlotFiles: ['player-slots.json'],
    presentationFiles: ['presentation.json'], cognitionFiles: ['cognition.json'], memoryFiles: ['memory.json'],
    documentFiles: ['documents.json'], markdownFiles: ['text/alice.md'], assetFiles: ['assets/a.bin', 'assets/b.bin'], assertionFiles: ['assertions.json'],
    ...overrides,
  } as WorldJsonValue
}

const sourceDocuments: Record<string, WorldJsonValue> = {
  'world.json': {
    schemaVersion: 'worldpack-world/v1', title: 'Rain Road',
    initialFacts: [{ factId: 'fact:late', proposition: { text: 'Bob arrived late' }, initialAudience: ['character:player', 'character:alice'] }],
  },
  'locations.json': { schemaVersion: 'worldpack-locations/v1', locations: [
    { locationId: 'location:station', name: 'Station' }, { locationId: 'location:road', name: 'Road' },
  ] },
  'entities.json': { schemaVersion: 'worldpack-entities/v1', entities: [
    { entityId: 'entity:umbrella', locationId: 'location:road', kind: 'umbrella' },
    { entityId: 'entity:ticket', locationId: 'location:road', kind: 'ticket' },
  ] },
  'characters.json': {
    schemaVersion: 'worldpack-characters/v2', characters: [
      { characterId: 'character:player', displayName: 'Player', controllerClass: 'manual', initialLocationId: 'location:road' },
      {
        characterId: 'character:alice', displayName: 'Alice', controllerClass: 'scripted', initialLocationId: 'location:road',
        portrayal: {
          summary: 'A careful traveler', speakingStyle: 'direct', backgroundTextRef: 'text/alice.md',
          drives: [{ key: 'drive:arrive', text: 'Reach the station' }],
          principles: [{ key: 'principle:privacy', text: 'Respect privacy' }],
        },
      },
      { characterId: 'character:bob', displayName: 'Bob', controllerClass: 'scripted', initialLocationId: 'location:road' },
    ],
  },
  'scenes.json': {
    schemaVersion: 'worldpack-scenes/v2',
    scenes: [
      { sceneId: 'scene:station', lifecycle: 'created', locationId: 'location:station', participantIds: ['character:bob'] },
      { sceneId: 'scene:road', lifecycle: 'active', locationId: 'location:road', participantIds: ['character:player', 'character:alice', 'character:bob'] },
    ],
  },
  'player-slots.json': { schemaVersion: 'worldpack-player-slots/v1', playerSlots: [{ slotId: 'slot:player', characterId: 'character:player' }] },
  'presentation.json': { schemaVersion: 'worldpack-presentation/v1', locale: 'zh-CN' },
  'cognition.json': {
    schemaVersion: 'worldpack-cognition/v2', characters: [{
      characterId: 'character:alice',
      observations: [{ key: 'observation:late', content: { text: 'Bob arrived late' }, epistemicKind: 'direct_observation' }],
      claims: [{ key: 'claim:irresponsible', proposition: { text: 'Bob is irresponsible' }, stance: 'believed', confidencePermille: 700, basisKeys: ['observation:late'] }],
      goals: [{
        key: 'goal:continue', objective: { kind: 'narrative', value: 'Continue the journey' }, status: 'blocked',
        targetKeys: ['entity:ticket'], blockerKeys: ['claim:irresponsible'], basisKeys: ['claim:irresponsible'],
      }, {
        key: 'goal:ask', objective: { kind: 'narrative', value: 'Ask Bob' }, parentGoalKey: 'goal:continue',
        targetKeys: ['character:bob'], basisKeys: ['observation:late'],
      }],
      relationships: [{
        key: 'relationship:bob-honesty', target: 'character:bob', type: 'distrust', facet: 'honesty',
        intensityPermille: 600, basisKeys: ['observation:late'],
      }],
      affects: [{
        key: 'affect:anxiety', type: 'anxiety', intensityPermille: 500, cause: { key: 'claim:irresponsible' },
        targetKey: 'character:bob', status: 'resolved', basisKeys: ['claim:irresponsible'],
      }],
      innerTensions: [{
        key: 'tension:ask-or-cooperate', title: 'Ask or cooperate', pressurePermille: 650, basisKeys: ['goal:continue'],
        poles: [
          { key: 'pole:ask', tendency: 'express', impulseText: 'Ask now', strengthPermille: 600, awareness: 'conscious', basisKeys: ['claim:irresponsible'] },
          { key: 'pole:cooperate', tendency: 'preserve', impulseText: 'Keep moving', strengthPermille: 700, awareness: 'partially_conscious', basisKeys: ['drive:arrive'] },
        ],
      }],
      commitments: [{ key: 'commitment:travel', content: 'Travel together', origin: 'agreement', basisKeys: ['observation:late'] }],
      openLoops: [{ key: 'loop:late', kind: 'question', summary: 'Why was Bob late?', status: 'answered', basisKeys: ['observation:late'] }],
    }, { characterId: 'character:bob' }],
  },
  'memory.json': { schemaVersion: 'worldpack-memory/v2', characters: [
    { characterId: 'character:bob', profile: 'deep' },
    { characterId: 'character:alice', profile: 'compact', attentionTopics: ['late arrival'] },
  ] },
  'documents.json': {
    schemaVersion: 'worldpack-documents/v2',
    documents: [
      { documentId: 'document:world', contentRef: 'text/alice.md', usage: 'world_context', audience: 'public' },
      { documentId: 'document:alice', contentRef: 'text/alice.md', usage: 'portrayal', audience: 'character_private', characterIds: ['character:alice'] },
    ],
  },
  'assertions.json': { schemaVersion: 'worldpack-assertions/v1', assertions: [
    { assertionId: 'assertion:b', assertionType: 'view.includes', parameters: { characterId: 'character:bob' } },
    { assertionId: 'assertion:a', assertionType: 'view.includes', parameters: { characterId: 'character:alice' } },
  ] },
}

async function writeJson(root: string, path: string, value: WorldJsonValue): Promise<void> {
  const target = join(root, ...path.split('/'))
  await mkdir(join(target, '..'), { recursive: true })
  await writeFile(target, canonicalizeWorldJson(value))
}

async function writePack(root: string, manifest = sourceManifest()): Promise<void> {
  await writeJson(root, 'worldpack.source.json', manifest)
  for (const [path, value] of Object.entries(sourceDocuments)) await writeJson(root, path, value)
  await mkdir(join(root, 'text'), { recursive: true })
  await writeFile(join(root, 'text', 'alice.md'), 'Alice keeps the group moving.\n', 'utf8')
  await mkdir(join(root, 'assets'), { recursive: true })
  await writeFile(join(root, 'assets', 'a.bin'), new Uint8Array([1]))
  await writeFile(join(root, 'assets', 'b.bin'), new Uint8Array([2, 3]))
}

function records(document: Record<string, unknown>, key: string): Array<Record<string, unknown>> {
  return document[key] as Array<Record<string, unknown>>
}

async function compileChanged(
  file: string,
  change: (document: Record<string, unknown>) => void,
  code: string,
): Promise<void> {
  const root = await temporaryRoot(); await writePack(root)
  const document = structuredClone(sourceDocuments[file]) as Record<string, unknown>
  change(document)
  await writeJson(root, file, document as WorldJsonValue)
  await rejected(() => new WorldPackCompilerV2().compile(root), code)
}

function contractError(error: unknown): WorldPackContractError {
  expect(error).toBeInstanceOf(WorldPackContractError)
  return error as WorldPackContractError
}

async function rejected(run: () => Promise<unknown>, code: string): Promise<WorldPackContractError> {
  try {
    await run()
  } catch (error) {
    const contract = contractError(error)
    expect(contract.diagnostics[0]?.code).toBe(code)
    return contract
  }
  throw new Error('expected WorldPackContractError')
}

describe('WorldPackCompilerV2', () => {
  it('compiles deterministic cognition, Scene, vocabulary and registry locks', async () => {
    const root = await temporaryRoot(); await writePack(root)
    const compiler = new WorldPackCompilerV2()
    const first = await compiler.compile(root)
    const second = await compiler.compile(root)
    expect(first).toEqual(second)
    expect(first).toMatchObject({
      compiledSchemaVersion: 'worldpack/v2', packId: 'pack:rain-road', packVersion: '2.0.0',
      compiler: { version: '0.2.0', contractVersion: 'worldpack-compiler/v2', limitsProfile: 'worldpack-limits/v2' },
      content: { world: { coreProfiles: { sceneDecision: { version: '2.0.0' } } } },
    })
    expect(first.vocabularyLocks).toEqual(PHASE8_VOCABULARY_LOCKS)
    expect(first.registryLocks).toEqual(PHASE8_REGISTRY_LOCKS)
    expect(first.content.cognition.map(value => value.characterId)).toEqual(['character:alice', 'character:bob', 'character:player'])
    expect(first.content.memory.map(value => value.characterId)).toEqual(['character:alice', 'character:bob', 'character:player'])
    expect(first.content.memory[2]).toMatchObject({ profile: 'standard', attentionTopics: [] })
    expect(first.packHash).toBe('sha256:f317c8d836d491bdc28a7b8a512546e05ff8899ff085fc293ee42d8a3ff8c3b1')
    expect(verifyCompiledWorldPackV2(first)).toEqual(first)
    expect(canonicalWorldPackBytesV2(first)).toEqual(canonicalizeWorldJson(first))
  })

  it('rejects altered hashes, registries, compiler identity and compiled references', async () => {
    const root = await temporaryRoot(); await writePack(root)
    const pack = await new WorldPackCompilerV2().compile(root)
    for (const changed of [
      { ...pack, packHash: `sha256:${'0'.repeat(64)}` },
      { ...pack, compiledSchemaVersion: 'worldpack/v1' },
      { ...pack, compiler: { ...pack.compiler, version: '9.0.0' } },
      { ...pack, registryLocks: pack.registryLocks.slice(1) },
      { ...pack, vocabularyLocks: pack.vocabularyLocks.slice(1) },
      { ...pack, pluginLocks: pack.pluginLocks.slice(1) },
      { ...pack, content: { ...pack.content, documents: [{ ...pack.content.documents[0]!, contentRef: 'text/missing.md' }] } },
    ]) {
      expect(() => verifyCompiledWorldPackV2(changed)).toThrow(WorldPackContractError)
    }
  })

  it('rejects invalid compile options and source roots', async () => {
    const compiler = new WorldPackCompilerV2()
    await rejected(() => compiler.compile('missing-v2-pack'), 'PACK_SOURCE_INVALID')
    const root = await temporaryRoot(); await writePack(root)
    await rejected(() => compiler.compile(root, { limitsProfile: 'worldpack-limits/v1' as 'worldpack-limits/v2' }), 'PACK_PROFILE_NOT_ALLOWED')
    const file = join(root, 'not-a-directory'); await writeFile(file, 'x')
    await rejected(() => compiler.compile(file), 'PACK_SOURCE_INVALID')
  })

  it('rejects invalid Phase 8 world profiles, versions, time modes, presentation cardinality and Markdown bytes', async () => {
    await compileChanged('world.json', value => { value.schemaVersion = 'worldpack-world/v2' }, 'PACK_SOURCE_INVALID')
    await compileChanged('world.json', value => { value.timeMode = 'REALTIME' }, 'PACK_SOURCE_INVALID')
    await compileChanged('world.json', value => {
      value.coreProfiles = {
        rulebook: { rulebookId: 'builtin:speak-move', version: 2 },
        sceneDecision: { pluginId: 'builtin:scene-decision', version: '1.0.0' },
        agentContext: { pluginId: 'builtin:agent-context', version: '2.0.0' },
        presentation: { profileId: 'builtin:deterministic-presentation', version: '1.0.0' },
      }
    }, 'PACK_PROFILE_NOT_ALLOWED')
    const cardinality = await temporaryRoot(); await writePack(cardinality, sourceManifest({ presentationFiles: ['presentation.json', 'presentation-two.json'] }))
    await writeJson(cardinality, 'presentation-two.json', sourceDocuments['presentation.json']!)
    await rejected(() => new WorldPackCompilerV2().compile(cardinality), 'PACK_SOURCE_INVALID')
    const withoutFacts = await temporaryRoot(); await writePack(withoutFacts)
    const worldWithoutFacts = structuredClone(sourceDocuments['world.json']) as Record<string, unknown>
    delete worldWithoutFacts.initialFacts
    await writeJson(withoutFacts, 'world.json', worldWithoutFacts as WorldJsonValue)
    expect((await new WorldPackCompilerV2().compile(withoutFacts)).content.world.initialFacts).toEqual([])
    const markdown = await temporaryRoot(); await writePack(markdown)
    await writeFile(join(markdown, 'text', 'alice.md'), 'bare\rreturn', 'utf8')
    await rejected(() => new WorldPackCompilerV2().compile(markdown), 'PACK_SOURCE_INVALID')
  })

  it('rejects invalid location, entity, Scene, player and fact references', async () => {
    await compileChanged('characters.json', value => { records(value, 'characters')[0]!.initialLocationId = 'location:missing' }, 'PACK_REFERENCE_INVALID')
    await compileChanged('characters.json', value => {
      const portrayal = records(value, 'characters')[1]!.portrayal as Record<string, unknown>; portrayal.backgroundTextRef = 'text/missing.md'
    }, 'PACK_REFERENCE_INVALID')
    await compileChanged('entities.json', value => { records(value, 'entities')[0]!.locationId = 'location:missing' }, 'PACK_REFERENCE_INVALID')
    await compileChanged('scenes.json', value => { records(value, 'scenes')[0]!.locationId = 'location:missing' }, 'PACK_REFERENCE_INVALID')
    await compileChanged('scenes.json', value => { records(value, 'scenes')[0]!.participantIds = ['character:missing'] }, 'PACK_REFERENCE_INVALID')
    await compileChanged('scenes.json', value => {
      records(value, 'scenes').push({ sceneId: 'scene:duplicate', lifecycle: 'active', participantIds: ['character:alice'] })
    }, 'PACK_REFERENCE_INVALID')
    await compileChanged('player-slots.json', value => { records(value, 'playerSlots')[0]!.characterId = 'character:missing' }, 'PACK_REFERENCE_INVALID')
    await compileChanged('characters.json', value => { records(value, 'characters')[0]!.controllerClass = 'scripted' }, 'PACK_REFERENCE_INVALID')
    await compileChanged('world.json', value => {
      const facts = value.initialFacts as Array<Record<string, unknown>>; facts[0]!.initialAudience = ['character:missing']
    }, 'PACK_REFERENCE_INVALID')
    const multiplePlayers = await temporaryRoot()
    await writePack(multiplePlayers, sourceManifest({ playerSlotFiles: ['player-slots.json', 'player-slots-two.json'] }))
    await writeJson(multiplePlayers, 'player-slots-two.json', {
      schemaVersion: 'worldpack-player-slots/v1', playerSlots: [{ slotId: 'slot:second', characterId: 'character:player' }],
    })
    await rejected(() => new WorldPackCompilerV2().compile(multiplePlayers), 'PACK_SOURCE_INVALID')
  })

  it('rejects invalid cognition, memory and Document references', async () => {
    await compileChanged('memory.json', value => { records(value, 'characters')[0]!.characterId = 'character:missing' }, 'PACK_REFERENCE_INVALID')
    await compileChanged('cognition.json', value => { records(value, 'characters')[0]!.characterId = 'character:missing' }, 'PACK_REFERENCE_INVALID')
    await compileChanged('cognition.json', value => {
      const relationships = records(records(value, 'characters')[0]!, 'relationships'); relationships[0]!.target = 'character:missing'
    }, 'PACK_REFERENCE_INVALID')
    await compileChanged('cognition.json', value => {
      const goals = records(records(value, 'characters')[0]!, 'goals'); goals[1]!.parentGoalKey = 'goal:missing'
    }, 'PACK_REFERENCE_INVALID')
    await compileChanged('cognition.json', value => {
      const goals = records(records(value, 'characters')[0]!, 'goals'); goals[0]!.targetKeys = ['entity:missing']
    }, 'PACK_REFERENCE_INVALID')
    await compileChanged('cognition.json', value => {
      const affects = records(records(value, 'characters')[0]!, 'affects'); affects[0]!.targetKey = 'character:missing'
    }, 'PACK_REFERENCE_INVALID')
    await compileChanged('documents.json', value => { records(value, 'documents')[0]!.contentRef = 'text/missing.md' }, 'PACK_REFERENCE_INVALID')
    await compileChanged('documents.json', value => { records(value, 'documents')[1]!.characterIds = ['character:missing'] }, 'PACK_REFERENCE_INVALID')
  })

  it('rejects forbidden or cyclic cognition provenance and portrayal key collisions', async () => {
    await compileChanged('cognition.json', value => {
      const claims = records(records(value, 'characters')[0]!, 'claims'); claims[0]!.basisKeys = ['claim:missing']
    }, 'PACK_REFERENCE_INVALID')
    await compileChanged('cognition.json', value => {
      const character = records(value, 'characters')[0]!
      const observations = records(character, 'observations'); observations[0]!.basisKeys = ['claim:irresponsible']
    }, 'PACK_REFERENCE_INVALID')
    await compileChanged('characters.json', value => {
      const portrayal = records(value, 'characters')[1]!.portrayal as Record<string, unknown>
      portrayal.principles = [{ key: 'drive:arrive', text: 'Duplicate across portrayal kinds' }]
    }, 'PACK_DUPLICATE_ID')
  })

  it('enforces both per-kind and aggregate cognition profile capacity', async () => {
    await compileChanged('cognition.json', value => {
      const character = records(value, 'characters')[0]!
      character.claims = Array.from({ length: 9 }, (_, index) => ({
        key: `claim:${index}`, proposition: { index }, stance: 'believed', confidencePermille: 500,
      }))
      character.goals = []
      character.relationships = []
      character.affects = []
      character.innerTensions = []
      character.commitments = []
      character.openLoops = []
    }, 'PACK_LIMIT_EXCEEDED')
    await compileChanged('cognition.json', value => {
      const character = records(value, 'characters')[0]!
      character.claims = Array.from({ length: 8 }, (_, index) => ({
        key: `claim:${index}`, proposition: { index }, stance: 'believed', confidencePermille: 500,
      }))
      character.goals = Array.from({ length: 4 }, (_, index) => ({
        key: `goal:${index}`, objective: { kind: 'narrative', value: `Goal ${index}` },
      }))
      character.relationships = [{
        key: 'relationship:one', target: 'character:bob', type: 'trust', facet: 'ability', intensityPermille: 500,
      }]
      character.affects = []
      character.innerTensions = []
      character.commitments = []
      character.openLoops = []
    }, 'PACK_LIMIT_EXCEEDED')
  })
})
