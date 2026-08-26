import { createHash } from 'node:crypto'
import { lstat, readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  canonicalizeWorldJson,
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
  WorldSpecCompiler,
  type CompiledWorldManifestV3,
  type CompiledWorldSpec,
  type ContentPackCharacterSpec,
  type ContentPackManifestBinding,
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
  WORLD_PACK_COMPILER_CONTRACT_VERSION_V2,
  WORLD_PACK_COMPILER_VERSION_V2,
  WORLD_PACK_LIMITS_PROFILE_V2,
  WORLD_PACK_SOURCE_SCHEMA_VERSION_V2,
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
} from './contracts.ts'
import { failWorldPackContract } from './diagnostics.ts'
import {
  parseCompiledWorldPack,
  parseCompiledWorldPackV2,
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

interface SourceBudget { bytes: number }

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function rawHash(bytes: Uint8Array): WorldHash {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

function packHash(unsigned: UnsignedCompiledWorldPack): WorldHash {
  return hashWorldJson('compiled-world-pack/v1', unsigned)
}

function packHashV2(unsigned: UnsignedCompiledWorldPackV2): WorldHash {
  return hashWorldJson('compiled-world-pack/v2', unsigned)
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

function allDeclaredFiles(manifest: WorldPackSourceManifest | WorldPackSourceManifestV2): readonly string[] {
  const phase8Files = manifest.sourceSchemaVersion === WORLD_PACK_SOURCE_SCHEMA_VERSION_V2
    ? [...manifest.cognitionFiles, ...manifest.memoryFiles, ...manifest.documentFiles]
    : []
  return [manifest.worldFile, ...manifest.characterFiles, ...manifest.locationFiles, ...manifest.entityFiles, ...manifest.sceneFiles,
    ...manifest.playerSlotFiles, ...manifest.presentationFiles, ...phase8Files, ...manifest.markdownFiles, ...manifest.assetFiles,
    ...manifest.assertionFiles]
}

function validatePortablePaths(manifest: WorldPackSourceManifest | WorldPackSourceManifestV2, file: string): void {
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
    uniqueAcross(
      [...character.portrayal.drives, ...character.portrayal.principles].map(value => value.key),
      'characters',
      '',
    )
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

/** Deterministic compiler for explicit Phase 8 sources. It does not activate or upcast v1 Packs. */
export class WorldPackCompilerV2 {
  async compile(
    sourceDirectory: string,
    options: WorldPackCompileOptionsV2 = { limitsProfile: WORLD_PACK_LIMITS_PROFILE_V2 },
  ): Promise<CompiledWorldPackV2> {
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
    const manifest = parseWorldPackSourceManifestV2(await loadJson(root, manifestFile, manifestFile, budget), manifestFile)
    validatePortablePaths(manifest, manifestFile)
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
    const unsigned: UnsignedCompiledWorldPackV2 = {
      compiledSchemaVersion: WORLD_PACK_COMPILED_SCHEMA_VERSION_V2,
      packId: manifest.packId,
      packVersion: manifest.packVersion,
      compiler: {
        id: WORLD_PACK_COMPILER_ID,
        version: WORLD_PACK_COMPILER_VERSION_V2,
        contractVersion: WORLD_PACK_COMPILER_CONTRACT_VERSION_V2,
        canonicalJsonVersion: 'world-json/v1',
        limitsProfile: WORLD_PACK_LIMITS_PROFILE_V2,
      },
      pluginLocks: pluginLocks(PHASE8_CORE_PROFILES),
      vocabularyLocks: PHASE8_VOCABULARY_LOCKS,
      registryLocks: PHASE8_REGISTRY_LOCKS,
      content,
      assets,
      acceptanceAssertions,
    }
    return { ...unsigned, packHash: packHashV2(unsigned) }
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

/** Canonical bytes suitable for writing as the immutable worldpack.json artifact. */
export function canonicalWorldPackBytes(input: unknown): Uint8Array {
  return canonicalizeWorldJson(verifyCompiledWorldPack(input))
}

/** Canonical bytes for the immutable compiled worldpack/v2 artifact. */
export function canonicalWorldPackBytesV2(input: unknown): Uint8Array {
  return canonicalizeWorldJson(verifyCompiledWorldPackV2(input))
}
