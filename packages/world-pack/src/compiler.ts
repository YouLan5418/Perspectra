import { createHash } from 'node:crypto'
import { lstat, readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  canonicalizeWorldJson,
  compareWorldText,
  deterministicId,
  hashWorldJson,
  PHASE8_CONTEXT_PROFILES,
  PHASE8_REGISTRY_LOCKS,
  PHASE8_VOCABULARY_LOCKS,
  type WorldHash,
  type WorldEventDraft,
  type WorldJsonObject,
  type WorldJsonValue,
} from '@harness-world/contracts'
import {
  phase8ManifestRegistries,
  manifestationManifestRegistries,
  WorldSpecCompiler,
  type CompiledWorldManifestV4,
  type CompiledWorldManifestV5,
  type CompiledWorldManifestV6,
  type CompiledWorldManifestV3,
  type CompiledWorldSpec,
  type ContentPackCharacterSpec,
  type ContentPackCharacterSpecV2,
  type ContentPackManifestBinding,
  type ContentPackManifestBindingV2,
  type SceneSpecV2,
} from '@harness-world/kernel'
import {
  PHASE7_CORE_PROFILES,
  PHASE8_CORE_PROFILES,
  WORLD_PACK_COMPILED_SCHEMA_VERSION,
  WORLD_PACK_COMPILER_CONTRACT_VERSION,
  WORLD_PACK_COMPILER_ID,
  WORLD_PACK_COMPILER_VERSION,
  WORLD_PACK_LIMITS_PROFILE,
  WORLD_PACK_COMPILED_SCHEMA_VERSION_V2,
  WORLD_PACK_COMPILED_SCHEMA_VERSION_V3,
  WORLD_PACK_COMPILED_SCHEMA_VERSION_V4,
  WORLD_PACK_COMPILER_CONTRACT_VERSION_V2,
  WORLD_PACK_COMPILER_CONTRACT_VERSION_V3,
  WORLD_PACK_COMPILER_CONTRACT_VERSION_V4,
  WORLD_PACK_COMPILER_VERSION_V2,
  WORLD_PACK_COMPILER_VERSION_V3,
  WORLD_PACK_COMPILER_VERSION_V4,
  WORLD_PACK_LIMITS_PROFILE_V2,
  WORLD_PACK_SOURCE_SCHEMA_VERSION_V2,
  WORLD_PACK_SOURCE_SCHEMA_VERSION_V3,
  WORLD_PACK_SOURCE_SCHEMA_VERSION_V4,
  type CompiledWorldPackV3,
  type CompiledWorldPackV4,
  type CompiledWorldPackV2,
  type CompiledWorldPack,
  type WorldPackAcceptanceAssertion,
  type WorldPackAssetLock,
  type WorldPackCharacterSource,
  type WorldPackCharacterCognitionSourceV2,
  type WorldPackCharacterMemorySourceV2,
  type WorldPackCharacterSourceV2,
  type WorldPackCompiledContent,
  type WorldPackCompileOptions,
  type WorldPackCompileOptionsV2,
  type WorldPackCompiledContentV2,
  type WorldPackDocumentSourceV2,
  type WorldPackEntitySource,
  type WorldPackLocationSource,
  type WorldPackMarkdownContent,
  type WorldPackPlayerSlotSource,
  type WorldPackPluginLock,
  type WorldPackRuntimeOptions,
  type WorldPackSceneSource,
  type WorldPackSceneSourceV2,
  type WorldPackSourceManifest,
  type WorldPackSourceManifestV2,
  type WorldPackSourceManifestV3,
  type WorldPackSourceManifestV4,
  type WorldPackReactionSource,
  type WorldPackManifestationSource,
} from './contracts.ts'
import { failWorldPackContract } from './diagnostics.ts'
import {
  parseCompiledWorldPack,
  parseCompiledWorldPackV2,
  parseCompiledWorldPackV3,
  parseCompiledWorldPackV4,
  parseWorldPackAssertionsSource,
  parseWorldPackCharactersSource,
  parseWorldPackCharactersSourceV2,
  parseWorldPackCognitionSourceV2,
  parseWorldPackDocumentsSourceV2,
  parseWorldPackEntitiesSource,
  parseWorldPackLocationsSource,
  parseWorldPackMemorySourceV2,
  parseWorldPackPlayerSlotsSource,
  parseWorldPackPresentationSource,
  parseWorldPackScenesSource,
  parseWorldPackScenesSourceV2,
  parseWorldPackSourceManifest,
  parseWorldPackSourceManifestV2,
  parseWorldPackSourceManifestV3,
  parseWorldPackSourceManifestV4,
  parseWorldPackReactionSource,
  parseWorldPackManifestationSource,
  parseWorldPackWorldSource,
  parseWorldPackWorldSourceV2,
} from './schema.ts'
import { parseStrictWorldJson } from './strict-json.ts'

const MAX_TOTAL_BYTES = 16 * 1024 * 1024
const MAX_JSON_BYTES = 1024 * 1024
const MAX_MARKDOWN_BYTES = 256 * 1024
const MAX_ASSET_BYTES = 8 * 1024 * 1024
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu

interface UnsignedCompiledWorldPack extends WorldJsonObject {
  readonly compiledSchemaVersion: typeof WORLD_PACK_COMPILED_SCHEMA_VERSION
  readonly packId: CompiledWorldPack['packId']
  readonly packVersion: string
  readonly compiler: CompiledWorldPack['compiler']
  readonly pluginLocks: readonly WorldPackPluginLock[]
  readonly content: WorldPackCompiledContent
  readonly assets: readonly WorldPackAssetLock[]
  readonly acceptanceAssertions: readonly WorldPackAcceptanceAssertion[]
}

interface UnsignedCompiledWorldPackV2 extends WorldJsonObject {
  readonly compiledSchemaVersion: typeof WORLD_PACK_COMPILED_SCHEMA_VERSION_V2
  readonly packId: CompiledWorldPackV2['packId']
  readonly packVersion: string
  readonly compiler: CompiledWorldPackV2['compiler']
  readonly pluginLocks: CompiledWorldPackV2['pluginLocks']
  readonly vocabularyLocks: CompiledWorldPackV2['vocabularyLocks']
  readonly registryLocks: CompiledWorldPackV2['registryLocks']
  readonly content: WorldPackCompiledContentV2
  readonly assets: readonly WorldPackAssetLock[]
  readonly acceptanceAssertions: readonly WorldPackAcceptanceAssertion[]
}

interface UnsignedCompiledWorldPackV3 extends WorldJsonObject {
  readonly compiledSchemaVersion: typeof WORLD_PACK_COMPILED_SCHEMA_VERSION_V3
  readonly packId: CompiledWorldPackV3['packId']
  readonly packVersion: string
  readonly compiler: CompiledWorldPackV3['compiler']
  readonly pluginLocks: CompiledWorldPackV3['pluginLocks']
  readonly vocabularyLocks: CompiledWorldPackV3['vocabularyLocks']
  readonly registryLocks: CompiledWorldPackV3['registryLocks']
  readonly reaction: WorldPackReactionSource
  readonly content: WorldPackCompiledContentV2
  readonly assets: readonly WorldPackAssetLock[]
  readonly acceptanceAssertions: readonly WorldPackAcceptanceAssertion[]
}

interface UnsignedCompiledWorldPackV4 extends WorldJsonObject {
  readonly compiledSchemaVersion: typeof WORLD_PACK_COMPILED_SCHEMA_VERSION_V4
  readonly packId: CompiledWorldPackV4['packId']
  readonly packVersion: string
  readonly compiler: CompiledWorldPackV4['compiler']
  readonly pluginLocks: CompiledWorldPackV4['pluginLocks']
  readonly vocabularyLocks: CompiledWorldPackV4['vocabularyLocks']
  readonly registryLocks: CompiledWorldPackV4['registryLocks']
  readonly reaction: WorldPackReactionSource
  readonly manifestation: WorldPackManifestationSource
  readonly content: WorldPackCompiledContentV2
  readonly assets: readonly WorldPackAssetLock[]
  readonly acceptanceAssertions: readonly WorldPackAcceptanceAssertion[]
}

interface SourceBudget { bytes: number }

const compareText = compareWorldText

function rawHash(bytes: Uint8Array): WorldHash {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

function packHash(unsigned: UnsignedCompiledWorldPack): WorldHash {
  return hashWorldJson('compiled-world-pack/v1', unsigned)
}

function packHashV2(unsigned: UnsignedCompiledWorldPackV2): WorldHash {
  return hashWorldJson('compiled-world-pack/v2', unsigned)
}

function packHashV3(unsigned: UnsignedCompiledWorldPackV3): WorldHash {
  return hashWorldJson('compiled-world-pack/v3', unsigned)
}

function packHashV4(unsigned: UnsignedCompiledWorldPackV4): WorldHash {
  return hashWorldJson('compiled-world-pack/v4', unsigned)
}

function isMemorySeedDocument(value: WorldPackDocumentSourceV2): boolean {
  return value.usage === 'memory_seed'
}

function cognitiveSourceRef(
  pack: CompiledWorldPack,
  sourceType: 'character-observation' | 'character-claim' | 'character-goal' | 'initial-fact',
  sourceId: string,
  characterId: string,
): WorldJsonObject {
  return {
    kind: 'world-pack-source/v1',
    packId: pack.packId,
    packVersion: pack.packVersion,
    packHash: pack.packHash,
    sourceType,
    sourceId,
    characterId,
  }
}

function contentPackBinding(pack: CompiledWorldPack): ContentPackManifestBinding {
  return {
    schemaVersion: 1,
    packId: pack.packId,
    packVersion: pack.packVersion,
    packHash: pack.packHash,
    compiler: pack.compiler,
    pluginLocks: pack.pluginLocks,
    runtimeCapabilities: { publicSpeechObservationVersion: 1 },
    presentation: pack.content.presentation,
    initialFacts: pack.content.world.initialFacts,
  }
}

function normalizedSourcePath(value: string, manifestFile: string): string {
  if (value.includes('\\') || value.includes(':') || value.startsWith('/') || isAbsolute(value)) {
    failWorldPackContract('PACK_SOURCE_INVALID', manifestFile, '', `path ${JSON.stringify(value)} must be portable and relative`)
  }
  const segments = value.split('/')
  if (segments.some(segment => segment.length === 0 || segment === '.' || segment === '..'
    || segment.endsWith('.') || segment.endsWith(' ') || WINDOWS_DEVICE.test(segment))) {
    failWorldPackContract('PACK_SOURCE_INVALID', manifestFile, '', `path ${JSON.stringify(value)} contains an unsafe segment`)
  }
  return segments.join('/')
}

function withinRoot(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate)
  return pathFromRoot === '' || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== '..' && !isAbsolute(pathFromRoot))
}

async function sourceFile(root: string, sourcePath: string, manifestFile: string): Promise<string> {
  const portable = normalizedSourcePath(sourcePath, manifestFile)
  const candidate = resolve(join(root, ...portable.split('/')))
  try {
    const actual = await realpath(candidate)
    if (!withinRoot(root, actual)) failWorldPackContract('PACK_SOURCE_INVALID', manifestFile, '', `path ${JSON.stringify(sourcePath)} resolves outside the source directory`)
    const info = await lstat(actual)
    if (!info.isFile()) failWorldPackContract('PACK_SOURCE_INVALID', sourcePath, '', 'must reference a regular file')
    return actual
  } catch (error) {
    if (error instanceof Error && error.name === 'WorldPackContractError') throw error
    failWorldPackContract('PACK_REFERENCE_INVALID', sourcePath, '', `cannot read declared file: ${String(error)}`)
  }
}

function addBudget(budget: SourceBudget, bytes: number, file: string): void {
  budget.bytes += bytes
  if (budget.bytes > MAX_TOTAL_BYTES) failWorldPackContract('PACK_LIMIT_EXCEEDED', file, '', `source directory exceeds ${MAX_TOTAL_BYTES} declared bytes`)
}

function decodeUtf8(bytes: Uint8Array, file: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch (error) {
    failWorldPackContract('PACK_SOURCE_INVALID', file, '', `must be valid UTF-8: ${String(error)}`)
  }
}

async function loadBytes(root: string, sourcePath: string, manifestFile: string, budget: SourceBudget, limit: number): Promise<Uint8Array> {
  const file = await sourceFile(root, sourcePath, manifestFile)
  const bytes = await readFile(file)
  if (bytes.byteLength > limit) failWorldPackContract('PACK_LIMIT_EXCEEDED', sourcePath, '', `exceeds the ${limit}-byte file limit`)
  addBudget(budget, bytes.byteLength, sourcePath)
  return bytes
}

async function loadJson(root: string, sourcePath: string, manifestFile: string, budget: SourceBudget): Promise<WorldJsonValue> {
  return parseStrictWorldJson(decodeUtf8(await loadBytes(root, sourcePath, manifestFile, budget, MAX_JSON_BYTES), sourcePath), sourcePath)
}

type AnyWorldPackSourceManifest = WorldPackSourceManifest | WorldPackSourceManifestV2 | WorldPackSourceManifestV3 | WorldPackSourceManifestV4

function allDeclaredFiles(manifest: AnyWorldPackSourceManifest): readonly string[] {
  const phase8Files = manifest.sourceSchemaVersion === WORLD_PACK_SOURCE_SCHEMA_VERSION_V2
    || manifest.sourceSchemaVersion === WORLD_PACK_SOURCE_SCHEMA_VERSION_V3
    || manifest.sourceSchemaVersion === WORLD_PACK_SOURCE_SCHEMA_VERSION_V4
    ? [...manifest.cognitionFiles, ...manifest.memoryFiles, ...manifest.documentFiles]
    : []
  const phase9Files = manifest.sourceSchemaVersion === WORLD_PACK_SOURCE_SCHEMA_VERSION_V3
    || manifest.sourceSchemaVersion === WORLD_PACK_SOURCE_SCHEMA_VERSION_V4 ? [manifest.reactionFile] : []
  const manifestationFiles = manifest.sourceSchemaVersion === WORLD_PACK_SOURCE_SCHEMA_VERSION_V4
    ? [manifest.manifestationFile]
    : []
  return [manifest.worldFile, ...manifest.characterFiles, ...manifest.locationFiles, ...manifest.entityFiles, ...manifest.sceneFiles,
    ...manifest.playerSlotFiles, ...manifest.presentationFiles, ...phase8Files, ...phase9Files, ...manifestationFiles, ...manifest.markdownFiles, ...manifest.assetFiles,
    ...manifest.assertionFiles]
}

function validatePortablePaths(manifest: AnyWorldPackSourceManifest, file: string): void {
  const paths = allDeclaredFiles(manifest).map(value => normalizedSourcePath(value, file))
  const folded = paths.map(value => value.toLowerCase())
  if (new Set(folded).size !== folded.length) failWorldPackContract('PACK_SOURCE_INVALID', file, '', 'declared paths collide when compared case-insensitively')
}

function uniqueAcross(values: readonly string[], file: string, at: string): void {
  if (new Set(values).size !== values.length) failWorldPackContract('PACK_DUPLICATE_ID', file, at, 'contains duplicate identifiers across source files')
}

function validateReferences(content: WorldPackCompiledContent): void {
  const locations = new Set(content.locations.map(value => value.locationId))
  const characters = new Set(content.characters.map(value => value.characterId))
  const markdown = new Set(content.markdown.map(value => value.path))
  for (const character of content.characters) {
    if (!locations.has(character.initialLocationId)) failWorldPackContract('PACK_REFERENCE_INVALID', 'characters', '', `character ${character.characterId} references unknown location ${character.initialLocationId}`)
    if (character.portrayal.backgroundTextRef !== null && !markdown.has(character.portrayal.backgroundTextRef)) {
      failWorldPackContract('PACK_REFERENCE_INVALID', 'characters', '', `character ${character.characterId} references unknown Markdown ${character.portrayal.backgroundTextRef}`)
    }
  }
  for (const entity of content.entities) {
    if (!locations.has(entity.locationId)) failWorldPackContract('PACK_REFERENCE_INVALID', 'entities', '', `entity ${entity.entityId} references unknown location ${entity.locationId}`)
  }
  const scene = content.scenes[0]!
  if (scene.participantIds.some(value => !characters.has(value))) failWorldPackContract('PACK_REFERENCE_INVALID', 'scenes', '', 'Scene references an unknown Character')
  const player = content.playerSlots[0]!
  if (!characters.has(player.characterId)) failWorldPackContract('PACK_REFERENCE_INVALID', 'player-slots', '', 'PlayerSlot references an unknown Character')
  if (!scene.participantIds.includes(player.characterId)) failWorldPackContract('PACK_REFERENCE_INVALID', 'scenes', '', 'active Scene must include the PlayerSlot Character')
  for (const fact of content.world.initialFacts) {
    if (fact.initialAudience.some(value => !characters.has(value))) failWorldPackContract('PACK_REFERENCE_INVALID', 'world', '', `fact ${fact.factId} references an unknown audience Character`)
  }
}

function pluginLocks(profiles = PHASE7_CORE_PROFILES): readonly WorldPackPluginLock[] {
  const identities = [
    { kind: 'agent-context' as const, id: profiles.agentContext.pluginId, version: profiles.agentContext.version },
    { kind: 'presentation' as const, id: profiles.presentation.profileId, version: profiles.presentation.version },
    { kind: 'rulebook' as const, id: profiles.rulebook.rulebookId, version: String(profiles.rulebook.version) },
    { kind: 'scene-decision' as const, id: profiles.sceneDecision.pluginId, version: profiles.sceneDecision.version },
  ]
  return identities.map(identity => ({
    ...identity,
    pluginHash: hashWorldJson('world-pack-core-plugin-lock/v1', identity),
  }))
}

/** Deterministic, filesystem-bound compiler for the Phase 7 World Pack source profile. */
export class WorldPackCompiler {
  async compile(
    sourceDirectory: string,
    options: WorldPackCompileOptions = { limitsProfile: WORLD_PACK_LIMITS_PROFILE },
  ): Promise<CompiledWorldPack> {
    if (options.limitsProfile !== WORLD_PACK_LIMITS_PROFILE) {
      failWorldPackContract('PACK_PROFILE_NOT_ALLOWED', 'compile-options', '/limitsProfile', `must be ${WORLD_PACK_LIMITS_PROFILE}`)
    }
    let root: string
    try {
      root = await realpath(resolve(sourceDirectory))
      if (!(await stat(root)).isDirectory()) failWorldPackContract('PACK_SOURCE_INVALID', sourceDirectory, '', 'must be a directory')
    } catch (error) {
      if (error instanceof Error && error.name === 'WorldPackContractError') throw error
      failWorldPackContract('PACK_SOURCE_INVALID', sourceDirectory, '', `cannot open source directory: ${String(error)}`)
    }
    const manifestFile = 'worldpack.source.json'
    const budget: SourceBudget = { bytes: 0 }
    const manifest = parseWorldPackSourceManifest(await loadJson(root, manifestFile, manifestFile, budget), manifestFile)
    validatePortablePaths(manifest, manifestFile)

    const world = parseWorldPackWorldSource(await loadJson(root, manifest.worldFile, manifestFile, budget), manifest.worldFile)
    const locations: WorldPackLocationSource[] = []
    for (const file of [...manifest.locationFiles].sort(compareText)) locations.push(...parseWorldPackLocationsSource(await loadJson(root, file, manifestFile, budget), file).locations)
    const entities: WorldPackEntitySource[] = []
    for (const file of [...manifest.entityFiles].sort(compareText)) entities.push(...parseWorldPackEntitiesSource(await loadJson(root, file, manifestFile, budget), file).entities)
    const characters: WorldPackCharacterSource[] = []
    for (const file of [...manifest.characterFiles].sort(compareText)) characters.push(...parseWorldPackCharactersSource(await loadJson(root, file, manifestFile, budget), file).characters)
    const scenes: WorldPackSceneSource[] = []
    for (const file of [...manifest.sceneFiles].sort(compareText)) scenes.push(...parseWorldPackScenesSource(await loadJson(root, file, manifestFile, budget), file).scenes)
    const playerSlots: WorldPackPlayerSlotSource[] = []
    for (const file of [...manifest.playerSlotFiles].sort(compareText)) playerSlots.push(...parseWorldPackPlayerSlotsSource(await loadJson(root, file, manifestFile, budget), file).playerSlots)
    if (manifest.presentationFiles.length !== 1) failWorldPackContract('PACK_SOURCE_INVALID', manifestFile, '/presentationFiles', 'Phase 7 requires exactly one presentation file')
    const presentation = parseWorldPackPresentationSource(await loadJson(root, manifest.presentationFiles[0]!, manifestFile, budget), manifest.presentationFiles[0]!)

    const markdown: WorldPackMarkdownContent[] = []
    for (const file of [...manifest.markdownFiles].sort(compareText)) {
      const bytes = await loadBytes(root, file, manifestFile, budget, MAX_MARKDOWN_BYTES)
      const decoded = decodeUtf8(bytes, file)
      const text = decoded.replaceAll('\r\n', '\n')
      if (text.includes('\r')) failWorldPackContract('PACK_SOURCE_INVALID', file, '', 'contains a bare carriage return')
      markdown.push({ path: file, text, contentHash: rawHash(new TextEncoder().encode(text)) })
    }
    const assets: WorldPackAssetLock[] = []
    for (const file of [...manifest.assetFiles].sort(compareText)) {
      const bytes = await loadBytes(root, file, manifestFile, budget, MAX_ASSET_BYTES)
      assets.push({ path: file, contentHash: rawHash(bytes), size: bytes.byteLength })
    }
    const acceptanceAssertions: WorldPackAcceptanceAssertion[] = []
    for (const file of [...manifest.assertionFiles].sort(compareText)) acceptanceAssertions.push(...parseWorldPackAssertionsSource(await loadJson(root, file, manifestFile, budget), file).assertions)

    locations.sort((left, right) => compareText(left.locationId, right.locationId))
    entities.sort((left, right) => compareText(left.entityId, right.entityId))
    characters.sort((left, right) => compareText(left.characterId, right.characterId))
    acceptanceAssertions.sort((left, right) => compareText(left.assertionId, right.assertionId))
    uniqueAcross(locations.map(value => value.locationId), 'locations', '')
    uniqueAcross(entities.map(value => value.entityId), 'entities', '')
    uniqueAcross(characters.map(value => value.characterId), 'characters', '')
    uniqueAcross(scenes.map(value => value.sceneId), 'scenes', '')
    uniqueAcross(playerSlots.map(value => value.slotId), 'player-slots', '')
    uniqueAcross(characters.flatMap(value => value.initialObservations.map(item => item.observationId)), 'characters', '/initialObservations')
    uniqueAcross(characters.flatMap(value => value.initialClaims.map(item => item.claimId)), 'characters', '/initialClaims')
    uniqueAcross(characters.flatMap(value => value.initialGoals.map(item => item.goalId)), 'characters', '/initialGoals')
    uniqueAcross(acceptanceAssertions.map(value => value.assertionId), 'assertions', '')
    if (scenes.length !== 1 || playerSlots.length !== 1) failWorldPackContract('PACK_SOURCE_INVALID', manifestFile, '', 'Phase 7 requires exactly one Scene and PlayerSlot across all files')

    const content: WorldPackCompiledContent = {
      world,
      locations,
      entities,
      characters,
      scenes,
      playerSlots,
      presentation,
      markdown,
    }
    validateReferences(content)
    const unsigned: UnsignedCompiledWorldPack = {
      compiledSchemaVersion: WORLD_PACK_COMPILED_SCHEMA_VERSION,
      packId: manifest.packId,
      packVersion: manifest.packVersion,
      compiler: {
        id: WORLD_PACK_COMPILER_ID,
        version: WORLD_PACK_COMPILER_VERSION,
        contractVersion: WORLD_PACK_COMPILER_CONTRACT_VERSION,
        canonicalJsonVersion: 'world-json/v1',
        limitsProfile: WORLD_PACK_LIMITS_PROFILE,
      },
      pluginLocks: pluginLocks(), content, assets, acceptanceAssertions,
    }
    return parseCompiledWorldPack({ ...unsigned, packHash: packHash(unsigned) })
  }

  adaptToWorldSpec(packInput: unknown, options: WorldPackRuntimeOptions): CompiledWorldSpec {
    const pack = verifyCompiledWorldPack(packInput)
    const player = pack.content.playerSlots[0]!
    const observations = pack.content.characters.flatMap(character => character.initialObservations.map(item => ({
      observationId: item.observationId,
      observerId: character.characterId,
      value: {
        content: item.value,
        sourceRefs: [cognitiveSourceRef(pack, 'character-observation', item.observationId, character.characterId)],
      },
    })))
    const claims = [
      ...pack.content.characters.flatMap(character => character.initialClaims.map(item => ({
        claimId: item.claimId,
        characterId: character.characterId,
        value: {
          proposition: item.value,
          sourceRefs: [cognitiveSourceRef(pack, 'character-claim', item.claimId, character.characterId)],
        },
      }))),
      ...pack.content.world.initialFacts.flatMap(fact => fact.initialAudience.map(characterId => ({
        claimId: deterministicId('world-pack-initial-fact-claim/v1', {
          packHash: pack.packHash, factId: fact.factId, characterId,
        }),
        characterId,
        value: {
          proposition: fact.proposition,
          sourceRefs: [cognitiveSourceRef(pack, 'initial-fact', fact.factId, characterId)],
        },
      }))),
    ]
    const goals = pack.content.characters.flatMap(character => character.initialGoals.map(item => ({
      goalId: item.goalId,
      characterId: character.characterId,
      value: {
        goal: item.value,
        status: 'active',
        priorityPermille: item.priorityPermille,
        visibility: item.visibility,
        sourceRefs: [cognitiveSourceRef(pack, 'character-goal', item.goalId, character.characterId)],
      },
    })))
    const base = new WorldSpecCompiler().compile({
      schemaVersion: 2,
      address: options.address,
      metadata: { title: pack.content.world.title, description: pack.content.world.description },
      timeMode: 'TURN_DRIVEN', roundQueueLimit: pack.content.world.roundQueueLimit,
      runtimePolicy: { npcInitialAvailability: 'ready', playerInitialAvailability: 'ready' },
      rulebook: pack.content.world.coreProfiles.rulebook,
      locations: pack.content.locations,
      entities: pack.content.entities,
      characters: pack.content.characters.map(value => ({ characterId: value.characterId, name: value.displayName, locationId: value.initialLocationId })),
      scenes: pack.content.scenes,
      goals, claims, observations,
      playerBindings: [{ principalId: options.principalId, characterId: player.characterId, sessionId: options.sessionId }],
      plugins: [
        pack.content.world.coreProfiles.sceneDecision,
        pack.content.world.coreProfiles.agentContext,
        { pluginId: pack.content.world.coreProfiles.presentation.profileId, version: pack.content.world.coreProfiles.presentation.version },
      ],
    })
    const characters: readonly ContentPackCharacterSpec[] = pack.content.characters.map(character => ({
      characterId: character.characterId,
      name: character.displayName,
      locationId: character.initialLocationId,
      pronouns: character.pronouns,
      lifecycle: character.lifecycle,
      portrayal: character.portrayal,
    }))
    const contentPack = contentPackBinding(pack)
    const specHash = hashWorldJson('world-pack-runtime-spec/v1', {
      baseSpecHash: base.manifest.specHash,
      contentPack,
      characters,
    })
    const genesisPlanHash = hashWorldJson('world-pack-genesis-semantic-plan/v1', {
      baseGenesisPlanHash: base.manifest.genesisPlanHash,
      packHash: pack.packHash,
      lifecycles: characters.map(character => ({ characterId: character.characterId, lifecycle: character.lifecycle })),
    })
    const manifest: CompiledWorldManifestV3 = {
      ...base.manifest,
      schemaVersion: 3,
      specHash,
      genesisPlanHash,
      characters,
      contentPack,
    }
    const manifestHash = hashWorldJson('compiled-world-manifest', manifest)
    const lifecycleByCharacter = new Map<string, ContentPackCharacterSpec['lifecycle']>(
      characters.map(character => [character.characterId, character.lifecycle]),
    )
    const genesisEvents: readonly WorldEventDraft[] = base.genesisEvents.flatMap(event => {
      if (event.eventType === 'world.created') {
        return [{ ...event, data: { specHash } }]
      }
      if (event.eventType === 'world.manifest-locked') {
        return [{ ...event, data: { manifestHash, genesisPlanHash } }]
      }
      if (event.eventType !== 'character.created') return [event]
      const characterId = (event.data as WorldJsonObject).characterId as string
      const lifecycle = lifecycleByCharacter.get(characterId)
      if (lifecycle === undefined) {
        failWorldPackContract('PACK_REFERENCE_INVALID', 'worldpack.json', '/content/characters', `Genesis references unknown Character ${characterId}`)
      }
      return lifecycle === 'active'
        ? [event]
        : [event, {
          eventType: 'character.lifecycle-changed',
          eventVersion: 1,
          data: { characterId, lifecycleState: lifecycle, transition: 'world-pack-genesis' },
        }]
    })
    return {
      manifest,
      manifestHash,
      genesisEvents,
      genesisHash: hashWorldJson('world-genesis-plan', genesisEvents),
    }
  }
}

function cognitionDependencies(entry: WorldPackCharacterCognitionSourceV2): ReadonlyMap<string, readonly string[]> {
  const dependencies = new Map<string, readonly string[]>()
  for (const item of entry.observations) dependencies.set(item.key, item.basisKeys)
  for (const item of entry.claims) dependencies.set(item.key, item.basisKeys)
  for (const item of entry.goals) dependencies.set(item.key, [...item.basisKeys, ...(item.parentGoalKey === null ? [] : [item.parentGoalKey])])
  for (const item of entry.relationships) dependencies.set(item.key, item.basisKeys)
  for (const item of entry.affects) dependencies.set(item.key, item.basisKeys)
  for (const item of entry.innerTensions) dependencies.set(item.key, [...item.basisKeys, ...item.poles.flatMap(pole => pole.basisKeys)])
  for (const item of entry.commitments) dependencies.set(item.key, item.basisKeys)
  for (const item of entry.openLoops) dependencies.set(item.key, item.basisKeys)
  return dependencies
}

function validateCognitionGraph(entry: WorldPackCharacterCognitionSourceV2, character: WorldPackCharacterSourceV2): void {
  const cognitionKeys = [
    ...entry.observations, ...entry.claims, ...entry.goals, ...entry.relationships, ...entry.affects,
    ...entry.innerTensions, ...entry.commitments, ...entry.openLoops,
  ].map(value => value.key)
  uniqueAcross(cognitionKeys, 'cognition', '')
  if (character.portrayal !== null) {
    const portrayalKeys = [...character.portrayal.drives, ...character.portrayal.principles].map(value => value.key)
    uniqueAcross(portrayalKeys, 'characters', '')
    uniqueAcross([...cognitionKeys, ...portrayalKeys], 'cognition', '')
  }
  const dependencies = cognitionDependencies(entry)
  const portrayalKeys = new Set(character.portrayal === null
    ? []
    : [...character.portrayal.drives, ...character.portrayal.principles].map(item => item.key))
  const allowed = new Set([...dependencies.keys(), ...portrayalKeys])
  const dependents = new Map<string, string[]>()
  const remaining = new Map<string, number>()
  for (const [key, refs] of dependencies) {
    for (const ref of refs) {
      if (!allowed.has(ref)) {
        failWorldPackContract('PACK_REFERENCE_INVALID', 'cognition', '', `character ${entry.characterId} source ${key} references unknown or forbidden basis ${ref}`)
      }
      if (!dependencies.has(ref)) continue
      const values = dependents.get(ref) ?? []
      values.push(key)
      dependents.set(ref, values)
    }
    remaining.set(key, refs.filter(ref => dependencies.has(ref)).length)
  }
  const ready = [...remaining].filter(([, count]) => count === 0).map(([key]) => key).sort(compareText)
  let processed = 0
  while (ready.length > 0) {
    const key = ready.shift()!
    processed += 1
    for (const dependent of dependents.get(key) ?? []) {
      const count = remaining.get(dependent)! - 1
      remaining.set(dependent, count)
      if (count === 0) {
        ready.push(dependent)
        ready.sort(compareText)
      }
    }
  }
  if (processed !== dependencies.size) {
    failWorldPackContract('PACK_REFERENCE_INVALID', 'cognition', '', `character ${entry.characterId} cognition basis graph contains a cycle`)
  }
}

function validateCognitionCapacity(entry: WorldPackCharacterCognitionSourceV2, memory: WorldPackCharacterMemorySourceV2): void {
  const profile = PHASE8_CONTEXT_PROFILES.find(value => value.profileId === memory.profile)!
  const activeGoals = entry.goals.filter(value => value.status === 'active' || value.status === 'blocked').length
  const activeRelationships = entry.relationships.filter(value => value.status === 'active').length
  const activeAffects = entry.affects.filter(value => value.status === 'active').length
  const activeTensions = entry.innerTensions.filter(value => value.status === 'active').length
  const activeCommitments = entry.commitments.filter(value => value.status === 'active').length
  const openLoops = entry.openLoops.filter(value => value.status === 'open' || value.status === 'answered').length
  const counts = [
    ['claims', entry.claims.length, profile.activeClaims],
    ['goals', activeGoals, profile.activeGoals],
    ['relationships', activeRelationships, profile.relationshipFacets],
    ['affects', activeAffects, profile.activeAffects],
    ['innerTensions', activeTensions, profile.activeInnerTensions],
    ['commitments', activeCommitments, profile.activeCommitments],
    ['openLoops', openLoops, profile.openLoops],
  ] as const
  for (const [kind, count, limit] of counts) {
    if (count > limit) {
      failWorldPackContract('PACK_LIMIT_EXCEEDED', 'cognition', '', `character ${entry.characterId} has ${count} active ${kind}; ${memory.profile} allows ${limit}`)
    }
  }
  const checkpointTotal = counts.reduce((total, [, count]) => total + count, 0)
  if (checkpointTotal > profile.checkpointActiveCognition) {
    failWorldPackContract('PACK_LIMIT_EXCEEDED', 'cognition', '', `character ${entry.characterId} has ${checkpointTotal} active cognition records; ${memory.profile} allows ${profile.checkpointActiveCognition}`)
  }
}

function validateV2References(content: WorldPackCompiledContentV2): void {
  const locations = new Set(content.locations.map(value => value.locationId))
  const entities = new Set(content.entities.map(value => value.entityId))
  const characters = new Map(content.characters.map(value => [value.characterId, value]))
  const characterIds = new Set<string>(characters.keys())
  const markdown = new Set(content.markdown.map(value => value.path))
  const activeMembership = new Set<string>()
  for (const character of content.characters) {
    if (character.initialLocationId !== null && !locations.has(character.initialLocationId)) {
      failWorldPackContract('PACK_REFERENCE_INVALID', 'characters', '', `character ${character.characterId} references unknown location ${character.initialLocationId}`)
    }
    if (character.portrayal?.backgroundTextRef !== null && character.portrayal?.backgroundTextRef !== undefined
      && !markdown.has(character.portrayal.backgroundTextRef)) {
      failWorldPackContract('PACK_REFERENCE_INVALID', 'characters', '', `character ${character.characterId} references unknown Markdown ${character.portrayal.backgroundTextRef}`)
    }
  }
  for (const entity of content.entities) {
    if (!locations.has(entity.locationId)) failWorldPackContract('PACK_REFERENCE_INVALID', 'entities', '', `entity ${entity.entityId} references unknown location ${entity.locationId}`)
  }
  for (const scene of content.scenes) {
    if (scene.locationId !== null && !locations.has(scene.locationId)) failWorldPackContract('PACK_REFERENCE_INVALID', 'scenes', '', `Scene ${scene.sceneId} references unknown location ${scene.locationId}`)
    for (const characterId of scene.participantIds) {
      if (!characters.has(characterId)) failWorldPackContract('PACK_REFERENCE_INVALID', 'scenes', '', `Scene ${scene.sceneId} references unknown Character ${characterId}`)
      if (scene.lifecycle === 'active' && activeMembership.has(characterId)) {
        failWorldPackContract('PACK_REFERENCE_INVALID', 'scenes', '', `Character ${characterId} belongs to multiple active Scenes`)
      }
      if (scene.lifecycle === 'active') activeMembership.add(characterId)
    }
  }
  const player = content.playerSlots[0]!
  const playerCharacter = characters.get(player.characterId)
  if (playerCharacter === undefined) failWorldPackContract('PACK_REFERENCE_INVALID', 'player-slots', '', 'PlayerSlot references an unknown Character')
  if (playerCharacter.controllerClass !== 'manual') failWorldPackContract('PACK_REFERENCE_INVALID', 'player-slots', '', 'PlayerSlot Character must use manual controllerClass')
  for (const fact of content.world.initialFacts) {
    if (fact.initialAudience.some(value => !characters.has(value))) failWorldPackContract('PACK_REFERENCE_INVALID', 'world', '', `fact ${fact.factId} references an unknown audience Character`)
  }
  const memoryByCharacter = new Map(content.memory.map(value => [value.characterId, value]))
  for (const entry of content.memory) {
    if (!characters.has(entry.characterId)) failWorldPackContract('PACK_REFERENCE_INVALID', 'memory', '', `unknown Character ${entry.characterId}`)
  }
  for (const cognition of content.cognition) {
    const character = characters.get(cognition.characterId)
    const memory = memoryByCharacter.get(cognition.characterId)
    if (character === undefined || memory === undefined) failWorldPackContract('PACK_REFERENCE_INVALID', 'cognition', '', `unknown Character ${cognition.characterId}`)
    validateCognitionGraph(cognition, character)
    validateCognitionCapacity(cognition, memory)
    const localKeys = new Set(cognitionDependencies(cognition).keys())
    for (const relationship of cognition.relationships) {
      if (!characters.has(relationship.target)) failWorldPackContract('PACK_REFERENCE_INVALID', 'cognition', '', `relationship ${relationship.key} references unknown Character ${relationship.target}`)
    }
    for (const goal of cognition.goals) {
      for (const target of [...goal.targetKeys, ...goal.blockerKeys]) {
        if (!localKeys.has(target) && !characterIds.has(target) && !locations.has(target) && !entities.has(target)) {
          failWorldPackContract('PACK_REFERENCE_INVALID', 'cognition', '', `goal ${goal.key} references unknown target or blocker ${target}`)
        }
      }
    }
    for (const affect of cognition.affects) {
      if (affect.targetKey !== null && !localKeys.has(affect.targetKey) && !characterIds.has(affect.targetKey)
        && !locations.has(affect.targetKey) && !entities.has(affect.targetKey)) {
        failWorldPackContract('PACK_REFERENCE_INVALID', 'cognition', '', `affect ${affect.key} references unknown target ${affect.targetKey}`)
      }
    }
  }
  for (const document of content.documents) {
    if (!markdown.has(document.contentRef)) failWorldPackContract('PACK_REFERENCE_INVALID', 'documents', '', `document ${document.documentId} references unknown Markdown ${document.contentRef}`)
    if (document.characterIds.some(value => !characters.has(value))) failWorldPackContract('PACK_REFERENCE_INVALID', 'documents', '', `document ${document.documentId} references an unknown Character`)
  }
}

type CognitionSeedKind = 'observation' | 'claim' | 'goal' | 'relationship' | 'affect' | 'tension' | 'commitment' | 'open-loop'

interface CognitionSeed {
  readonly kind: CognitionSeedKind
  readonly eventType: string
  readonly key: string
  readonly value: WorldJsonObject
  readonly basisKeys: readonly string[]
}

const COGNITION_EVENT_TYPES: Readonly<Record<CognitionSeedKind, string>> = Object.freeze({
  observation: 'observation.upsert',
  claim: 'subjective-claim.upsert',
  goal: 'character-goal.upsert',
  relationship: 'relationship-attitude.upsert',
  affect: 'affect-episode.upsert',
  tension: 'inner-tension.upsert',
  commitment: 'commitment.upsert',
  'open-loop': 'open-loop.upsert',
})

type Phase8CompatiblePack = CompiledWorldPackV2 | CompiledWorldPackV3 | CompiledWorldPackV4

function phase8CognitionId(pack: Phase8CompatiblePack, characterId: string, kind: CognitionSeedKind | 'portrayal', key: string): string {
  return deterministicId(`world-pack-${kind}-id/v2`, { packHash: pack.packHash, characterId, key })
}

function phase8Source(pack: Phase8CompatiblePack, characterId: string, kind: CognitionSeedKind | 'portrayal' | 'fact' | 'document', key: string): WorldJsonObject {
  const source = { sourceKind: `worldpack-${kind}/v2`, sourceId: deterministicId('world-pack-genesis-source/v2', {
    packHash: pack.packHash, characterId, kind, key,
  }) }
  return { ...source, sourceHash: hashWorldJson('world-pack-genesis-source/v2', source) }
}

function cognitionSeeds(entry: WorldPackCharacterCognitionSourceV2): readonly CognitionSeed[] {
  const convert = (kind: CognitionSeedKind, values: readonly WorldJsonObject[]): CognitionSeed[] => values.map(value => {
    const { key, basisKeys, ...state } = value
    const dependencies = [
      ...(basisKeys as readonly string[]),
      ...(kind === 'goal' && state.parentGoalKey !== null ? [state.parentGoalKey as string] : []),
      ...(kind === 'tension'
        ? (state.poles as readonly WorldJsonObject[]).flatMap(pole => pole.basisKeys as readonly string[])
        : []),
    ]
    return {
      kind,
      eventType: COGNITION_EVENT_TYPES[kind],
      key: key as string,
      value: state,
      basisKeys: [...new Set(dependencies)].sort(compareText),
    }
  })
  const values = [
    ...convert('observation', entry.observations),
    ...convert('claim', entry.claims),
    ...convert('goal', entry.goals),
    ...convert('relationship', entry.relationships),
    ...convert('affect', entry.affects),
    ...convert('tension', entry.innerTensions),
    ...convert('commitment', entry.commitments),
    ...convert('open-loop', entry.openLoops),
  ]
  const byKey = new Map(values.map(value => [value.key, value]))
  const remaining = new Map(values.map(value => [value.key, value.basisKeys.filter(key => byKey.has(key)).length]))
  const dependents = new Map<string, string[]>()
  for (const value of values) {
    for (const basisKey of value.basisKeys) {
      if (!byKey.has(basisKey)) continue
      const targets = dependents.get(basisKey) ?? []
      targets.push(value.key)
      dependents.set(basisKey, targets)
    }
  }
  const ready = [...remaining].filter(([, count]) => count === 0).map(([key]) => key).sort(compareText)
  const ordered: CognitionSeed[] = []
  while (ready.length > 0) {
    const key = ready.shift()!
    ordered.push(byKey.get(key)!)
    for (const target of dependents.get(key) ?? []) {
      const count = remaining.get(target)! - 1
      remaining.set(target, count)
      if (count === 0) {
        ready.push(target)
        ready.sort(compareText)
      }
    }
  }
  return ordered
}

function contentPackBindingV2(pack: Phase8CompatiblePack): ContentPackManifestBindingV2 {
  return {
    schemaVersion: 2,
    packId: pack.packId,
    packVersion: pack.packVersion,
    packHash: pack.packHash,
    compiler: pack.compiler,
    pluginLocks: pack.pluginLocks,
    vocabularyLocks: pack.vocabularyLocks,
    registryLocks: pack.registryLocks,
    runtimeCapabilities: {
      publicSpeechObservationVersion: 1,
      cognitionProjectionVersion: 1,
      sceneDecisionVersion: 2,
      cognitiveMemoryVersion: 2,
      agentContextVersion: 2,
    },
    presentation: pack.content.presentation,
    initialFacts: pack.content.world.initialFacts,
    memory: pack.content.memory,
    documents: pack.content.documents,
    markdown: pack.content.markdown,
  }
}

function phase8GenesisCognition(pack: Phase8CompatiblePack): readonly WorldEventDraft[] {
  const events: WorldEventDraft[] = []
  for (const entry of pack.content.cognition) {
    const character = pack.content.characters.find(value => value.characterId === entry.characterId)!
    const seeds = cognitionSeeds(entry)
    const sourceByKey = new Map<string, WorldJsonObject>()
    const idByKey = new Map<string, string>()
    for (const seed of seeds) {
      sourceByKey.set(seed.key, phase8Source(pack, entry.characterId, seed.kind, seed.key))
      idByKey.set(seed.key, phase8CognitionId(pack, entry.characterId, seed.kind, seed.key))
    }
    for (const portrayal of character.portrayal === null
      ? []
      : [...character.portrayal.drives, ...character.portrayal.principles]) {
      sourceByKey.set(portrayal.key, phase8Source(pack, entry.characterId, 'portrayal', portrayal.key))
      idByKey.set(portrayal.key, phase8CognitionId(pack, entry.characterId, 'portrayal', portrayal.key))
    }
    for (const seed of seeds) {
      const id = idByKey.get(seed.key)!
      const basisRefs = seed.basisKeys.map(key => sourceByKey.get(key)!)
      const replace = (value: unknown): unknown => typeof value === 'string' && idByKey.has(value) ? idByKey.get(value)! : value
      const state: WorldJsonObject = seed.kind === 'goal'
        ? {
            ...seed.value,
            parentGoalKey: replace(seed.value.parentGoalKey) as WorldJsonValue,
            targetKeys: (seed.value.targetKeys as readonly WorldJsonValue[]).map(replace) as readonly WorldJsonValue[],
            blockerKeys: (seed.value.blockerKeys as readonly WorldJsonValue[]).map(replace) as readonly WorldJsonValue[],
          }
        : seed.kind === 'affect'
          ? {
              ...seed.value,
              cause: typeof seed.value.cause === 'object' && seed.value.cause !== null && !Array.isArray(seed.value.cause)
                && typeof (seed.value.cause as WorldJsonObject).key === 'string'
                ? { ...seed.value.cause as WorldJsonObject, key: replace((seed.value.cause as WorldJsonObject).key) as WorldJsonValue }
                : seed.value.cause!,
              targetKey: replace(seed.value.targetKey) as WorldJsonValue,
            }
          : seed.kind === 'tension'
            ? {
                ...seed.value,
                poles: (seed.value.poles as readonly WorldJsonObject[]).map(pole => {
                  const { basisKeys, ...poleState } = pole
                  return {
                    ...poleState,
                    key: deterministicId('world-pack-tension-pole-id/v2', {
                      packHash: pack.packHash, characterId: entry.characterId, tensionId: id, key: pole.key as string,
                    }),
                    basisRefs: (basisKeys as readonly string[]).map(key => sourceByKey.get(key)!),
                  }
                }),
              }
          : seed.value
      const value = { ...state, basisRefs, source: sourceByKey.get(seed.key)! }
      events.push(seed.kind === 'observation'
        ? { eventType: seed.eventType, eventVersion: 1, data: { id, value: { ...value, observerId: entry.characterId } } }
        : { eventType: seed.eventType, eventVersion: 1, data: { id, characterId: entry.characterId, value } })
    }
  }
  for (const fact of pack.content.world.initialFacts) {
    for (const characterId of fact.initialAudience) {
      const id = deterministicId('world-pack-initial-fact-claim/v2', { packHash: pack.packHash, factId: fact.factId, characterId })
      events.push({
        eventType: 'subjective-claim.upsert', eventVersion: 1,
        data: {
          id, characterId,
          value: {
            proposition: fact.proposition, stance: 'believed', confidencePermille: 1000, saliencePermille: 500,
            awareness: 'conscious', status: 'active', basisRefs: [],
            source: phase8Source(pack, characterId, 'fact', fact.factId),
          },
        },
      })
    }
  }
  const markdown = new Map(pack.content.markdown.map(value => [value.path, value]))
  for (const document of pack.content.documents.filter(value => value.usage === 'memory_seed')) {
    for (const characterId of document.characterIds) {
      const id = deterministicId('world-pack-document-observation/v2', { packHash: pack.packHash, documentId: document.documentId, characterId })
      events.push({
        eventType: 'observation.upsert', eventVersion: 1,
        data: {
          id,
          value: {
            observerId: characterId,
            content: markdown.get(document.contentRef)!.text,
            epistemicKind: 'direct_observation', saliencePermille: 500, basisRefs: [],
            source: phase8Source(pack, characterId, 'document', document.documentId),
          },
        },
      })
    }
  }
  return events
}

async function compilePhase8Source(
  sourceDirectory: string,
  options: WorldPackCompileOptionsV2,
  sourceVersion: 'v2' | 'v3' | 'v4',
): Promise<Phase8CompatiblePack> {
    if (options.limitsProfile !== WORLD_PACK_LIMITS_PROFILE_V2) {
      failWorldPackContract('PACK_PROFILE_NOT_ALLOWED', 'compile-options', '/limitsProfile', `must be ${WORLD_PACK_LIMITS_PROFILE_V2}`)
    }
    let root: string
    try {
      root = await realpath(resolve(sourceDirectory))
      if (!(await stat(root)).isDirectory()) failWorldPackContract('PACK_SOURCE_INVALID', sourceDirectory, '', 'must be a directory')
    } catch (error) {
      if (error instanceof Error && error.name === 'WorldPackContractError') throw error
      failWorldPackContract('PACK_SOURCE_INVALID', sourceDirectory, '', `cannot open source directory: ${String(error)}`)
    }
    const manifestFile = 'worldpack.source.json'
    const budget: SourceBudget = { bytes: 0 }
    const manifestInput = await loadJson(root, manifestFile, manifestFile, budget)
    const manifest = sourceVersion === 'v4'
      ? parseWorldPackSourceManifestV4(manifestInput, manifestFile)
      : sourceVersion === 'v3'
        ? parseWorldPackSourceManifestV3(manifestInput, manifestFile)
        : parseWorldPackSourceManifestV2(manifestInput, manifestFile)
    validatePortablePaths(manifest, manifestFile)
    const reaction: WorldPackReactionSource | undefined = manifest.sourceSchemaVersion === WORLD_PACK_SOURCE_SCHEMA_VERSION_V3
      || manifest.sourceSchemaVersion === WORLD_PACK_SOURCE_SCHEMA_VERSION_V4
      ? parseWorldPackReactionSource(await loadJson(root, manifest.reactionFile, manifestFile, budget), manifest.reactionFile)
      : undefined
    const manifestation: WorldPackManifestationSource | undefined = manifest.sourceSchemaVersion === WORLD_PACK_SOURCE_SCHEMA_VERSION_V4
      ? parseWorldPackManifestationSource(
        await loadJson(root, manifest.manifestationFile, manifestFile, budget), manifest.manifestationFile,
      )
      : undefined
    const world = parseWorldPackWorldSourceV2(await loadJson(root, manifest.worldFile, manifestFile, budget), manifest.worldFile)
    const locations: WorldPackLocationSource[] = []
    for (const file of [...manifest.locationFiles].sort(compareText)) locations.push(...parseWorldPackLocationsSource(await loadJson(root, file, manifestFile, budget), file).locations)
    const entities: WorldPackEntitySource[] = []
    for (const file of [...manifest.entityFiles].sort(compareText)) entities.push(...parseWorldPackEntitiesSource(await loadJson(root, file, manifestFile, budget), file).entities)
    const characters: WorldPackCharacterSourceV2[] = []
    for (const file of [...manifest.characterFiles].sort(compareText)) characters.push(...parseWorldPackCharactersSourceV2(await loadJson(root, file, manifestFile, budget), file).characters)
    const scenes: WorldPackSceneSourceV2[] = []
    for (const file of [...manifest.sceneFiles].sort(compareText)) scenes.push(...parseWorldPackScenesSourceV2(await loadJson(root, file, manifestFile, budget), file).scenes)
    const playerSlots: WorldPackPlayerSlotSource[] = []
    for (const file of [...manifest.playerSlotFiles].sort(compareText)) playerSlots.push(...parseWorldPackPlayerSlotsSource(await loadJson(root, file, manifestFile, budget), file).playerSlots)
    if (manifest.presentationFiles.length !== 1) failWorldPackContract('PACK_SOURCE_INVALID', manifestFile, '/presentationFiles', 'Phase 8 requires exactly one presentation file')
    const presentation = parseWorldPackPresentationSource(await loadJson(root, manifest.presentationFiles[0]!, manifestFile, budget), manifest.presentationFiles[0]!)
    const cognition: WorldPackCharacterCognitionSourceV2[] = []
    for (const file of [...manifest.cognitionFiles].sort(compareText)) cognition.push(...parseWorldPackCognitionSourceV2(await loadJson(root, file, manifestFile, budget), file).characters)
    const memory: WorldPackCharacterMemorySourceV2[] = []
    for (const file of [...manifest.memoryFiles].sort(compareText)) memory.push(...parseWorldPackMemorySourceV2(await loadJson(root, file, manifestFile, budget), file).characters)
    const documents: WorldPackDocumentSourceV2[] = []
    for (const file of [...manifest.documentFiles].sort(compareText)) documents.push(...parseWorldPackDocumentsSourceV2(await loadJson(root, file, manifestFile, budget), file).documents)
    const markdown: WorldPackMarkdownContent[] = []
    for (const file of [...manifest.markdownFiles].sort(compareText)) {
      const bytes = await loadBytes(root, file, manifestFile, budget, MAX_MARKDOWN_BYTES)
      const decoded = decodeUtf8(bytes, file)
      const text = decoded.replaceAll('\r\n', '\n')
      if (text.includes('\r')) failWorldPackContract('PACK_SOURCE_INVALID', file, '', 'contains a bare carriage return')
      markdown.push({ path: file, text, contentHash: rawHash(new TextEncoder().encode(text)) })
    }
    const assets: WorldPackAssetLock[] = []
    for (const file of [...manifest.assetFiles].sort(compareText)) {
      const bytes = await loadBytes(root, file, manifestFile, budget, MAX_ASSET_BYTES)
      assets.push({ path: file, contentHash: rawHash(bytes), size: bytes.byteLength })
    }
    const acceptanceAssertions: WorldPackAcceptanceAssertion[] = []
    for (const file of [...manifest.assertionFiles].sort(compareText)) acceptanceAssertions.push(...parseWorldPackAssertionsSource(await loadJson(root, file, manifestFile, budget), file).assertions)

    locations.sort((left, right) => compareText(left.locationId, right.locationId))
    entities.sort((left, right) => compareText(left.entityId, right.entityId))
    characters.sort((left, right) => compareText(left.characterId, right.characterId))
    scenes.sort((left, right) => compareText(left.sceneId, right.sceneId))
    playerSlots.sort((left, right) => compareText(left.slotId, right.slotId))
    cognition.sort((left, right) => compareText(left.characterId, right.characterId))
    memory.sort((left, right) => compareText(left.characterId, right.characterId))
    documents.sort((left, right) => compareText(left.documentId, right.documentId))
    acceptanceAssertions.sort((left, right) => compareText(left.assertionId, right.assertionId))
    uniqueAcross(locations.map(value => value.locationId), 'locations', '')
    uniqueAcross(entities.map(value => value.entityId), 'entities', '')
    uniqueAcross(characters.map(value => value.characterId), 'characters', '')
    uniqueAcross(scenes.map(value => value.sceneId), 'scenes', '')
    uniqueAcross(playerSlots.map(value => value.slotId), 'player-slots', '')
    uniqueAcross(cognition.map(value => value.characterId), 'cognition', '')
    uniqueAcross(memory.map(value => value.characterId), 'memory', '')
    uniqueAcross(documents.map(value => value.documentId), 'documents', '')
    uniqueAcross(acceptanceAssertions.map(value => value.assertionId), 'assertions', '')
    if (playerSlots.length !== 1) failWorldPackContract('PACK_SOURCE_INVALID', manifestFile, '', 'Phase 8 requires exactly one PlayerSlot across all files')
    const cognitionByCharacter = new Map(cognition.map(value => [value.characterId, value]))
    const memoryByCharacter = new Map(memory.map(value => [value.characterId, value]))
    for (const character of characters) {
      if (!cognitionByCharacter.has(character.characterId)) {
        cognition.push({
          characterId: character.characterId, observations: [], claims: [], goals: [], relationships: [], affects: [],
          innerTensions: [], commitments: [], openLoops: [],
        })
      }
      if (!memoryByCharacter.has(character.characterId)) {
        memory.push({ characterId: character.characterId, profile: 'standard', attentionTopics: [] })
      }
    }
    cognition.sort((left, right) => compareText(left.characterId, right.characterId))
    memory.sort((left, right) => compareText(left.characterId, right.characterId))
    const content: WorldPackCompiledContentV2 = {
      world, locations, entities, characters, scenes, playerSlots, cognition, memory, documents, presentation, markdown,
    }
    validateV2References(content)
    const shared = {
      packId: manifest.packId,
      packVersion: manifest.packVersion,
      pluginLocks: pluginLocks(PHASE8_CORE_PROFILES),
      vocabularyLocks: PHASE8_VOCABULARY_LOCKS,
      registryLocks: PHASE8_REGISTRY_LOCKS,
      content,
      assets,
      acceptanceAssertions,
    }
    if (manifestation !== undefined && reaction !== undefined) {
      const unsigned: UnsignedCompiledWorldPackV4 = {
        ...shared,
        compiledSchemaVersion: WORLD_PACK_COMPILED_SCHEMA_VERSION_V4,
        compiler: {
          id: WORLD_PACK_COMPILER_ID, version: WORLD_PACK_COMPILER_VERSION_V4,
          contractVersion: WORLD_PACK_COMPILER_CONTRACT_VERSION_V4,
          canonicalJsonVersion: 'world-json/v1', limitsProfile: WORLD_PACK_LIMITS_PROFILE_V2,
        },
        reaction,
        manifestation,
      }
      return { ...unsigned, packHash: packHashV4(unsigned) }
    }
    if (reaction !== undefined) {
      const unsigned: UnsignedCompiledWorldPackV3 = {
        ...shared,
        compiledSchemaVersion: WORLD_PACK_COMPILED_SCHEMA_VERSION_V3,
        compiler: {
          id: WORLD_PACK_COMPILER_ID, version: WORLD_PACK_COMPILER_VERSION_V3,
          contractVersion: WORLD_PACK_COMPILER_CONTRACT_VERSION_V3,
          canonicalJsonVersion: 'world-json/v1', limitsProfile: WORLD_PACK_LIMITS_PROFILE_V2,
        },
        reaction,
      }
      return { ...unsigned, packHash: packHashV3(unsigned) }
    }
    const unsigned: UnsignedCompiledWorldPackV2 = {
      ...shared,
      compiledSchemaVersion: WORLD_PACK_COMPILED_SCHEMA_VERSION_V2,
      compiler: {
        id: WORLD_PACK_COMPILER_ID, version: WORLD_PACK_COMPILER_VERSION_V2,
        contractVersion: WORLD_PACK_COMPILER_CONTRACT_VERSION_V2,
        canonicalJsonVersion: 'world-json/v1', limitsProfile: WORLD_PACK_LIMITS_PROFILE_V2,
      },
    }
    return { ...unsigned, packHash: packHashV2(unsigned) }
}

/** Deterministic compiler for explicit Phase 8 sources. It does not activate or upcast v1 Packs. */
export class WorldPackCompilerV2 {
  async compile(
    sourceDirectory: string,
    options: WorldPackCompileOptionsV2 = { limitsProfile: WORLD_PACK_LIMITS_PROFILE_V2 },
  ): Promise<CompiledWorldPackV2> {
    return await compilePhase8Source(sourceDirectory, options, 'v2') as CompiledWorldPackV2
  }

  /** Bind an explicit compiled v2 Pack to a new Manifest V4 world and deterministic Tick 0 Genesis. */
  adaptToWorldSpec(packInput: unknown, options: WorldPackRuntimeOptions): CompiledWorldSpec {
    const pack = verifyCompiledWorldPackV2(packInput)
    const player = pack.content.playerSlots[0]!
    const characters: readonly ContentPackCharacterSpecV2[] = pack.content.characters.map(character => ({
      characterId: character.characterId,
      name: character.displayName,
      locationId: character.initialLocationId,
      controllerClass: character.controllerClass,
      pronouns: character.pronouns,
      lifecycle: character.lifecycle,
      portrayal: character.portrayal,
    }))
    const scenes: readonly SceneSpecV2[] = pack.content.scenes.map(scene => ({ ...scene }))
    const contentPack = contentPackBindingV2(pack)
    const normalizedRuntime = {
      schemaVersion: 4 as const,
      address: options.address,
      metadata: { title: pack.content.world.title, description: pack.content.world.description },
      timeMode: 'TURN_DRIVEN' as const,
      roundQueueLimit: pack.content.world.roundQueueLimit,
      runtimePolicy: { npcInitialAvailability: 'ready' as const, playerInitialAvailability: 'ready' as const },
      rulebook: pack.content.world.coreProfiles.rulebook,
      registries: phase8ManifestRegistries(),
      locations: pack.content.locations,
      entities: pack.content.entities,
      characters,
      scenes,
      goals: [], claims: [], observations: [],
      playerBindings: [{ principalId: options.principalId, characterId: player.characterId, sessionId: options.sessionId }],
      plugins: [
        pack.content.world.coreProfiles.sceneDecision,
        pack.content.world.coreProfiles.agentContext,
        { pluginId: pack.content.world.coreProfiles.presentation.profileId, version: pack.content.world.coreProfiles.presentation.version },
      ],
      contentPack,
    }
    const specHash = hashWorldJson('world-pack-runtime-spec/v2', normalizedRuntime)
    const genesisPlanHash = hashWorldJson('world-pack-genesis-semantic-plan/v2', {
      address: options.address,
      packHash: pack.packHash,
      characters,
      scenes,
      cognition: pack.content.cognition,
      initialFacts: pack.content.world.initialFacts,
      memorySeedDocuments: pack.content.documents.filter(isMemorySeedDocument),
    })
    const manifest: CompiledWorldManifestV4 = {
      ...normalizedRuntime,
      specHash,
      genesisPlanHash,
      canonicalVersion: 'world-json/v1',
      hashVersion: 'sha256/v1',
    }
    const manifestHash = hashWorldJson('compiled-world-manifest', manifest)
    const genesisEvents: readonly WorldEventDraft[] = [
      { eventType: 'world.created', eventVersion: 1, data: { specHash } },
      { eventType: 'world.manifest-locked', eventVersion: 1, data: { manifestHash, genesisPlanHash } },
      ...pack.content.locations.map(value => ({ eventType: 'location.upsert', eventVersion: 1, data: value })),
      ...pack.content.entities.map(value => ({ eventType: 'entity.upsert', eventVersion: 1, data: value })),
      ...characters.flatMap(value => [
        { eventType: 'character.created', eventVersion: 1, data: { ...value, lifecycleState: 'active' } },
        ...(value.lifecycle === 'active' ? [] : [{
          eventType: 'character.lifecycle-changed', eventVersion: 1,
          data: { characterId: value.characterId, lifecycleState: value.lifecycle, transition: 'world-pack-genesis/v2' },
        }]),
      ]),
      ...scenes.map(value => ({
        eventType: 'scene.upsert', eventVersion: 1,
        data: { sceneId: value.sceneId, value: { lifecycle: value.lifecycle, locationId: value.locationId, participantIds: value.participantIds } },
      })),
      ...phase8GenesisCognition(pack),
      { eventType: 'player.binding.upsert', eventVersion: 1, data: normalizedRuntime.playerBindings[0]! },
      { eventType: 'world.lifecycle-changed', eventVersion: 1, data: { lifecycleState: 'active' } },
    ]
    return { manifest, manifestHash, genesisEvents, genesisHash: hashWorldJson('world-genesis-plan', genesisEvents) }
  }
}

/** Explicit Phase 9 compiler. It reuses the frozen Phase 8 content vocabulary and only adds Reaction policy. */
export class WorldPackCompilerV3 {
  async compile(
    sourceDirectory: string,
    options: WorldPackCompileOptionsV2 = { limitsProfile: WORLD_PACK_LIMITS_PROFILE_V2 },
  ): Promise<CompiledWorldPackV3> {
    return await compilePhase8Source(sourceDirectory, options, 'v3') as CompiledWorldPackV3
  }

  /** Bind an explicit compiled v3 Pack to Manifest V5 without inventing runtime Provider bindings. */
  adaptToWorldSpec(packInput: unknown, options: WorldPackRuntimeOptions): CompiledWorldSpec {
    const pack = verifyCompiledWorldPackV3(packInput)
    const player = pack.content.playerSlots[0]!
    const characters: readonly ContentPackCharacterSpecV2[] = pack.content.characters.map(character => ({
      characterId: character.characterId, name: character.displayName, locationId: character.initialLocationId,
      controllerClass: character.controllerClass, pronouns: character.pronouns,
      lifecycle: character.lifecycle, portrayal: character.portrayal,
    }))
    const scenes: readonly SceneSpecV2[] = pack.content.scenes.map(scene => ({ ...scene }))
    const normalizedRuntime = {
      schemaVersion: 5 as const,
      address: options.address,
      metadata: { title: pack.content.world.title, description: pack.content.world.description },
      timeMode: 'TURN_DRIVEN' as const,
      roundQueueLimit: pack.content.world.roundQueueLimit,
      runtimePolicy: { npcInitialAvailability: 'ready' as const, playerInitialAvailability: 'ready' as const },
      rulebook: pack.content.world.coreProfiles.rulebook,
      registries: phase8ManifestRegistries(),
      locations: pack.content.locations,
      entities: pack.content.entities,
      characters,
      scenes,
      goals: [], claims: [], observations: [],
      playerBindings: [{ principalId: options.principalId, characterId: player.characterId, sessionId: options.sessionId }],
      plugins: [
        pack.content.world.coreProfiles.sceneDecision,
        pack.content.world.coreProfiles.agentContext,
        { pluginId: pack.content.world.coreProfiles.presentation.profileId, version: pack.content.world.coreProfiles.presentation.version },
      ],
      contentPack: contentPackBindingV2(pack),
      reactionPolicy: pack.reaction.mode === 'disabled'
        ? { version: 'reaction-policy/v1' as const, mode: 'disabled' as const }
        : { version: 'reaction-policy/v1' as const, mode: 'responsive' as const, profile: pack.reaction.profile },
    }
    const specHash = hashWorldJson('world-pack-runtime-spec/v3', normalizedRuntime)
    const genesisPlanHash = hashWorldJson('world-pack-genesis-semantic-plan/v3', {
      address: options.address, packHash: pack.packHash, characters, scenes,
      cognition: pack.content.cognition, initialFacts: pack.content.world.initialFacts,
      memorySeedDocuments: pack.content.documents.filter(isMemorySeedDocument),
    })
    const manifest: CompiledWorldManifestV5 = {
      ...normalizedRuntime, specHash, genesisPlanHash,
      canonicalVersion: 'world-json/v1', hashVersion: 'sha256/v1',
    }
    const manifestHash = hashWorldJson('compiled-world-manifest', manifest)
    const genesisEvents: readonly WorldEventDraft[] = [
      { eventType: 'world.created', eventVersion: 1, data: { specHash } },
      { eventType: 'world.manifest-locked', eventVersion: 1, data: { manifestHash, genesisPlanHash } },
      ...pack.content.locations.map(value => ({ eventType: 'location.upsert', eventVersion: 1, data: value })),
      ...pack.content.entities.map(value => ({ eventType: 'entity.upsert', eventVersion: 1, data: value })),
      ...characters.flatMap(value => [
        { eventType: 'character.created', eventVersion: 1, data: { ...value, lifecycleState: 'active' } },
        ...(value.lifecycle === 'active' ? [] : [{
          eventType: 'character.lifecycle-changed', eventVersion: 1,
          data: { characterId: value.characterId, lifecycleState: value.lifecycle, transition: 'world-pack-genesis/v2' },
        }]),
      ]),
      ...scenes.map(value => ({
        eventType: 'scene.upsert', eventVersion: 1,
        data: { sceneId: value.sceneId, value: { lifecycle: value.lifecycle, locationId: value.locationId, participantIds: value.participantIds } },
      })),
      ...phase8GenesisCognition(pack),
      { eventType: 'player.binding.upsert', eventVersion: 1, data: normalizedRuntime.playerBindings[0]! },
      { eventType: 'world.lifecycle-changed', eventVersion: 1, data: { lifecycleState: 'active' } },
    ]
    return { manifest, manifestHash, genesisEvents, genesisHash: hashWorldJson('world-genesis-plan', genesisEvents) }
  }
}

/** Explicit manifestation compiler. It extends v3 only through Manifest v6 capability gating. */
export class WorldPackCompilerV4 {
  async compile(
    sourceDirectory: string,
    options: WorldPackCompileOptionsV2 = { limitsProfile: WORLD_PACK_LIMITS_PROFILE_V2 },
  ): Promise<CompiledWorldPackV4> {
    return await compilePhase8Source(sourceDirectory, options, 'v4') as CompiledWorldPackV4
  }

  /** Bind compiled v4 to Manifest V6; Provider bindings remain the Host's responsibility. */
  adaptToWorldSpec(packInput: unknown, options: WorldPackRuntimeOptions): CompiledWorldSpec {
    const pack = verifyCompiledWorldPackV4(packInput)
    const player = pack.content.playerSlots[0]!
    const characters: readonly ContentPackCharacterSpecV2[] = pack.content.characters.map(character => ({
      characterId: character.characterId, name: character.displayName, locationId: character.initialLocationId,
      controllerClass: character.controllerClass, pronouns: character.pronouns,
      lifecycle: character.lifecycle, portrayal: character.portrayal,
    }))
    const scenes: readonly SceneSpecV2[] = pack.content.scenes.map(scene => ({ ...scene }))
    const normalizedRuntime = {
      schemaVersion: 6 as const,
      address: options.address,
      metadata: { title: pack.content.world.title, description: pack.content.world.description },
      timeMode: 'TURN_DRIVEN' as const,
      roundQueueLimit: pack.content.world.roundQueueLimit,
      runtimePolicy: { npcInitialAvailability: 'ready' as const, playerInitialAvailability: 'ready' as const },
      rulebook: pack.content.world.coreProfiles.rulebook,
      registries: manifestationManifestRegistries(),
      locations: pack.content.locations,
      entities: pack.content.entities,
      characters,
      scenes,
      goals: [], claims: [], observations: [],
      playerBindings: [{ principalId: options.principalId, characterId: player.characterId, sessionId: options.sessionId }],
      plugins: [
        pack.content.world.coreProfiles.sceneDecision,
        pack.content.world.coreProfiles.agentContext,
        { pluginId: pack.content.world.coreProfiles.presentation.profileId, version: pack.content.world.coreProfiles.presentation.version },
      ],
      contentPack: contentPackBindingV2(pack),
      reactionPolicy: pack.reaction.mode === 'disabled'
        ? { version: 'reaction-policy/v1' as const, mode: 'disabled' as const }
        : { version: 'reaction-policy/v1' as const, mode: 'responsive' as const, profile: pack.reaction.profile },
      manifestationPolicy: {
        version: 'manifestation-policy/v1' as const,
        mode: pack.manifestation.mode,
      },
    }
    const specHash = hashWorldJson('world-pack-runtime-spec/v4', normalizedRuntime)
    const genesisPlanHash = hashWorldJson('world-pack-genesis-semantic-plan/v4', {
      address: options.address, packHash: pack.packHash, characters, scenes,
      cognition: pack.content.cognition, initialFacts: pack.content.world.initialFacts,
      memorySeedDocuments: pack.content.documents.filter(isMemorySeedDocument),
    })
    const manifest: CompiledWorldManifestV6 = {
      ...normalizedRuntime, specHash, genesisPlanHash,
      canonicalVersion: 'world-json/v1', hashVersion: 'sha256/v1',
    }
    const manifestHash = hashWorldJson('compiled-world-manifest', manifest)
    const genesisEvents: readonly WorldEventDraft[] = [
      { eventType: 'world.created', eventVersion: 1, data: { specHash } },
      { eventType: 'world.manifest-locked', eventVersion: 1, data: { manifestHash, genesisPlanHash } },
      ...pack.content.locations.map(value => ({ eventType: 'location.upsert', eventVersion: 1, data: value })),
      ...pack.content.entities.map(value => ({ eventType: 'entity.upsert', eventVersion: 1, data: value })),
      ...characters.flatMap(value => [
        { eventType: 'character.created', eventVersion: 1, data: { ...value, lifecycleState: 'active' } },
        ...(value.lifecycle === 'active' ? [] : [{
          eventType: 'character.lifecycle-changed', eventVersion: 1,
          data: { characterId: value.characterId, lifecycleState: value.lifecycle, transition: 'world-pack-genesis/v2' },
        }]),
      ]),
      ...scenes.map(value => ({
        eventType: 'scene.upsert', eventVersion: 1,
        data: { sceneId: value.sceneId, value: { lifecycle: value.lifecycle, locationId: value.locationId, participantIds: value.participantIds } },
      })),
      ...phase8GenesisCognition(pack),
      { eventType: 'player.binding.upsert', eventVersion: 1, data: normalizedRuntime.playerBindings[0]! },
      { eventType: 'world.lifecycle-changed', eventVersion: 1, data: { lifecycleState: 'active' } },
    ]
    return { manifest, manifestHash, genesisEvents, genesisHash: hashWorldJson('world-genesis-plan', genesisEvents) }
  }
}

/** Fail closed if any immutable envelope field differs from its content-derived identity. */
export function verifyCompiledWorldPack(input: unknown): CompiledWorldPack {
  const pack = parseCompiledWorldPack(input)
  const { packHash: claimedHash, ...unsigned } = pack
  if (packHash(unsigned) !== claimedHash) failWorldPackContract('PACK_SOURCE_INVALID', 'worldpack.json', '/packHash', 'does not match the compiled envelope content')
  return pack
}

/** Fail closed if any compiled v2 field or Phase 8 registry lock differs from its content-derived identity. */
export function verifyCompiledWorldPackV2(input: unknown): CompiledWorldPackV2 {
  const pack = parseCompiledWorldPackV2(input)
  const { packHash: claimedHash, ...unsigned } = pack
  if (packHashV2(unsigned) !== claimedHash) failWorldPackContract('PACK_SOURCE_INVALID', 'worldpack.json', '/packHash', 'does not match the compiled v2 envelope content')
  validateV2References(pack.content)
  return pack
}

/** Fail closed if any compiled v3 field differs from its content-derived identity. */
export function verifyCompiledWorldPackV3(input: unknown): CompiledWorldPackV3 {
  const pack = parseCompiledWorldPackV3(input)
  const { packHash: claimedHash, ...unsigned } = pack
  if (packHashV3(unsigned) !== claimedHash) failWorldPackContract('PACK_SOURCE_INVALID', 'worldpack.json', '/packHash', 'does not match the compiled v3 envelope content')
  validateV2References(pack.content)
  return pack
}

/** Fail closed if any compiled v4 field differs from its content-derived identity. */
export function verifyCompiledWorldPackV4(input: unknown): CompiledWorldPackV4 {
  const pack = parseCompiledWorldPackV4(input)
  const { packHash: claimedHash, ...unsigned } = pack
  if (packHashV4(unsigned) !== claimedHash) failWorldPackContract('PACK_SOURCE_INVALID', 'worldpack.json', '/packHash', 'does not match the compiled v4 envelope content')
  validateV2References(pack.content)
  return pack
}

/** Canonical bytes suitable for writing as the immutable worldpack.json artifact. */
export function canonicalWorldPackBytes(input: unknown): Uint8Array {
  return canonicalizeWorldJson(verifyCompiledWorldPack(input))
}

/** Canonical bytes for the immutable compiled worldpack/v2 artifact. */
export function canonicalWorldPackBytesV2(input: unknown): Uint8Array {
  return canonicalizeWorldJson(verifyCompiledWorldPackV2(input))
}

/** Canonical bytes for the immutable compiled worldpack/v3 artifact. */
export function canonicalWorldPackBytesV3(input: unknown): Uint8Array {
  return canonicalizeWorldJson(verifyCompiledWorldPackV3(input))
}

/** Canonical bytes for the immutable compiled worldpack/v4 artifact. */
export function canonicalWorldPackBytesV4(input: unknown): Uint8Array {
  return canonicalizeWorldJson(verifyCompiledWorldPackV4(input))
}
