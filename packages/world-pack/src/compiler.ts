import { createHash } from 'node:crypto'
import { lstat, readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  canonicalizeWorldJson,
  deterministicId,
  hashWorldJson,
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
  WORLD_PACK_COMPILED_SCHEMA_VERSION,
  WORLD_PACK_COMPILER_CONTRACT_VERSION,
  WORLD_PACK_COMPILER_ID,
  WORLD_PACK_COMPILER_VERSION,
  WORLD_PACK_LIMITS_PROFILE,
  type CompiledWorldPack,
  type WorldPackAcceptanceAssertion,
  type WorldPackAssetLock,
  type WorldPackCharacterSource,
  type WorldPackCompiledContent,
  type WorldPackCompileOptions,
  type WorldPackLocationSource,
  type WorldPackMarkdownContent,
  type WorldPackPlayerSlotSource,
  type WorldPackPluginLock,
  type WorldPackRuntimeOptions,
  type WorldPackSceneSource,
  type WorldPackSourceManifest,
} from './contracts.ts'
import { failWorldPackContract } from './diagnostics.ts'
import {
  parseCompiledWorldPack,
  parseWorldPackAssertionsSource,
  parseWorldPackCharactersSource,
  parseWorldPackLocationsSource,
  parseWorldPackPlayerSlotsSource,
  parseWorldPackPresentationSource,
  parseWorldPackScenesSource,
  parseWorldPackSourceManifest,
  parseWorldPackWorldSource,
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

function allDeclaredFiles(manifest: WorldPackSourceManifest): readonly string[] {
  return [manifest.worldFile, ...manifest.characterFiles, ...manifest.locationFiles, ...manifest.sceneFiles,
    ...manifest.playerSlotFiles, ...manifest.presentationFiles, ...manifest.markdownFiles, ...manifest.assetFiles,
    ...manifest.assertionFiles]
}

function validatePortablePaths(manifest: WorldPackSourceManifest, file: string): void {
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
  const scene = content.scenes[0]!
  if (scene.participantIds.some(value => !characters.has(value))) failWorldPackContract('PACK_REFERENCE_INVALID', 'scenes', '', 'Scene references an unknown Character')
  const player = content.playerSlots[0]!
  if (!characters.has(player.characterId)) failWorldPackContract('PACK_REFERENCE_INVALID', 'player-slots', '', 'PlayerSlot references an unknown Character')
  if (!scene.participantIds.includes(player.characterId)) failWorldPackContract('PACK_REFERENCE_INVALID', 'scenes', '', 'active Scene must include the PlayerSlot Character')
  for (const fact of content.world.initialFacts) {
    if (fact.initialAudience.some(value => !characters.has(value))) failWorldPackContract('PACK_REFERENCE_INVALID', 'world', '', `fact ${fact.factId} references an unknown audience Character`)
  }
}

function pluginLocks(): readonly WorldPackPluginLock[] {
  const identities = [
    { kind: 'agent-context' as const, id: PHASE7_CORE_PROFILES.agentContext.pluginId, version: PHASE7_CORE_PROFILES.agentContext.version },
    { kind: 'presentation' as const, id: PHASE7_CORE_PROFILES.presentation.profileId, version: PHASE7_CORE_PROFILES.presentation.version },
    { kind: 'rulebook' as const, id: PHASE7_CORE_PROFILES.rulebook.rulebookId, version: String(PHASE7_CORE_PROFILES.rulebook.version) },
    { kind: 'scene-decision' as const, id: PHASE7_CORE_PROFILES.sceneDecision.pluginId, version: PHASE7_CORE_PROFILES.sceneDecision.version },
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
    characters.sort((left, right) => compareText(left.characterId, right.characterId))
    acceptanceAssertions.sort((left, right) => compareText(left.assertionId, right.assertionId))
    uniqueAcross(locations.map(value => value.locationId), 'locations', '')
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
      runtimePolicy: { npcInitialAvailability: 'provisioning', playerInitialAvailability: 'ready' },
      rulebook: pack.content.world.coreProfiles.rulebook,
      locations: pack.content.locations,
      entities: [],
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
      const lifecycle = lifecycleByCharacter.get(characterId)!
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

/** Fail closed if any immutable envelope field differs from its content-derived identity. */
export function verifyCompiledWorldPack(input: unknown): CompiledWorldPack {
  const pack = parseCompiledWorldPack(input)
  const { packHash: claimedHash, ...unsigned } = pack
  if (packHash(unsigned) !== claimedHash) failWorldPackContract('PACK_SOURCE_INVALID', 'worldpack.json', '/packHash', 'does not match the compiled envelope content')
  return pack
}

/** Enforce immutable human-version identity before storing or activating a replacement candidate. */
export function assertCompatiblePackVersion(existingInput: unknown, candidateInput: unknown): void {
  const existing = verifyCompiledWorldPack(existingInput)
  const candidate = verifyCompiledWorldPack(candidateInput)
  if (existing.packId === candidate.packId && existing.packVersion === candidate.packVersion && existing.packHash !== candidate.packHash) {
    failWorldPackContract('PACK_VERSION_DIVERGED', 'worldpack.json', '/packHash', 'same packId and packVersion resolve to different packHash values')
  }
}

/** Canonical bytes suitable for writing as the immutable worldpack.json artifact. */
export function canonicalWorldPackBytes(input: unknown): Uint8Array {
  return canonicalizeWorldJson(verifyCompiledWorldPack(input))
}
