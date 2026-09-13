import { createHash } from 'node:crypto'
import {
  AFFECT_DURATIONS,
  AFFECT_EXPRESSION_MODES,
  AFFECT_STATUSES,
  AFFECT_TYPES,
  AWARENESS_LEVELS,
  CLAIM_STANCES,
  COMMITMENT_ORIGINS,
  COMMITMENT_STATUSES,
  GOAL_OBJECTIVE_KINDS,
  GOAL_STATUSES,
  OPEN_LOOP_KINDS,
  OPEN_LOOP_STATUSES,
  assertProtocolString,
  brandId,
  canonicalizeWorldJson,
  compareWorldText,
  hashWorldJson,
  PHASE8_REGISTRY_LOCKS,
  PHASE8_VOCABULARY_LOCKS,
  RELATIONSHIP_STATUSES,
  RELATIONSHIP_TYPES,
  TENSION_POLE_TENDENCIES,
  TENSION_STATUSES,
  type BrandedId,
  type InteractionBindingV3,
  type InteractionCatalogV3,
  type InteractionDefinitionImplementation,
  type InteractionDefinitionSpec,
  type InteractionImplementationLock,
  type InteractionPackageDescription,
  type InteractionTargetRef,
  type WorldHash,
  type WorldJsonObject,
  type WorldJsonValue,
} from '@harness-world/contracts'
import {
  PHASE7_CORE_PROFILES,
  PHASE8_CORE_PROFILES,
  WORLD_PACK_CHARACTER_LIFECYCLES_V2,
  WORLD_PACK_CHARACTERS_SCHEMA_VERSION_V2,
  WORLD_PACK_COGNITION_SCHEMA_VERSION_V2,
  WORLD_PACK_COMPILED_SCHEMA_VERSION,
  WORLD_PACK_COMPILED_SCHEMA_VERSION_V2,
  WORLD_PACK_COMPILED_SCHEMA_VERSION_V3,
  WORLD_PACK_COMPILED_SCHEMA_VERSION_V4,
  WORLD_PACK_COMPILER_CONTRACT_VERSION,
  WORLD_PACK_COMPILER_CONTRACT_VERSION_V2,
  WORLD_PACK_COMPILER_CONTRACT_VERSION_V3,
  WORLD_PACK_COMPILER_CONTRACT_VERSION_V4,
  WORLD_PACK_COMPILER_ID,
  WORLD_PACK_COMPILER_VERSION,
  WORLD_PACK_COMPILER_VERSION_V2,
  WORLD_PACK_COMPILER_VERSION_V3,
  WORLD_PACK_COMPILER_VERSION_V4,
  WORLD_PACK_LIMITS_PROFILE,
  WORLD_PACK_LIMITS_PROFILE_V2,
  WORLD_PACK_CONTROLLER_CLASSES_V2,
  WORLD_PACK_DOCUMENT_AUDIENCES_V2,
  WORLD_PACK_DOCUMENT_USAGES_V2,
  WORLD_PACK_DOCUMENTS_SCHEMA_VERSION_V2,
  WORLD_PACK_INITIAL_OBSERVATION_EPISTEMIC_KINDS_V2,
  WORLD_PACK_MEMORY_PROFILES_V2,
  WORLD_PACK_MEMORY_SCHEMA_VERSION_V2,
  WORLD_PACK_SCENE_LIFECYCLES_V2,
  WORLD_PACK_SCENES_SCHEMA_VERSION_V2,
  WORLD_PACK_SOURCE_SCHEMA_VERSION,
  WORLD_PACK_SOURCE_SCHEMA_VERSION_V2,
  WORLD_PACK_SOURCE_SCHEMA_VERSION_V3,
  WORLD_PACK_SOURCE_SCHEMA_VERSION_V4,
  WORLD_PACK_SOURCE_SCHEMA_VERSION_V5,
  WORLD_PACK_ENTITIES_SCHEMA_VERSION_V2,
  WORLD_PACK_CHARACTERS_SCHEMA_VERSION_V3,
  WORLD_PACK_INTERACTIONS_SCHEMA_VERSION,
  WORLD_PACK_COMPILED_SCHEMA_VERSION_V5,
  WORLD_PACK_COMPILER_VERSION_V5,
  WORLD_PACK_COMPILER_CONTRACT_VERSION_V5,
  WORLD_PACK_REACTION_SCHEMA_VERSION,
  WORLD_PACK_MANIFESTATION_SCHEMA_VERSION,
  type CompiledWorldPack,
  type CompiledWorldPackV2,
  type CompiledWorldPackV3,
  type CompiledWorldPackV4,
  type CompiledWorldPackV5,
  type WorldPackAcceptanceAssertion,
  type WorldPackAffectSourceV2,
  type WorldPackAssertionsSource,
  type WorldPackAssetLock,
  type WorldPackCharacterSource,
  type WorldPackCharacterSourceV2,
  type WorldPackCharactersSourceV2,
  type WorldPackCharactersSource,
  type WorldPackCharacterCognitionSourceV2,
  type WorldPackClaimSourceV2,
  type WorldPackCognitionSourceV2,
  type WorldPackCommitmentSourceV2,
  type WorldPackCompiledContent,
  type WorldPackCompiledContentV2,
  type WorldPackCoreProfiles,
  type WorldPackEntitiesSource,
  type WorldPackEntitySource,
  type WorldPackDocumentsSourceV2,
  type WorldPackDocumentSourceV2,
  type WorldPackId,
  type WorldPackInitialClaimSource,
  type WorldPackInitialFactSource,
  type WorldPackInitialGoalSource,
  type WorldPackInitialObservationSource,
  type WorldPackInitialObservationSourceV2,
  type WorldPackGoalSourceV2,
  type WorldPackInnerTensionSourceV2,
  type WorldPackLocationSource,
  type WorldPackLocationsSource,
  type WorldPackMarkdownContent,
  type WorldPackMemorySourceV2,
  type WorldPackPlayerSlotSource,
  type WorldPackPlayerSlotsSource,
  type WorldPackPluginLock,
  type WorldPackPresentationSource,
  type WorldPackOpenLoopSourceV2,
  type WorldPackRelationshipSourceV2,
  type WorldPackSceneSource,
  type WorldPackSceneSourceV2,
  type WorldPackScenesSourceV2,
  type WorldPackScenesSource,
  type WorldPackSlotId,
  type WorldPackSourceManifest,
  type WorldPackSourceManifestV2,
  type WorldPackSourceManifestV3,
  type WorldPackSourceManifestV4,
  type WorldPackSourceManifestV5,
  type WorldPackEntitiesSourceV2,
  type WorldPackEntitySourceV2,
  type WorldPackCharacterSourceV3,
  type WorldPackCharactersSourceV3,
  type WorldPackInteractionBindingSource,
  type WorldPackInteractionsSource,
  type WorldPackReactionSource,
  type WorldPackManifestationSource,
  type WorldPackTensionPoleSourceV2,
  type WorldPackWorldSource,
} from './contracts.ts'
import { failWorldPackContract, type WorldPackDiagnosticCode } from './diagnostics.ts'

const EXACT_SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u
const WORLD_HASH = /^sha256:[0-9a-f]{64}$/u
const KIBIBYTE = 1024
const MEBIBYTE = 1024 * KIBIBYTE
const MAX_EXPLICIT_FILES = 512
const MAX_SOURCE_JSON_BYTES = MEBIBYTE
const MAX_COMPILED_BYTES = 16 * MEBIBYTE
const MAX_MARKDOWN_BYTES = 256 * KIBIBYTE
const MAX_ASSET_BYTES = 8 * MEBIBYTE
const MAX_CHARACTERS = 256
const MAX_LOCATIONS = 512
const MAX_ENTITIES = 512
const MAX_COGNITION_RECORDS_PER_KIND = 512
const MAX_PORTRAYAL_TERMS = 128
const MAX_DOCUMENTS = 512
// Interaction limits profile interaction-limits/v1, frozen in the implementation contract.
const MAX_INTERACTION_BINDINGS = 4096
const MAX_INTERACTION_PACKAGES = 32
const MAX_INTERACTION_DEFINITIONS = 128

function pointer(base: string, field: string | number): string {
  const token = String(field).replaceAll('~', '~0').replaceAll('/', '~1')
  return `${base}/${token}`
}

function checkWorldJson(input: unknown, file: string, maximumBytes: number): void {
  let byteLength: number
  try {
    byteLength = canonicalizeWorldJson(input as WorldJsonValue).byteLength
  } catch (error) {
    failWorldPackContract('PACK_SOURCE_INVALID', file, '', `must be valid World JSON: ${String(error)}`)
  }
  if (byteLength > maximumBytes) {
    failWorldPackContract('PACK_LIMIT_EXCEEDED', file, '', `exceeds the ${maximumBytes}-byte JSON limit`)
  }
}

function objectAt(value: unknown, file: string, at: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    failWorldPackContract('PACK_SOURCE_INVALID', file, at, 'must be an object')
  }
  return value as Record<string, unknown>
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  file: string,
  at: string,
): void {
  const allowed = new Set([...required, ...optional])
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) failWorldPackContract('PACK_UNKNOWN_FIELD', file, pointer(at, key), 'is not allowed')
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) failWorldPackContract('PACK_SOURCE_INVALID', file, pointer(at, key), 'is required')
  }
}

function arrayAt(value: unknown, file: string, at: string): readonly unknown[] {
  if (!Array.isArray(value)) failWorldPackContract('PACK_SOURCE_INVALID', file, at, 'must be an array')
  return value
}

function stringAt(value: unknown, file: string, at: string): string {
  if (typeof value !== 'string') failWorldPackContract('PACK_SOURCE_INVALID', file, at, 'must be a string')
  return value
}

function textAt(value: unknown, file: string, at: string): string {
  const text = stringAt(value, file, at)
  try {
    return assertProtocolString(text, at)
  } catch (error) {
    failWorldPackContract('PACK_SOURCE_INVALID', file, at, String(error))
  }
}

function textOrEmptyAt(value: unknown, file: string, at: string): string {
  if (value === '') return ''
  return textAt(value, file, at)
}

function idAt<Name extends string>(value: unknown, file: string, at: string, name: Name): BrandedId<Name> {
  return brandId(textAt(value, file, at), name)
}

function integerAt(value: unknown, file: string, at: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    failWorldPackContract('PACK_SOURCE_INVALID', file, at, `must be a safe integer from ${minimum} through ${maximum}`)
  }
  return value as number
}

function literalAt<const Value extends string>(
  value: unknown,
  allowed: readonly Value[],
  file: string,
  at: string,
): Value {
  const normalized = textAt(value, file, at)
  if (!allowed.includes(normalized as Value)) {
    failWorldPackContract('PACK_SOURCE_INVALID', file, at, `must be one of: ${allowed.join(', ')}`)
  }
  return normalized as Value
}

function optionalArrayAt(value: unknown, file: string, at: string): readonly unknown[] {
  if (value === undefined) return []
  return arrayAt(value, file, at)
}

function optionalTextArrayAt(value: unknown, file: string, at: string): readonly string[] {
  const result = optionalArrayAt(value, file, at).map((entry, index) => textAt(entry, file, pointer(at, index)))
  unique(result, file, at)
  return result
}

function optionalNullableTextAt(value: unknown, file: string, at: string): string | null {
  if (value === undefined || value === null) return null
  return textAt(value, file, at)
}

function semverAt(value: unknown, file: string, at: string): string {
  const version = textAt(value, file, at)
  if (!EXACT_SEMVER.test(version)) failWorldPackContract('PACK_SOURCE_INVALID', file, at, 'must be an exact SemVer')
  return version
}

function hashAt(value: unknown, file: string, at: string): WorldHash {
  const hash = textAt(value, file, at)
  if (!WORLD_HASH.test(hash)) failWorldPackContract('PACK_SOURCE_INVALID', file, at, 'must be a lowercase sha256 hash')
  return hash as WorldHash
}

function unique(values: readonly string[], file: string, at: string): void {
  if (new Set(values).size !== values.length) {
    failWorldPackContract('PACK_DUPLICATE_ID', file, at, 'contains duplicate values')
  }
}

function nonEmpty(values: readonly unknown[], file: string, at: string): void {
  if (values.length === 0) failWorldPackContract('PACK_SOURCE_INVALID', file, at, 'must not be empty')
}

function sourceDocument(input: unknown, file: string, maximumBytes = MAX_SOURCE_JSON_BYTES): Record<string, unknown> {
  checkWorldJson(input, file, maximumBytes)
  return objectAt(input, file, '')
}

function copyCoreProfiles(): WorldPackCoreProfiles {
  return {
    rulebook: { ...PHASE7_CORE_PROFILES.rulebook },
    sceneDecision: { ...PHASE7_CORE_PROFILES.sceneDecision },
    agentContext: { ...PHASE7_CORE_PROFILES.agentContext },
    presentation: { ...PHASE7_CORE_PROFILES.presentation },
  }
}

function copyPhase8CoreProfiles(): WorldPackCoreProfiles {
  return {
    rulebook: { ...PHASE8_CORE_PROFILES.rulebook },
    sceneDecision: { ...PHASE8_CORE_PROFILES.sceneDecision },
    agentContext: { ...PHASE8_CORE_PROFILES.agentContext },
    presentation: { ...PHASE8_CORE_PROFILES.presentation },
  }
}

function profileShapeAt(value: unknown, file: string, at: string): WorldPackCoreProfiles {
  const profiles = objectAt(value, file, at)
  exactKeys(profiles, ['rulebook', 'sceneDecision', 'agentContext', 'presentation'], [], file, at)
  const rulebook = objectAt(profiles.rulebook, file, pointer(at, 'rulebook'))
  exactKeys(rulebook, ['rulebookId', 'version'], [], file, pointer(at, 'rulebook'))
  const scene = objectAt(profiles.sceneDecision, file, pointer(at, 'sceneDecision'))
  exactKeys(scene, ['pluginId', 'version'], [], file, pointer(at, 'sceneDecision'))
  const context = objectAt(profiles.agentContext, file, pointer(at, 'agentContext'))
  exactKeys(context, ['pluginId', 'version'], [], file, pointer(at, 'agentContext'))
  const presentation = objectAt(profiles.presentation, file, pointer(at, 'presentation'))
  exactKeys(presentation, ['profileId', 'version'], [], file, pointer(at, 'presentation'))
  return {
    rulebook: {
      rulebookId: textAt(rulebook.rulebookId, file, `${at}/rulebook/rulebookId`) as 'builtin:speak-move',
      version: integerAt(rulebook.version, file, `${at}/rulebook/version`, 1, Number.MAX_SAFE_INTEGER) as 2,
    },
    sceneDecision: {
      pluginId: textAt(scene.pluginId, file, `${at}/sceneDecision/pluginId`),
      version: semverAt(scene.version, file, `${at}/sceneDecision/version`),
    },
    agentContext: {
      pluginId: textAt(context.pluginId, file, `${at}/agentContext/pluginId`),
      version: semverAt(context.version, file, `${at}/agentContext/version`),
    },
    presentation: {
      profileId: textAt(presentation.profileId, file, `${at}/presentation/profileId`) as 'builtin:deterministic-presentation',
      version: semverAt(presentation.version, file, `${at}/presentation/version`) as '1.0.0',
    },
  }
}

function profileAt(value: unknown, file: string, at: string): WorldPackCoreProfiles {
  if (value === undefined) return copyCoreProfiles()
  const normalized = profileShapeAt(value, file, at)
  if (JSON.stringify(normalized) !== JSON.stringify(PHASE7_CORE_PROFILES)) {
    failWorldPackContract('PACK_PROFILE_NOT_ALLOWED', file, at, 'must select the exact Phase 7 Core profiles')
  }
  return normalized
}

function phase8ProfileAt(value: unknown, file: string, at: string): WorldPackCoreProfiles {
  if (value === undefined) return copyPhase8CoreProfiles()
  const normalized = profileShapeAt(value, file, at)
  if (JSON.stringify(normalized) !== JSON.stringify(PHASE8_CORE_PROFILES)) {
    failWorldPackContract('PACK_PROFILE_NOT_ALLOWED', file, at, 'must select the exact Phase 8 Core profiles')
  }
  return normalized
}

function parseFact(value: unknown, file: string, at: string): WorldPackInitialFactSource {
  const fact = objectAt(value, file, at)
  exactKeys(fact, ['factId', 'proposition', 'initialAudience'], [], file, at)
  const initialAudience = arrayAt(fact.initialAudience, file, pointer(at, 'initialAudience'))
    .map((entry, index) => idAt(entry, file, pointer(pointer(at, 'initialAudience'), index), 'CharacterId'))
  nonEmpty(initialAudience, file, pointer(at, 'initialAudience'))
  unique(initialAudience, file, pointer(at, 'initialAudience'))
  return {
    factId: textAt(fact.factId, file, pointer(at, 'factId')),
    proposition: fact.proposition as WorldJsonValue,
    initialAudience,
  }
}

/** Parse the explicit file manifest without reading any referenced path. */
export function parseWorldPackSourceManifest(input: unknown, file = 'worldpack.source.json'): WorldPackSourceManifest {
  const root = sourceDocument(input, file)
  const listFields = [
    'characterFiles', 'locationFiles', 'entityFiles', 'sceneFiles', 'playerSlotFiles', 'presentationFiles',
    'markdownFiles', 'assetFiles', 'assertionFiles',
  ] as const
  exactKeys(root, ['sourceSchemaVersion', 'packId', 'packVersion', 'worldFile', ...listFields], [], file, '')
  if (root.sourceSchemaVersion !== WORLD_PACK_SOURCE_SCHEMA_VERSION) {
    failWorldPackContract('PACK_SOURCE_INVALID', file, '/sourceSchemaVersion', `must be ${WORLD_PACK_SOURCE_SCHEMA_VERSION}`)
  }
  const lists = Object.fromEntries(listFields.map(field => [
    field,
    arrayAt(root[field], file, `/${field}`).map((entry, index) => textAt(entry, file, `/${field}/${index}`)),
  ])) as Record<(typeof listFields)[number], string[]>
  for (const field of ['characterFiles', 'locationFiles', 'sceneFiles', 'playerSlotFiles', 'presentationFiles'] as const) {
    nonEmpty(lists[field], file, `/${field}`)
  }
  const worldFile = textAt(root.worldFile, file, '/worldFile')
  const explicitFiles = [worldFile, ...listFields.flatMap(field => lists[field])]
  if (explicitFiles.length > MAX_EXPLICIT_FILES) {
    failWorldPackContract('PACK_LIMIT_EXCEEDED', file, '', `must list at most ${MAX_EXPLICIT_FILES} files`)
  }
  unique(explicitFiles, file, '')
  return {
    sourceSchemaVersion: WORLD_PACK_SOURCE_SCHEMA_VERSION,
    packId: idAt(root.packId, file, '/packId', 'WorldPackId') as WorldPackId,
    packVersion: semverAt(root.packVersion, file, '/packVersion'),
    worldFile,
    characterFiles: lists.characterFiles,
    locationFiles: lists.locationFiles,
    entityFiles: lists.entityFiles,
    sceneFiles: lists.sceneFiles,
    playerSlotFiles: lists.playerSlotFiles,
    presentationFiles: lists.presentationFiles,
    markdownFiles: lists.markdownFiles,
    assetFiles: lists.assetFiles,
    assertionFiles: lists.assertionFiles,
  }
}

/** Parse the explicit Phase 8 file manifest without enabling compilation or implicit v1 upcast. */
export function parseWorldPackSourceManifestV2(input: unknown, file = 'worldpack.source.json'): WorldPackSourceManifestV2 {
  const root = sourceDocument(input, file)
  const listFields = [
    'characterFiles', 'locationFiles', 'entityFiles', 'sceneFiles', 'playerSlotFiles', 'presentationFiles',
    'cognitionFiles', 'memoryFiles', 'documentFiles', 'markdownFiles', 'assetFiles', 'assertionFiles',
  ] as const
  exactKeys(root, ['sourceSchemaVersion', 'packId', 'packVersion', 'worldFile', ...listFields], [], file, '')
  if (root.sourceSchemaVersion !== WORLD_PACK_SOURCE_SCHEMA_VERSION_V2) {
    failWorldPackContract('PACK_SOURCE_INVALID', file, '/sourceSchemaVersion', `must be ${WORLD_PACK_SOURCE_SCHEMA_VERSION_V2}`)
  }
  const lists = Object.fromEntries(listFields.map(field => [
    field,
    arrayAt(root[field], file, `/${field}`).map((entry, index) => textAt(entry, file, `/${field}/${index}`)),
  ])) as Record<(typeof listFields)[number], string[]>
  for (const field of ['characterFiles', 'locationFiles', 'sceneFiles', 'playerSlotFiles', 'presentationFiles'] as const) {
    nonEmpty(lists[field], file, `/${field}`)
  }
  const worldFile = textAt(root.worldFile, file, '/worldFile')
  const explicitFiles = [worldFile, ...listFields.flatMap(field => lists[field])]
  if (explicitFiles.length > MAX_EXPLICIT_FILES) {
    failWorldPackContract('PACK_LIMIT_EXCEEDED', file, '', `must list at most ${MAX_EXPLICIT_FILES} files`)
  }
  unique(explicitFiles, file, '')
  return {
    sourceSchemaVersion: WORLD_PACK_SOURCE_SCHEMA_VERSION_V2,
    packId: idAt(root.packId, file, '/packId', 'WorldPackId') as WorldPackId,
    packVersion: semverAt(root.packVersion, file, '/packVersion'),
    worldFile,
    characterFiles: lists.characterFiles,
    locationFiles: lists.locationFiles,
    entityFiles: lists.entityFiles,
    sceneFiles: lists.sceneFiles,
    playerSlotFiles: lists.playerSlotFiles,
    presentationFiles: lists.presentationFiles,
    cognitionFiles: lists.cognitionFiles,
    memoryFiles: lists.memoryFiles,
    documentFiles: lists.documentFiles,
    markdownFiles: lists.markdownFiles,
    assetFiles: lists.assetFiles,
    assertionFiles: lists.assertionFiles,
  }
}

/** Parse the explicit Phase 9 file manifest without modifying the frozen v2 parser. */
export function parseWorldPackSourceManifestV3(input: unknown, file = 'worldpack.source.json'): WorldPackSourceManifestV3 {
  const root = sourceDocument(input, file)
  const v2Fields = [
    'characterFiles', 'locationFiles', 'entityFiles', 'sceneFiles', 'playerSlotFiles', 'presentationFiles',
    'cognitionFiles', 'memoryFiles', 'documentFiles', 'markdownFiles', 'assetFiles', 'assertionFiles',
  ] as const
  exactKeys(root, ['sourceSchemaVersion', 'packId', 'packVersion', 'worldFile', ...v2Fields, 'reactionFile'], [], file, '')
  if (root.sourceSchemaVersion !== WORLD_PACK_SOURCE_SCHEMA_VERSION_V3) {
    failWorldPackContract('PACK_SOURCE_INVALID', file, '/sourceSchemaVersion', `must be ${WORLD_PACK_SOURCE_SCHEMA_VERSION_V3}`)
  }
  const reactionFile = textAt(root.reactionFile, file, '/reactionFile')
  const { reactionFile: _, ...base } = root
  const parsed = parseWorldPackSourceManifestV2({
    ...base,
    sourceSchemaVersion: WORLD_PACK_SOURCE_SCHEMA_VERSION_V2,
  }, file)
  const explicitFiles = [parsed.worldFile, ...v2Fields.flatMap(field => parsed[field]), reactionFile]
  if (explicitFiles.length > MAX_EXPLICIT_FILES) {
    failWorldPackContract('PACK_LIMIT_EXCEEDED', file, '', `must list at most ${MAX_EXPLICIT_FILES} files`)
  }
  unique(explicitFiles, file, '')
  return { ...parsed, sourceSchemaVersion: WORLD_PACK_SOURCE_SCHEMA_VERSION_V3, reactionFile }
}

/** Parse the explicit manifestation source manifest without changing frozen v1-v3 shapes. */
export function parseWorldPackSourceManifestV4(input: unknown, file = 'worldpack.source.json'): WorldPackSourceManifestV4 {
  const root = sourceDocument(input, file)
  const v2Fields = [
    'characterFiles', 'locationFiles', 'entityFiles', 'sceneFiles', 'playerSlotFiles', 'presentationFiles',
    'cognitionFiles', 'memoryFiles', 'documentFiles', 'markdownFiles', 'assetFiles', 'assertionFiles',
  ] as const
  exactKeys(root, [
    'sourceSchemaVersion', 'packId', 'packVersion', 'worldFile', ...v2Fields, 'reactionFile', 'manifestationFile',
  ], [], file, '')
  if (root.sourceSchemaVersion !== WORLD_PACK_SOURCE_SCHEMA_VERSION_V4) {
    failWorldPackContract('PACK_SOURCE_INVALID', file, '/sourceSchemaVersion', `must be ${WORLD_PACK_SOURCE_SCHEMA_VERSION_V4}`)
  }
  const manifestationFile = textAt(root.manifestationFile, file, '/manifestationFile')
  const { manifestationFile: _, ...base } = root
  const parsed = parseWorldPackSourceManifestV3({
    ...base,
    sourceSchemaVersion: WORLD_PACK_SOURCE_SCHEMA_VERSION_V3,
  }, file)
  const explicitFiles = [parsed.worldFile, ...v2Fields.flatMap(field => parsed[field]), parsed.reactionFile, manifestationFile]
  if (explicitFiles.length > MAX_EXPLICIT_FILES) {
    failWorldPackContract('PACK_LIMIT_EXCEEDED', file, '', `must list at most ${MAX_EXPLICIT_FILES} files`)
  }
  unique(explicitFiles, file, '')
  return { ...parsed, sourceSchemaVersion: WORLD_PACK_SOURCE_SCHEMA_VERSION_V4, manifestationFile }
}

/** V5 adds the world's interaction selection file. V1-V4 parsing and Hash are untouched. */
export function parseWorldPackSourceManifestV5(input: unknown, file = 'worldpack.source.json'): WorldPackSourceManifestV5 {
  const root = sourceDocument(input, file)
  if (root.sourceSchemaVersion !== WORLD_PACK_SOURCE_SCHEMA_VERSION_V5) {
    failWorldPackContract('PACK_SOURCE_INVALID', file, '/sourceSchemaVersion', `must be ${WORLD_PACK_SOURCE_SCHEMA_VERSION_V5}`)
  }
  const interactionFile = textAt(root.interactionFile, file, '/interactionFile')
  const { interactionFile: _interactionFile, ...base } = root
  const parsed = parseWorldPackSourceManifestV4({
    ...base,
    sourceSchemaVersion: WORLD_PACK_SOURCE_SCHEMA_VERSION_V4,
  }, file)
  const files = [
    parsed.worldFile, ...parsed.characterFiles, ...parsed.locationFiles, ...parsed.entityFiles, ...parsed.sceneFiles,
    ...parsed.playerSlotFiles, ...parsed.presentationFiles, ...parsed.cognitionFiles, ...parsed.memoryFiles,
    ...parsed.documentFiles, ...parsed.markdownFiles, ...parsed.assetFiles, ...parsed.assertionFiles,
    parsed.reactionFile, parsed.manifestationFile, interactionFile,
  ]
  if (files.length > MAX_EXPLICIT_FILES) {
    failWorldPackContract('PACK_LIMIT_EXCEEDED', file, '', `must list at most ${MAX_EXPLICIT_FILES} files`)
  }
  unique(files, file, '')
  return { ...parsed, sourceSchemaVersion: WORLD_PACK_SOURCE_SCHEMA_VERSION_V5, interactionFile }
}

/** Strict creator-selectable Reaction mode. Numeric safety limits are deliberately absent. */
export function parseWorldPackReactionSource(input: unknown, file = 'reaction.json'): WorldPackReactionSource {
  const root = sourceDocument(input, file)
  if (root.mode === 'disabled') {
    exactKeys(root, ['schemaVersion', 'mode'], [], file, '')
    if (root.schemaVersion !== WORLD_PACK_REACTION_SCHEMA_VERSION) {
      failWorldPackContract('PACK_SOURCE_INVALID', file, '/schemaVersion', `must be ${WORLD_PACK_REACTION_SCHEMA_VERSION}`)
    }
    return { schemaVersion: WORLD_PACK_REACTION_SCHEMA_VERSION, mode: 'disabled' }
  }
  exactKeys(root, ['schemaVersion', 'mode', 'profile'], [], file, '')
  if (root.schemaVersion !== WORLD_PACK_REACTION_SCHEMA_VERSION) {
    failWorldPackContract('PACK_SOURCE_INVALID', file, '/schemaVersion', `must be ${WORLD_PACK_REACTION_SCHEMA_VERSION}`)
  }
  if (root.mode !== 'responsive') failWorldPackContract('PACK_SOURCE_INVALID', file, '/mode', 'must be disabled or responsive')
  if (root.profile !== 'responsive/v1') failWorldPackContract('PACK_SOURCE_INVALID', file, '/profile', 'must be responsive/v1')
  return { schemaVersion: WORLD_PACK_REACTION_SCHEMA_VERSION, mode: 'responsive', profile: 'responsive/v1' }
}

/** Strict creator-selectable observable manifestation capability. */
export function parseWorldPackManifestationSource(
  input: unknown,
  file = 'manifestation.json',
): WorldPackManifestationSource {
  const root = sourceDocument(input, file)
  exactKeys(root, ['schemaVersion', 'mode'], [], file, '')
  if (root.schemaVersion !== WORLD_PACK_MANIFESTATION_SCHEMA_VERSION) {
    failWorldPackContract('PACK_SOURCE_INVALID', file, '/schemaVersion', `must be ${WORLD_PACK_MANIFESTATION_SCHEMA_VERSION}`)
  }
  if (root.mode !== 'disabled' && root.mode !== 'enabled') {
    failWorldPackContract('PACK_SOURCE_INVALID', file, '/mode', 'must be disabled or enabled')
  }
  return { schemaVersion: WORLD_PACK_MANIFESTATION_SCHEMA_VERSION, mode: root.mode }
}

function cognitionArray(value: unknown, file: string, at: string): readonly unknown[] {
  const entries = optionalArrayAt(value, file, at)
  if (entries.length > MAX_COGNITION_RECORDS_PER_KIND) {
    failWorldPackContract('PACK_LIMIT_EXCEEDED', file, at, `must contain at most ${MAX_COGNITION_RECORDS_PER_KIND} records`)
  }
  return entries
}

function basisKeysAt(record: Record<string, unknown>, file: string, at: string): readonly string[] {
  return optionalTextArrayAt(record.basisKeys, file, pointer(at, 'basisKeys'))
}

function parsePortrayalTerms(value: unknown, file: string, at: string): readonly { key: string, text: string }[] {
  const entries = optionalArrayAt(value, file, at)
  if (entries.length > MAX_PORTRAYAL_TERMS) {
    failWorldPackContract('PACK_LIMIT_EXCEEDED', file, at, `must contain at most ${MAX_PORTRAYAL_TERMS} terms`)
  }
  const terms = entries.map((entry, index) => {
    const entryAt = pointer(at, index)
    const term = objectAt(entry, file, entryAt)
    exactKeys(term, ['key', 'text'], [], file, entryAt)
    return { key: textAt(term.key, file, pointer(entryAt, 'key')), text: textAt(term.text, file, pointer(entryAt, 'text')) }
  })
  unique(terms.map(term => term.key), file, at)
  return terms
}

function parsePortrayalV2(value: unknown, file: string, at: string): WorldPackCharacterSourceV2['portrayal'] {
  if (value === undefined || value === null) return null
  const portrayal = objectAt(value, file, at)
  exactKeys(portrayal, [], ['summary', 'speakingStyle', 'backgroundTextRef', 'drives', 'principles'], file, at)
  return {
    summary: textOrEmptyAt(portrayal.summary ?? '', file, pointer(at, 'summary')),
    speakingStyle: textOrEmptyAt(portrayal.speakingStyle ?? '', file, pointer(at, 'speakingStyle')),
    backgroundTextRef: optionalNullableTextAt(portrayal.backgroundTextRef, file, pointer(at, 'backgroundTextRef')),
    drives: parsePortrayalTerms(portrayal.drives, file, pointer(at, 'drives')),
    principles: parsePortrayalTerms(portrayal.principles, file, pointer(at, 'principles')),
  }
}

function parseCharacterV2(value: unknown, file: string, at: string): WorldPackCharacterSourceV2 {
  const character = objectAt(value, file, at)
  exactKeys(
    character,
    ['characterId', 'displayName', 'controllerClass'],
    ['pronouns', 'initialLocationId', 'lifecycle', 'portrayal'],
    file,
    at,
  )
  return {
    characterId: idAt(character.characterId, file, pointer(at, 'characterId'), 'CharacterId'),
    displayName: textAt(character.displayName, file, pointer(at, 'displayName')),
    controllerClass: literalAt(character.controllerClass, WORLD_PACK_CONTROLLER_CLASSES_V2, file, pointer(at, 'controllerClass')),
    pronouns: textOrEmptyAt(character.pronouns ?? '', file, pointer(at, 'pronouns')),
    initialLocationId: optionalNullableTextAt(character.initialLocationId, file, pointer(at, 'initialLocationId')),
    lifecycle: literalAt(character.lifecycle ?? 'active', WORLD_PACK_CHARACTER_LIFECYCLES_V2, file, pointer(at, 'lifecycle')),
    portrayal: parsePortrayalV2(character.portrayal, file, pointer(at, 'portrayal')),
  }
}

/** Parse and materialize safe defaults for Phase 8 character definitions. */
export function parseWorldPackCharactersSourceV2(input: unknown, file = 'characters.json'): WorldPackCharactersSourceV2 {
  const document = sourceDocument(input, file)
  exactKeys(document, ['schemaVersion', 'characters'], [], file, '')
  if (document.schemaVersion !== WORLD_PACK_CHARACTERS_SCHEMA_VERSION_V2) {
    failWorldPackContract('PACK_SOURCE_INVALID', file, '/schemaVersion', `must equal ${WORLD_PACK_CHARACTERS_SCHEMA_VERSION_V2}`)
  }
  const rawCharacters = arrayAt(document.characters, file, '/characters')
  if (rawCharacters.length > MAX_CHARACTERS) {
    failWorldPackContract('PACK_LIMIT_EXCEEDED', file, '/characters', `must contain at most ${MAX_CHARACTERS} characters`)
  }
  const characters = rawCharacters.map((entry, index) => parseCharacterV2(entry, file, `/characters/${index}`))
  unique(characters.map(entry => entry.characterId), file, '/characters')
  return { schemaVersion: WORLD_PACK_CHARACTERS_SCHEMA_VERSION_V2, characters }
}

function parseCognitionObservation(value: unknown, file: string, at: string): WorldPackInitialObservationSourceV2 {
  const record = objectAt(value, file, at)
  exactKeys(record, ['key', 'content', 'epistemicKind'], ['saliencePermille', 'basisKeys'], file, at)
  return {
    key: textAt(record.key, file, pointer(at, 'key')),
    content: record.content as WorldJsonValue,
    epistemicKind: literalAt(
      record.epistemicKind,
      WORLD_PACK_INITIAL_OBSERVATION_EPISTEMIC_KINDS_V2,
      file,
      pointer(at, 'epistemicKind'),
    ),
    saliencePermille: integerAt(record.saliencePermille ?? 500, file, pointer(at, 'saliencePermille'), 0, 1000),
    basisKeys: basisKeysAt(record, file, at),
  }
}

function parseCognitionClaim(value: unknown, file: string, at: string): WorldPackClaimSourceV2 {
  const record = objectAt(value, file, at)
  exactKeys(record, ['key', 'proposition', 'stance', 'confidencePermille'], ['saliencePermille', 'awareness', 'status', 'basisKeys'], file, at)
  return {
    key: textAt(record.key, file, pointer(at, 'key')),
    proposition: record.proposition as WorldJsonValue,
    stance: literalAt(record.stance, CLAIM_STANCES, file, pointer(at, 'stance')),
    confidencePermille: integerAt(record.confidencePermille, file, pointer(at, 'confidencePermille'), 0, 1000),
    saliencePermille: integerAt(record.saliencePermille ?? 500, file, pointer(at, 'saliencePermille'), 0, 1000),
    awareness: literalAt(record.awareness ?? 'conscious', AWARENESS_LEVELS, file, pointer(at, 'awareness')),
    status: literalAt(record.status ?? 'active', ['active'], file, pointer(at, 'status')),
    basisKeys: basisKeysAt(record, file, at),
  }
}

function parseCognitionGoal(value: unknown, file: string, at: string): WorldPackGoalSourceV2 {
  const record = objectAt(value, file, at)
  exactKeys(record, ['key', 'objective'], ['priorityPermille', 'awareness', 'status', 'parentGoalKey', 'targetKeys', 'blockerKeys', 'basisKeys'], file, at)
  const objectiveAt = pointer(at, 'objective')
  const objective = objectAt(record.objective, file, objectiveAt)
  exactKeys(objective, ['kind', 'value'], [], file, objectiveAt)
  return {
    key: textAt(record.key, file, pointer(at, 'key')),
    objective: {
      kind: literalAt(objective.kind, GOAL_OBJECTIVE_KINDS, file, pointer(objectiveAt, 'kind')),
      value: objective.value as WorldJsonValue,
    },
    priorityPermille: integerAt(record.priorityPermille ?? 500, file, pointer(at, 'priorityPermille'), 0, 1000),
    awareness: literalAt(record.awareness ?? 'conscious', AWARENESS_LEVELS, file, pointer(at, 'awareness')),
    status: literalAt(record.status ?? 'active', GOAL_STATUSES, file, pointer(at, 'status')),
    parentGoalKey: optionalNullableTextAt(record.parentGoalKey, file, pointer(at, 'parentGoalKey')),
    targetKeys: optionalTextArrayAt(record.targetKeys, file, pointer(at, 'targetKeys')),
    blockerKeys: optionalTextArrayAt(record.blockerKeys, file, pointer(at, 'blockerKeys')),
    basisKeys: basisKeysAt(record, file, at),
  }
}

function parseCognitionRelationship(value: unknown, file: string, at: string): WorldPackRelationshipSourceV2 {
  const record = objectAt(value, file, at)
  exactKeys(record, ['key', 'target', 'type', 'facet', 'intensityPermille'], ['confidencePermille', 'awareness', 'status', 'basisKeys'], file, at)
  return {
    key: textAt(record.key, file, pointer(at, 'key')),
    target: idAt(record.target, file, pointer(at, 'target'), 'CharacterId'),
    type: literalAt(record.type, RELATIONSHIP_TYPES, file, pointer(at, 'type')),
    facet: textAt(record.facet, file, pointer(at, 'facet')),
    intensityPermille: integerAt(record.intensityPermille, file, pointer(at, 'intensityPermille'), 0, 1000),
    confidencePermille: integerAt(record.confidencePermille ?? 500, file, pointer(at, 'confidencePermille'), 0, 1000),
    awareness: literalAt(record.awareness ?? 'conscious', AWARENESS_LEVELS, file, pointer(at, 'awareness')),
    status: literalAt(record.status ?? 'active', RELATIONSHIP_STATUSES, file, pointer(at, 'status')),
    basisKeys: basisKeysAt(record, file, at),
  }
}

function parseCognitionAffect(value: unknown, file: string, at: string): WorldPackAffectSourceV2 {
  const record = objectAt(value, file, at)
  exactKeys(record, ['key', 'type', 'intensityPermille', 'cause'], ['targetKey', 'awareness', 'expressionMode', 'duration', 'status', 'basisKeys'], file, at)
  return {
    key: textAt(record.key, file, pointer(at, 'key')),
    type: literalAt(record.type, AFFECT_TYPES, file, pointer(at, 'type')),
    intensityPermille: integerAt(record.intensityPermille, file, pointer(at, 'intensityPermille'), 0, 1000),
    cause: record.cause as WorldJsonValue,
    targetKey: optionalNullableTextAt(record.targetKey, file, pointer(at, 'targetKey')),
    awareness: literalAt(record.awareness ?? 'conscious', AWARENESS_LEVELS, file, pointer(at, 'awareness')),
    expressionMode: literalAt(record.expressionMode ?? 'restrained', AFFECT_EXPRESSION_MODES, file, pointer(at, 'expressionMode')),
    duration: literalAt(record.duration ?? 'short_lived', AFFECT_DURATIONS, file, pointer(at, 'duration')),
    status: literalAt(record.status ?? 'active', AFFECT_STATUSES, file, pointer(at, 'status')),
    basisKeys: basisKeysAt(record, file, at),
  }
}

function parseTensionPole(value: unknown, file: string, at: string): WorldPackTensionPoleSourceV2 {
  const record = objectAt(value, file, at)
  exactKeys(record, ['key', 'tendency', 'impulseText', 'strengthPermille', 'awareness'], ['basisKeys'], file, at)
  return {
    key: textAt(record.key, file, pointer(at, 'key')),
    tendency: literalAt(record.tendency, TENSION_POLE_TENDENCIES, file, pointer(at, 'tendency')),
    impulseText: textAt(record.impulseText, file, pointer(at, 'impulseText')),
    strengthPermille: integerAt(record.strengthPermille, file, pointer(at, 'strengthPermille'), 0, 1000),
    awareness: literalAt(record.awareness, AWARENESS_LEVELS, file, pointer(at, 'awareness')),
    basisKeys: basisKeysAt(record, file, at),
  }
}

function parseCognitionTension(value: unknown, file: string, at: string): WorldPackInnerTensionSourceV2 {
  const record = objectAt(value, file, at)
  exactKeys(record, ['key', 'title', 'pressurePermille', 'poles'], ['awareness', 'status', 'basisKeys'], file, at)
  const polesAt = pointer(at, 'poles')
  const rawPoles = arrayAt(record.poles, file, polesAt)
  if (rawPoles.length < 2 || rawPoles.length > 4) {
    failWorldPackContract('PACK_SOURCE_INVALID', file, polesAt, 'must contain from 2 through 4 poles')
  }
  const poles = rawPoles.map((pole, index) => parseTensionPole(pole, file, pointer(polesAt, index)))
  unique(poles.map(pole => pole.key), file, polesAt)
  return {
    key: textAt(record.key, file, pointer(at, 'key')),
    title: textAt(record.title, file, pointer(at, 'title')),
    pressurePermille: integerAt(record.pressurePermille, file, pointer(at, 'pressurePermille'), 0, 1000),
    awareness: literalAt(record.awareness ?? 'conscious', AWARENESS_LEVELS, file, pointer(at, 'awareness')),
    status: literalAt(record.status ?? 'active', TENSION_STATUSES, file, pointer(at, 'status')),
    poles,
    basisKeys: basisKeysAt(record, file, at),
  }
}

function parseCognitionCommitment(value: unknown, file: string, at: string): WorldPackCommitmentSourceV2 {
  const record = objectAt(value, file, at)
  exactKeys(record, ['key', 'content', 'origin'], ['saliencePermille', 'awareness', 'status', 'basisKeys'], file, at)
  return {
    key: textAt(record.key, file, pointer(at, 'key')),
    content: record.content as WorldJsonValue,
    origin: literalAt(record.origin, COMMITMENT_ORIGINS, file, pointer(at, 'origin')),
    saliencePermille: integerAt(record.saliencePermille ?? 500, file, pointer(at, 'saliencePermille'), 0, 1000),
    awareness: literalAt(record.awareness ?? 'conscious', ['conscious', 'partially_conscious'], file, pointer(at, 'awareness')),
    status: literalAt(record.status ?? 'active', COMMITMENT_STATUSES, file, pointer(at, 'status')),
    basisKeys: basisKeysAt(record, file, at),
  }
}

function parseCognitionOpenLoop(value: unknown, file: string, at: string): WorldPackOpenLoopSourceV2 {
  const record = objectAt(value, file, at)
  exactKeys(record, ['key', 'kind', 'summary'], ['saliencePermille', 'status', 'basisKeys'], file, at)
  return {
    key: textAt(record.key, file, pointer(at, 'key')),
    kind: literalAt(record.kind, OPEN_LOOP_KINDS, file, pointer(at, 'kind')),
    summary: textAt(record.summary, file, pointer(at, 'summary')),
    saliencePermille: integerAt(record.saliencePermille ?? 500, file, pointer(at, 'saliencePermille'), 0, 1000),
    status: literalAt(record.status ?? 'open', OPEN_LOOP_STATUSES, file, pointer(at, 'status')),
    basisKeys: basisKeysAt(record, file, at),
  }
}

function parseCharacterCognition(value: unknown, file: string, at: string): WorldPackCharacterCognitionSourceV2 {
  const record = objectAt(value, file, at)
  exactKeys(record, ['characterId'], ['observations', 'claims', 'goals', 'relationships', 'affects', 'innerTensions', 'commitments', 'openLoops'], file, at)
  const parseRecords = <Result>(field: string, parse: (entry: unknown, entryFile: string, entryAt: string) => Result): readonly Result[] => {
    const fieldAt = pointer(at, field)
    return cognitionArray(record[field], file, fieldAt).map((entry, index) => parse(entry, file, pointer(fieldAt, index)))
  }
  const observations = parseRecords('observations', parseCognitionObservation)
  const claims = parseRecords('claims', parseCognitionClaim)
  const goals = parseRecords('goals', parseCognitionGoal)
  const relationships = parseRecords('relationships', parseCognitionRelationship)
  const affects = parseRecords('affects', parseCognitionAffect)
  const innerTensions = parseRecords('innerTensions', parseCognitionTension)
  const commitments = parseRecords('commitments', parseCognitionCommitment)
  const openLoops = parseRecords('openLoops', parseCognitionOpenLoop)
  unique([observations, claims, goals, relationships, affects, innerTensions, commitments, openLoops].flat().map(entry => entry.key), file, at)
  return {
    characterId: idAt(record.characterId, file, pointer(at, 'characterId'), 'CharacterId'),
    observations,
    claims,
    goals,
    relationships,
    affects,
    innerTensions,
    commitments,
    openLoops,
  }
}

/** Parse and materialize safe defaults for a Phase 8 cognition source file. */
export function parseWorldPackCognitionSourceV2(input: unknown, file = 'cognition.json'): WorldPackCognitionSourceV2 {
  const document = sourceDocument(input, file)
  exactKeys(document, ['schemaVersion', 'characters'], [], file, '')
  if (document.schemaVersion !== WORLD_PACK_COGNITION_SCHEMA_VERSION_V2) {
    failWorldPackContract('PACK_SOURCE_INVALID', file, '/schemaVersion', `must equal ${WORLD_PACK_COGNITION_SCHEMA_VERSION_V2}`)
  }
  const rawCharacters = arrayAt(document.characters, file, '/characters')
  if (rawCharacters.length > MAX_CHARACTERS) {
    failWorldPackContract('PACK_LIMIT_EXCEEDED', file, '/characters', `must contain at most ${MAX_CHARACTERS} characters`)
  }
  const characters = rawCharacters.map((entry, index) => parseCharacterCognition(entry, file, `/characters/${index}`))
  unique(characters.map(entry => entry.characterId), file, '/characters')
  return { schemaVersion: WORLD_PACK_COGNITION_SCHEMA_VERSION_V2, characters }
}

function parseSceneV2(value: unknown, file: string, at: string): WorldPackSceneSourceV2 {
  const scene = objectAt(value, file, at)
  exactKeys(scene, ['sceneId', 'lifecycle', 'participantIds'], ['locationId'], file, at)
  const participantIds = arrayAt(scene.participantIds, file, pointer(at, 'participantIds'))
    .map((entry, index) => idAt(entry, file, pointer(pointer(at, 'participantIds'), index), 'CharacterId'))
  unique(participantIds, file, pointer(at, 'participantIds'))
  const lifecycle = literalAt(scene.lifecycle, WORLD_PACK_SCENE_LIFECYCLES_V2, file, pointer(at, 'lifecycle'))
  if (lifecycle === 'active' && participantIds.length === 0) {
    failWorldPackContract('PACK_SOURCE_INVALID', file, pointer(at, 'participantIds'), 'must not be empty for an active Scene')
  }
  return {
    sceneId: textAt(scene.sceneId, file, pointer(at, 'sceneId')),
    lifecycle,
    locationId: optionalNullableTextAt(scene.locationId, file, pointer(at, 'locationId')),
    participantIds,
  }
}

/** Parse initial Phase 8 Scene lifecycle and membership declarations. */
export function parseWorldPackScenesSourceV2(input: unknown, file = 'scenes.json'): WorldPackScenesSourceV2 {
  const document = sourceDocument(input, file)
  exactKeys(document, ['schemaVersion', 'scenes'], [], file, '')
  if (document.schemaVersion !== WORLD_PACK_SCENES_SCHEMA_VERSION_V2) {
    failWorldPackContract('PACK_SOURCE_INVALID', file, '/schemaVersion', `must equal ${WORLD_PACK_SCENES_SCHEMA_VERSION_V2}`)
  }
  const rawScenes = arrayAt(document.scenes, file, '/scenes')
  if (rawScenes.length > MAX_LOCATIONS) {
    failWorldPackContract('PACK_LIMIT_EXCEEDED', file, '/scenes', `must contain at most ${MAX_LOCATIONS} scenes`)
  }
  const scenes = rawScenes.map((entry, index) => parseSceneV2(entry, file, `/scenes/${index}`))
  unique(scenes.map(entry => entry.sceneId), file, '/scenes')
  return { schemaVersion: WORLD_PACK_SCENES_SCHEMA_VERSION_V2, scenes }
}

/** Parse logical per-character Memory profiles; this function never accepts Memory rows. */
export function parseWorldPackMemorySourceV2(input: unknown, file = 'memory.json'): WorldPackMemorySourceV2 {
  const document = sourceDocument(input, file)
  exactKeys(document, ['schemaVersion', 'characters'], [], file, '')
  if (document.schemaVersion !== WORLD_PACK_MEMORY_SCHEMA_VERSION_V2) {
    failWorldPackContract('PACK_SOURCE_INVALID', file, '/schemaVersion', `must equal ${WORLD_PACK_MEMORY_SCHEMA_VERSION_V2}`)
  }
  const rawCharacters = arrayAt(document.characters, file, '/characters')
  if (rawCharacters.length > MAX_CHARACTERS) {
    failWorldPackContract('PACK_LIMIT_EXCEEDED', file, '/characters', `must contain at most ${MAX_CHARACTERS} characters`)
  }
  const characters = rawCharacters.map((entry, index) => {
    const at = `/characters/${index}`
    const character = objectAt(entry, file, at)
    exactKeys(character, ['characterId', 'profile'], ['attentionTopics'], file, at)
    return {
      characterId: idAt(character.characterId, file, pointer(at, 'characterId'), 'CharacterId'),
      profile: literalAt(character.profile, WORLD_PACK_MEMORY_PROFILES_V2, file, pointer(at, 'profile')),
      attentionTopics: optionalTextArrayAt(character.attentionTopics, file, pointer(at, 'attentionTopics')),
    }
  })
  unique(characters.map(entry => entry.characterId), file, '/characters')
  return { schemaVersion: WORLD_PACK_MEMORY_SCHEMA_VERSION_V2, characters }
}

function parseDocumentV2(value: unknown, file: string, at: string): WorldPackDocumentSourceV2 {
  const document = objectAt(value, file, at)
  exactKeys(document, ['documentId', 'contentRef', 'usage', 'audience'], ['characterIds'], file, at)
  const usage = literalAt(document.usage, WORLD_PACK_DOCUMENT_USAGES_V2, file, pointer(at, 'usage'))
  const audience = literalAt(document.audience, WORLD_PACK_DOCUMENT_AUDIENCES_V2, file, pointer(at, 'audience'))
  const characterIds = optionalArrayAt(document.characterIds, file, pointer(at, 'characterIds'))
    .map((entry, index) => idAt(entry, file, pointer(pointer(at, 'characterIds'), index), 'CharacterId'))
  unique(characterIds, file, pointer(at, 'characterIds'))
  if (audience === 'character_private' && characterIds.length === 0) {
    failWorldPackContract('PACK_SOURCE_INVALID', file, pointer(at, 'characterIds'), 'must not be empty for character_private audience')
  }
  if (audience !== 'character_private' && characterIds.length !== 0) {
    failWorldPackContract('PACK_SOURCE_INVALID', file, pointer(at, 'characterIds'), 'must be empty unless audience is character_private')
  }
  if ((usage === 'portrayal' || usage === 'memory_seed') && audience !== 'character_private') {
    failWorldPackContract('PACK_SOURCE_INVALID', file, pointer(at, 'audience'), `${usage} usage requires character_private audience`)
  }
  if (usage === 'author_note' && audience !== 'author_only') {
    failWorldPackContract('PACK_SOURCE_INVALID', file, pointer(at, 'audience'), 'author_note usage requires author_only audience')
  }
  return {
    documentId: textAt(document.documentId, file, pointer(at, 'documentId')),
    contentRef: textAt(document.contentRef, file, pointer(at, 'contentRef')),
    usage,
    audience,
    characterIds,
  }
}

/** Parse document metadata without interpreting referenced free text as instructions. */
export function parseWorldPackDocumentsSourceV2(input: unknown, file = 'documents.json'): WorldPackDocumentsSourceV2 {
  const root = sourceDocument(input, file)
  exactKeys(root, ['schemaVersion', 'documents'], [], file, '')
  if (root.schemaVersion !== WORLD_PACK_DOCUMENTS_SCHEMA_VERSION_V2) {
    failWorldPackContract('PACK_SOURCE_INVALID', file, '/schemaVersion', `must equal ${WORLD_PACK_DOCUMENTS_SCHEMA_VERSION_V2}`)
  }
  const rawDocuments = arrayAt(root.documents, file, '/documents')
  if (rawDocuments.length > MAX_DOCUMENTS) {
    failWorldPackContract('PACK_LIMIT_EXCEEDED', file, '/documents', `must contain at most ${MAX_DOCUMENTS} documents`)
  }
  const documents = rawDocuments.map((entry, index) => parseDocumentV2(entry, file, `/documents/${index}`))
  unique(documents.map(entry => entry.documentId), file, '/documents')
  return { schemaVersion: WORLD_PACK_DOCUMENTS_SCHEMA_VERSION_V2, documents }
}

/** Parse and default the Phase 7 world-level content contract. */
export function parseWorldPackWorldSource(input: unknown, file = 'world.json'): WorldPackWorldSource {
  const root = sourceDocument(input, file)
  exactKeys(root, ['schemaVersion', 'title'], ['description', 'timeMode', 'roundQueueLimit', 'coreProfiles', 'initialFacts'], file, '')
  if (root.schemaVersion !== 'worldpack-world/v1') {
    failWorldPackContract('PACK_SOURCE_INVALID', file, '/schemaVersion', 'must be worldpack-world/v1')
  }
  const facts = root.initialFacts === undefined ? [] : arrayAt(root.initialFacts, file, '/initialFacts')
    .map((entry, index) => parseFact(entry, file, `/initialFacts/${index}`))
  unique(facts.map(value => value.factId), file, '/initialFacts')
  const timeMode = root.timeMode ?? 'TURN_DRIVEN'
  if (timeMode !== 'TURN_DRIVEN') failWorldPackContract('PACK_SOURCE_INVALID', file, '/timeMode', 'must be TURN_DRIVEN')
  return {
    schemaVersion: 'worldpack-world/v1',
    title: textAt(root.title, file, '/title'),
    description: root.description === undefined ? '' : stringAt(root.description, file, '/description'),
    timeMode,
    roundQueueLimit: root.roundQueueLimit === undefined ? 8 : integerAt(root.roundQueueLimit, file, '/roundQueueLimit', 1, 1024),
    coreProfiles: profileAt(root.coreProfiles, file, '/coreProfiles'),
    initialFacts: facts,
  }
}

/** Parse the Phase 8 world source while keeping the v1 file shape and selecting only Phase 8 Core profiles. */
export function parseWorldPackWorldSourceV2(input: unknown, file = 'world.json'): WorldPackWorldSource {
  const root = sourceDocument(input, file)
  exactKeys(root, ['schemaVersion', 'title'], ['description', 'timeMode', 'roundQueueLimit', 'coreProfiles', 'initialFacts'], file, '')
  if (root.schemaVersion !== 'worldpack-world/v1') {
    failWorldPackContract('PACK_SOURCE_INVALID', file, '/schemaVersion', 'must be worldpack-world/v1')
  }
  const facts = root.initialFacts === undefined ? [] : arrayAt(root.initialFacts, file, '/initialFacts')
    .map((entry, index) => parseFact(entry, file, `/initialFacts/${index}`))
  unique(facts.map(value => value.factId), file, '/initialFacts')
  const timeMode = root.timeMode ?? 'TURN_DRIVEN'
  if (timeMode !== 'TURN_DRIVEN') failWorldPackContract('PACK_SOURCE_INVALID', file, '/timeMode', 'must be TURN_DRIVEN')
  return {
    schemaVersion: 'worldpack-world/v1',
    title: textAt(root.title, file, '/title'),
    description: root.description === undefined ? '' : stringAt(root.description, file, '/description'),
    timeMode,
    roundQueueLimit: root.roundQueueLimit === undefined ? 8 : integerAt(root.roundQueueLimit, file, '/roundQueueLimit', 1, 1024),
    coreProfiles: phase8ProfileAt(root.coreProfiles, file, '/coreProfiles'),
    initialFacts: facts,
  }
}

export function parseWorldPackLocationsSource(input: unknown, file = 'locations.json'): WorldPackLocationsSource {
  const root = sourceDocument(input, file)
  exactKeys(root, ['schemaVersion', 'locations'], [], file, '')
  if (root.schemaVersion !== 'worldpack-locations/v1') failWorldPackContract('PACK_SOURCE_INVALID', file, '/schemaVersion', 'must be worldpack-locations/v1')
  const locations = arrayAt(root.locations, file, '/locations').map((entry, index): WorldPackLocationSource => {
    const at = `/locations/${index}`; const value = objectAt(entry, file, at)
    exactKeys(value, ['locationId', 'name'], [], file, at)
    return { locationId: textAt(value.locationId, file, `${at}/locationId`), name: textAt(value.name, file, `${at}/name`) }
  })
  if (locations.length > MAX_LOCATIONS) failWorldPackContract('PACK_LIMIT_EXCEEDED', file, '/locations', `must contain at most ${MAX_LOCATIONS} locations`)
  nonEmpty(locations, file, '/locations'); unique(locations.map(value => value.locationId), file, '/locations')
  return { schemaVersion: 'worldpack-locations/v1', locations }
}

function parseEntityCore(value: unknown, file: string, at: string): WorldPackEntitySource {
  const entity = objectAt(value, file, at)
  exactKeys(entity, ['entityId', 'locationId', 'kind'], [], file, at)
  return {
    entityId: textAt(entity.entityId, file, `${at}/entityId`),
    locationId: textAt(entity.locationId, file, `${at}/locationId`),
    kind: textAt(entity.kind, file, `${at}/kind`),
  }
}

/** Author-declared bindings: identity and version only. A label never selects a definition. */
function parseInteractionBindings(
  value: unknown,
  file: string,
  at: string,
): readonly WorldPackInteractionBindingSource[] {
  const bindings = arrayAt(value, file, at).map((entry, index): WorldPackInteractionBindingSource => {
    const slot = `${at}/${index}`
    const binding = objectAt(entry, file, slot)
    exactKeys(binding, ['bindingId', 'definition', 'config'], [], file, slot)
    const definition = objectAt(binding.definition, file, `${slot}/definition`)
    exactKeys(definition, ['id', 'version'], [], file, `${slot}/definition`)
    const config = objectAt(binding.config, file, `${slot}/config`)
    canonicalizeWorldJson(config as WorldJsonValue)
    return {
      bindingId: textAt(binding.bindingId, file, `${slot}/bindingId`),
      definition: {
        id: textAt(definition.id, file, `${slot}/definition/id`),
        version: integerAt(definition.version, file, `${slot}/definition/version`, 1, Number.MAX_SAFE_INTEGER),
      },
      config: config as WorldJsonObject,
    }
  })
  unique(bindings.map(binding => binding.bindingId), file, at)
  return bindings
}

export function parseWorldPackEntitiesSource(input: unknown, file = 'entities.json'): WorldPackEntitiesSource {
  const root = sourceDocument(input, file); exactKeys(root, ['schemaVersion', 'entities'], [], file, '')
  if (root.schemaVersion !== 'worldpack-entities/v1') failWorldPackContract('PACK_SOURCE_INVALID', file, '/schemaVersion', 'must be worldpack-entities/v1')
  const entities = arrayAt(root.entities, file, '/entities').map((entry, index) => parseEntityCore(entry, file, `/entities/${index}`))
  if (entities.length > MAX_ENTITIES) failWorldPackContract('PACK_LIMIT_EXCEEDED', file, '/entities', `must contain at most ${MAX_ENTITIES} entities`)
  unique(entities.map(value => value.entityId), file, '/entities')
  return { schemaVersion: 'worldpack-entities/v1', entities }
}

/** V2 entities may declare interaction bindings. V1 file bytes and their Hash are untouched. */
export function parseWorldPackEntitiesSourceV2(input: unknown, file = 'entities.json'): WorldPackEntitiesSourceV2 {
  const root = sourceDocument(input, file); exactKeys(root, ['schemaVersion', 'entities'], [], file, '')
  if (root.schemaVersion !== WORLD_PACK_ENTITIES_SCHEMA_VERSION_V2) {
    failWorldPackContract('PACK_SOURCE_INVALID', file, '/schemaVersion', `must equal ${WORLD_PACK_ENTITIES_SCHEMA_VERSION_V2}`)
  }
  const entities = arrayAt(root.entities, file, '/entities').map((entry, index): WorldPackEntitySourceV2 => {
    const at = `/entities/${index}`
    const raw = objectAt(entry, file, at)
    exactKeys(raw, ['entityId', 'locationId', 'kind'], ['interactionBindings'], file, at)
    const { interactionBindings, ...core } = raw
    const base = parseEntityCore(core, file, at)
    return interactionBindings === undefined
      ? base
      : { ...base, interactionBindings: parseInteractionBindings(interactionBindings, file, `${at}/interactionBindings`) }
  })
  if (entities.length > MAX_ENTITIES) failWorldPackContract('PACK_LIMIT_EXCEEDED', file, '/entities', `must contain at most ${MAX_ENTITIES} entities`)
  unique(entities.map(value => value.entityId), file, '/entities')
  return { schemaVersion: WORLD_PACK_ENTITIES_SCHEMA_VERSION_V2, entities }
}

/** V3 characters may declare interaction bindings; every V2 field keeps its validation. */
export function parseWorldPackCharactersSourceV3(input: unknown, file = 'characters.json'): WorldPackCharactersSourceV3 {
  const document = sourceDocument(input, file)
  exactKeys(document, ['schemaVersion', 'characters'], [], file, '')
  if (document.schemaVersion !== WORLD_PACK_CHARACTERS_SCHEMA_VERSION_V3) {
    failWorldPackContract('PACK_SOURCE_INVALID', file, '/schemaVersion', `must equal ${WORLD_PACK_CHARACTERS_SCHEMA_VERSION_V3}`)
  }
  const rawCharacters = arrayAt(document.characters, file, '/characters')
  if (rawCharacters.length > MAX_CHARACTERS) {
    failWorldPackContract('PACK_LIMIT_EXCEEDED', file, '/characters', `must contain at most ${MAX_CHARACTERS} characters`)
  }
  const characters = rawCharacters.map((entry, index): WorldPackCharacterSourceV3 => {
    const at = `/characters/${index}`
    const raw = objectAt(entry, file, at)
    const { interactionBindings, ...core } = raw
    const base = parseCharacterV2(core, file, at)
    return interactionBindings === undefined
      ? base
      : { ...base, interactionBindings: parseInteractionBindings(interactionBindings, file, `${at}/interactionBindings`) }
  })
  unique(characters.map(entry => entry.characterId), file, '/characters')
  return { schemaVersion: WORLD_PACK_CHARACTERS_SCHEMA_VERSION_V3, characters }
}

/** The world's explicit selection. It names identities; the compiler resolves the trusted locks. */
export function parseWorldPackInteractionsSource(input: unknown, file = 'interactions.json'): WorldPackInteractionsSource {
  const root = sourceDocument(input, file)
  exactKeys(root, ['schemaVersion', 'packages', 'definitions'], [], file, '')
  if (root.schemaVersion !== WORLD_PACK_INTERACTIONS_SCHEMA_VERSION) {
    failWorldPackContract('PACK_SOURCE_INVALID', file, '/schemaVersion', `must equal ${WORLD_PACK_INTERACTIONS_SCHEMA_VERSION}`)
  }
  const identity = (value: unknown, at: string): { readonly id: string; readonly version: number } => {
    const row = objectAt(value, file, at)
    exactKeys(row, ['id', 'version'], [], file, at)
    return {
      id: textAt(row.id, file, `${at}/id`),
      version: integerAt(row.version, file, `${at}/version`, 1, Number.MAX_SAFE_INTEGER),
    }
  }
  const packages = arrayAt(root.packages, file, '/packages').map((entry, index) => identity(entry, `/packages/${index}`))
  const definitions = arrayAt(root.definitions, file, '/definitions').map((entry, index) => identity(entry, `/definitions/${index}`))
  if (packages.length === 0) failWorldPackContract('PACK_SOURCE_INVALID', file, '/packages', 'must select at least one package')
  if (packages.length > MAX_INTERACTION_PACKAGES) {
    failWorldPackContract('PACK_LIMIT_EXCEEDED', file, '/packages', `must select at most ${MAX_INTERACTION_PACKAGES} packages`)
  }
  if (definitions.length > MAX_INTERACTION_DEFINITIONS) {
    failWorldPackContract('PACK_LIMIT_EXCEEDED', file, '/definitions', `must select at most ${MAX_INTERACTION_DEFINITIONS} definitions`)
  }
  unique(packages.map(pkg => `${pkg.id}@${pkg.version}`), file, '/packages')
  unique(definitions.map(definition => `${definition.id}@${definition.version}`), file, '/definitions')
  return { schemaVersion: WORLD_PACK_INTERACTIONS_SCHEMA_VERSION, packages, definitions }
}

function parseObservation(value: unknown, file: string, at: string): WorldPackInitialObservationSource {
  const item = objectAt(value, file, at); exactKeys(item, ['observationId', 'value'], [], file, at)
  return { observationId: textAt(item.observationId, file, `${at}/observationId`), value: item.value as WorldJsonValue }
}

function parseClaim(value: unknown, file: string, at: string): WorldPackInitialClaimSource {
  const item = objectAt(value, file, at); exactKeys(item, ['claimId', 'value'], [], file, at)
  return { claimId: textAt(item.claimId, file, `${at}/claimId`), value: item.value as WorldJsonValue }
}

function parseGoal(value: unknown, file: string, at: string): WorldPackInitialGoalSource {
  const item = objectAt(value, file, at); exactKeys(item, ['goalId', 'value'], ['priorityPermille', 'visibility'], file, at)
  const visibility = item.visibility ?? 'private'
  if (visibility !== 'private' && visibility !== 'public') failWorldPackContract('PACK_SOURCE_INVALID', file, `${at}/visibility`, 'must be private or public')
  return {
    goalId: textAt(item.goalId, file, `${at}/goalId`), value: item.value as WorldJsonValue,
    priorityPermille: item.priorityPermille === undefined ? 500 : integerAt(item.priorityPermille, file, `${at}/priorityPermille`, 0, 1000),
    visibility,
  }
}

function parseCharacter(value: unknown, file: string, at: string): WorldPackCharacterSource {
  const item = objectAt(value, file, at)
  exactKeys(item, ['characterId', 'displayName', 'initialLocationId'], [
    'pronouns', 'lifecycle', 'portrayal', 'initialObservations', 'initialClaims', 'initialGoals',
  ], file, at)
  const lifecycle = item.lifecycle ?? 'active'
  if (lifecycle !== 'active' && lifecycle !== 'incapacitated' && lifecycle !== 'dead' && lifecycle !== 'departed') {
    failWorldPackContract('PACK_SOURCE_INVALID', file, `${at}/lifecycle`, 'is not a Character lifecycle state')
  }
  const portrayalValue = item.portrayal === undefined ? {} : objectAt(item.portrayal, file, `${at}/portrayal`)
  exactKeys(portrayalValue, [], ['summary', 'speakingStyle', 'backgroundTextRef'], file, `${at}/portrayal`)
  const observations = item.initialObservations === undefined ? [] : arrayAt(item.initialObservations, file, `${at}/initialObservations`)
    .map((entry, index) => parseObservation(entry, file, `${at}/initialObservations/${index}`))
  const claims = item.initialClaims === undefined ? [] : arrayAt(item.initialClaims, file, `${at}/initialClaims`)
    .map((entry, index) => parseClaim(entry, file, `${at}/initialClaims/${index}`))
  const goals = item.initialGoals === undefined ? [] : arrayAt(item.initialGoals, file, `${at}/initialGoals`)
    .map((entry, index) => parseGoal(entry, file, `${at}/initialGoals/${index}`))
  unique(observations.map(entry => entry.observationId), file, `${at}/initialObservations`)
  unique(claims.map(entry => entry.claimId), file, `${at}/initialClaims`)
  unique(goals.map(entry => entry.goalId), file, `${at}/initialGoals`)
  return {
    characterId: idAt(item.characterId, file, `${at}/characterId`, 'CharacterId'),
    displayName: textAt(item.displayName, file, `${at}/displayName`),
    pronouns: item.pronouns === undefined ? '' : stringAt(item.pronouns, file, `${at}/pronouns`),
    initialLocationId: textAt(item.initialLocationId, file, `${at}/initialLocationId`),
    lifecycle,
    portrayal: {
      summary: portrayalValue.summary === undefined ? '' : stringAt(portrayalValue.summary, file, `${at}/portrayal/summary`),
      speakingStyle: portrayalValue.speakingStyle === undefined ? '' : stringAt(portrayalValue.speakingStyle, file, `${at}/portrayal/speakingStyle`),
      backgroundTextRef: portrayalValue.backgroundTextRef === undefined || portrayalValue.backgroundTextRef === null
        ? null
        : textAt(portrayalValue.backgroundTextRef, file, `${at}/portrayal/backgroundTextRef`),
    },
    initialObservations: observations, initialClaims: claims, initialGoals: goals,
  }
}

export function parseWorldPackCharactersSource(input: unknown, file = 'characters.json'): WorldPackCharactersSource {
  const root = sourceDocument(input, file); exactKeys(root, ['schemaVersion', 'characters'], [], file, '')
  if (root.schemaVersion !== 'worldpack-characters/v1') failWorldPackContract('PACK_SOURCE_INVALID', file, '/schemaVersion', 'must be worldpack-characters/v1')
  const characters = arrayAt(root.characters, file, '/characters').map((entry, index) => parseCharacter(entry, file, `/characters/${index}`))
  if (characters.length > MAX_CHARACTERS) failWorldPackContract('PACK_LIMIT_EXCEEDED', file, '/characters', `must contain at most ${MAX_CHARACTERS} characters`)
  nonEmpty(characters, file, '/characters'); unique(characters.map(value => value.characterId), file, '/characters')
  return { schemaVersion: 'worldpack-characters/v1', characters }
}

export function parseWorldPackScenesSource(input: unknown, file = 'scenes.json'): WorldPackScenesSource {
  const root = sourceDocument(input, file); exactKeys(root, ['schemaVersion', 'scenes'], [], file, '')
  if (root.schemaVersion !== 'worldpack-scenes/v1') failWorldPackContract('PACK_SOURCE_INVALID', file, '/schemaVersion', 'must be worldpack-scenes/v1')
  const scenes = arrayAt(root.scenes, file, '/scenes').map((entry, index): WorldPackSceneSource => {
    const at = `/scenes/${index}`; const item = objectAt(entry, file, at); exactKeys(item, ['sceneId', 'participantIds'], [], file, at)
    const participantIds = arrayAt(item.participantIds, file, `${at}/participantIds`)
      .map((value, participantIndex) => idAt(value, file, `${at}/participantIds/${participantIndex}`, 'CharacterId'))
    nonEmpty(participantIds, file, `${at}/participantIds`); unique(participantIds, file, `${at}/participantIds`)
    return { sceneId: textAt(item.sceneId, file, `${at}/sceneId`), participantIds }
  })
  if (scenes.length !== 1) failWorldPackContract('PACK_SOURCE_INVALID', file, '/scenes', 'Phase 7 requires exactly one Scene')
  return { schemaVersion: 'worldpack-scenes/v1', scenes: [scenes[0]!] }
}

export function parseWorldPackPlayerSlotsSource(input: unknown, file = 'player-slots.json'): WorldPackPlayerSlotsSource {
  const root = sourceDocument(input, file); exactKeys(root, ['schemaVersion', 'playerSlots'], [], file, '')
  if (root.schemaVersion !== 'worldpack-player-slots/v1') failWorldPackContract('PACK_SOURCE_INVALID', file, '/schemaVersion', 'must be worldpack-player-slots/v1')
  const slots = arrayAt(root.playerSlots, file, '/playerSlots').map((entry, index): WorldPackPlayerSlotSource => {
    const at = `/playerSlots/${index}`; const item = objectAt(entry, file, at)
    exactKeys(item, ['slotId', 'characterId'], ['controlMode'], file, at)
    const controlMode = item.controlMode ?? 'manual'
    if (controlMode !== 'manual') failWorldPackContract('PACK_SOURCE_INVALID', file, `${at}/controlMode`, 'Phase 7 only supports manual control')
    return {
      slotId: idAt(item.slotId, file, `${at}/slotId`, 'WorldPackSlotId') as WorldPackSlotId,
      characterId: idAt(item.characterId, file, `${at}/characterId`, 'CharacterId'), controlMode,
    }
  })
  if (slots.length !== 1) failWorldPackContract('PACK_SOURCE_INVALID', file, '/playerSlots', 'Phase 7 requires exactly one PlayerSlot')
  return { schemaVersion: 'worldpack-player-slots/v1', playerSlots: [slots[0]!] }
}

export function parseWorldPackPresentationSource(input: unknown, file = 'presentation.json'): WorldPackPresentationSource {
  const root = sourceDocument(input, file); exactKeys(root, ['schemaVersion'], ['locale', 'style'], file, '')
  if (root.schemaVersion !== 'worldpack-presentation/v1') failWorldPackContract('PACK_SOURCE_INVALID', file, '/schemaVersion', 'must be worldpack-presentation/v1')
  const locale = root.locale ?? 'en'; const style = root.style ?? 'plain'
  if (locale !== 'en' && locale !== 'zh-CN') failWorldPackContract('PACK_SOURCE_INVALID', file, '/locale', 'must be en or zh-CN')
  if (style !== 'plain') failWorldPackContract('PACK_SOURCE_INVALID', file, '/style', 'Phase 7 only supports plain presentation')
  return { schemaVersion: 'worldpack-presentation/v1', locale, style }
}

function parseAssertion(value: unknown, file: string, at: string): WorldPackAcceptanceAssertion {
  const item = objectAt(value, file, at); exactKeys(item, ['assertionId', 'assertionType', 'parameters'], [], file, at)
  return {
    assertionId: textAt(item.assertionId, file, `${at}/assertionId`),
    assertionType: textAt(item.assertionType, file, `${at}/assertionType`),
    parameters: item.parameters as WorldJsonValue,
  }
}

export function parseWorldPackAssertionsSource(input: unknown, file = 'assertions.json'): WorldPackAssertionsSource {
  const root = sourceDocument(input, file); exactKeys(root, ['schemaVersion', 'assertions'], [], file, '')
  if (root.schemaVersion !== 'worldpack-assertions/v1') failWorldPackContract('PACK_SOURCE_INVALID', file, '/schemaVersion', 'must be worldpack-assertions/v1')
  const assertions = arrayAt(root.assertions, file, '/assertions').map((entry, index) => parseAssertion(entry, file, `/assertions/${index}`))
  unique(assertions.map(value => value.assertionId), file, '/assertions')
  return { schemaVersion: 'worldpack-assertions/v1', assertions }
}

function pluginLocksAt(
  value: unknown,
  file: string,
  at: string,
  profiles = PHASE7_CORE_PROFILES,
  phaseLabel = 'Phase 7',
): WorldPackPluginLock[] {
  const allowed = new Map<string, readonly [string, string]>([
    ['rulebook', [profiles.rulebook.rulebookId, String(profiles.rulebook.version)]],
    ['scene-decision', [profiles.sceneDecision.pluginId, profiles.sceneDecision.version]],
    ['agent-context', [profiles.agentContext.pluginId, profiles.agentContext.version]],
    ['presentation', [profiles.presentation.profileId, profiles.presentation.version]],
  ])
  const locks = arrayAt(value, file, at).map((entry, index): WorldPackPluginLock => {
    const itemAt = `${at}/${index}`; const item = objectAt(entry, file, itemAt); exactKeys(item, ['kind', 'id', 'version', 'pluginHash'], [], file, itemAt)
    const kind = textAt(item.kind, file, `${itemAt}/kind`)
    const expected = allowed.get(kind)
    if (expected === undefined || item.id !== expected[0] || String(item.version) !== expected[1]) {
      failWorldPackContract('PLUGIN_NOT_REGISTERED', file, itemAt, `is not an installed exact ${phaseLabel} plugin lock`)
    }
    const id = textAt(item.id, file, `${itemAt}/id`)
    const version = textAt(item.version, file, `${itemAt}/version`)
    const pluginHash = hashAt(item.pluginHash, file, `${itemAt}/pluginHash`)
    if (pluginHash !== hashWorldJson('world-pack-core-plugin-lock/v1', { kind, id, version })) {
      failWorldPackContract('REGISTRY_HASH_MISMATCH', file, `${itemAt}/pluginHash`, 'does not match the locked Core plugin contract')
    }
    return { kind: kind as WorldPackPluginLock['kind'], id, version, pluginHash }
  })
  unique(locks.map(lock => lock.kind), file, at)
  if (locks.length !== allowed.size) failWorldPackContract('PLUGIN_NOT_REGISTERED', file, at, `must lock every ${phaseLabel} Core profile`)
  return locks
}

function markdownAt(value: unknown, file: string, at: string): WorldPackMarkdownContent {
  const item = objectAt(value, file, at); exactKeys(item, ['path', 'text', 'contentHash'], [], file, at)
  const text = stringAt(item.text, file, `${at}/text`)
  if (new TextEncoder().encode(text).byteLength > MAX_MARKDOWN_BYTES) {
    failWorldPackContract('PACK_LIMIT_EXCEEDED', file, `${at}/text`, `exceeds the ${MAX_MARKDOWN_BYTES}-byte Markdown limit`)
  }
  const contentHash = hashAt(item.contentHash, file, `${at}/contentHash`)
  const actualHash = `sha256:${createHash('sha256').update(new TextEncoder().encode(text)).digest('hex')}`
  if (contentHash !== actualHash) failWorldPackContract('PACK_SOURCE_INVALID', file, `${at}/contentHash`, 'does not match the Markdown text bytes')
  return { path: textAt(item.path, file, `${at}/path`), text, contentHash }
}

function assetAt(value: unknown, file: string, at: string): WorldPackAssetLock {
  const item = objectAt(value, file, at); exactKeys(item, ['path', 'contentHash', 'size'], [], file, at)
  const size = integerAt(item.size, file, `${at}/size`, 0, Number.MAX_SAFE_INTEGER)
  if (size > MAX_ASSET_BYTES) {
    failWorldPackContract('PACK_LIMIT_EXCEEDED', file, `${at}/size`, `exceeds the ${MAX_ASSET_BYTES}-byte asset limit`)
  }
  return { path: textAt(item.path, file, `${at}/path`), contentHash: hashAt(item.contentHash, file, `${at}/contentHash`), size }
}

/** Validate one already-compiled envelope without recomputing its P7.2 pack hash. */
export function parseCompiledWorldPack(input: unknown, file = 'worldpack.json'): CompiledWorldPack {
  const root = sourceDocument(input, file, MAX_COMPILED_BYTES)
  exactKeys(root, ['compiledSchemaVersion', 'packId', 'packVersion', 'packHash', 'compiler', 'pluginLocks', 'content', 'assets', 'acceptanceAssertions'], [], file, '')
  if (root.compiledSchemaVersion !== WORLD_PACK_COMPILED_SCHEMA_VERSION) failWorldPackContract('PACK_SOURCE_INVALID', file, '/compiledSchemaVersion', `must be ${WORLD_PACK_COMPILED_SCHEMA_VERSION}`)
  const compiler = objectAt(root.compiler, file, '/compiler'); exactKeys(compiler, ['id', 'version', 'contractVersion', 'canonicalJsonVersion', 'limitsProfile'], [], file, '/compiler')
  if (compiler.id !== WORLD_PACK_COMPILER_ID || compiler.version !== WORLD_PACK_COMPILER_VERSION
    || compiler.contractVersion !== WORLD_PACK_COMPILER_CONTRACT_VERSION || compiler.canonicalJsonVersion !== 'world-json/v1'
    || compiler.limitsProfile !== WORLD_PACK_LIMITS_PROFILE) {
    failWorldPackContract('PACK_SOURCE_INVALID', file, '/compiler', 'does not identify the Phase 7 compiler contract')
  }
  const content = objectAt(root.content, file, '/content'); exactKeys(content, ['world', 'locations', 'entities', 'characters', 'scenes', 'playerSlots', 'presentation', 'markdown'], [], file, '/content')
  const parsedContent: WorldPackCompiledContent = {
    world: parseWorldPackWorldSource(content.world, `${file}#/content/world`),
    locations: parseWorldPackLocationsSource({ schemaVersion: 'worldpack-locations/v1', locations: content.locations }, `${file}#/content/locations`).locations,
    entities: parseWorldPackEntitiesSource({ schemaVersion: 'worldpack-entities/v1', entities: content.entities }, `${file}#/content/entities`).entities,
    characters: parseWorldPackCharactersSource({ schemaVersion: 'worldpack-characters/v1', characters: content.characters }, `${file}#/content/characters`).characters,
    scenes: parseWorldPackScenesSource({ schemaVersion: 'worldpack-scenes/v1', scenes: content.scenes }, `${file}#/content/scenes`).scenes,
    playerSlots: parseWorldPackPlayerSlotsSource({ schemaVersion: 'worldpack-player-slots/v1', playerSlots: content.playerSlots }, `${file}#/content/playerSlots`).playerSlots,
    presentation: parseWorldPackPresentationSource(content.presentation, `${file}#/content/presentation`),
    markdown: arrayAt(content.markdown, file, '/content/markdown').map((entry, index) => markdownAt(entry, file, `/content/markdown/${index}`)),
  }
  unique(parsedContent.markdown.map(value => value.path), file, '/content/markdown')
  const assets = arrayAt(root.assets, file, '/assets').map((entry, index) => assetAt(entry, file, `/assets/${index}`))
  unique(assets.map(value => value.path), file, '/assets')
  const acceptanceAssertions = arrayAt(root.acceptanceAssertions, file, '/acceptanceAssertions')
    .map((entry, index) => parseAssertion(entry, file, `/acceptanceAssertions/${index}`))
  unique(acceptanceAssertions.map(value => value.assertionId), file, '/acceptanceAssertions')
  return {
    compiledSchemaVersion: WORLD_PACK_COMPILED_SCHEMA_VERSION,
    packId: idAt(root.packId, file, '/packId', 'WorldPackId') as WorldPackId,
    packVersion: semverAt(root.packVersion, file, '/packVersion'), packHash: hashAt(root.packHash, file, '/packHash'),
    compiler: {
      id: WORLD_PACK_COMPILER_ID, version: WORLD_PACK_COMPILER_VERSION,
      contractVersion: WORLD_PACK_COMPILER_CONTRACT_VERSION, canonicalJsonVersion: 'world-json/v1', limitsProfile: WORLD_PACK_LIMITS_PROFILE,
    },
    pluginLocks: pluginLocksAt(root.pluginLocks, file, '/pluginLocks'), content: parsedContent, assets, acceptanceAssertions,
  }
}

function exactPhase8LocksAt(
  value: unknown,
  expected: WorldJsonValue,
  domain: string,
  file: string,
  at: string,
): void {
  arrayAt(value, file, at)
  if (hashWorldJson(domain, value as WorldJsonValue) !== hashWorldJson(domain, expected)) {
    failWorldPackContract('REGISTRY_HASH_MISMATCH', file, at, 'does not match the exact Phase 8 lock set')
  }
}

/** Validate one compiled v2 envelope and every immutable Phase 8 registry lock. */
export function parseCompiledWorldPackV2(input: unknown, file = 'worldpack.json'): CompiledWorldPackV2 {
  const root = sourceDocument(input, file, MAX_COMPILED_BYTES)
  exactKeys(root, [
    'compiledSchemaVersion', 'packId', 'packVersion', 'packHash', 'compiler', 'pluginLocks', 'vocabularyLocks',
    'registryLocks', 'content', 'assets', 'acceptanceAssertions',
  ], [], file, '')
  if (root.compiledSchemaVersion !== WORLD_PACK_COMPILED_SCHEMA_VERSION_V2) {
    failWorldPackContract('PACK_SOURCE_INVALID', file, '/compiledSchemaVersion', `must be ${WORLD_PACK_COMPILED_SCHEMA_VERSION_V2}`)
  }
  const compiler = objectAt(root.compiler, file, '/compiler')
  exactKeys(compiler, ['id', 'version', 'contractVersion', 'canonicalJsonVersion', 'limitsProfile'], [], file, '/compiler')
  if (compiler.id !== WORLD_PACK_COMPILER_ID || compiler.version !== WORLD_PACK_COMPILER_VERSION_V2
    || compiler.contractVersion !== WORLD_PACK_COMPILER_CONTRACT_VERSION_V2 || compiler.canonicalJsonVersion !== 'world-json/v1'
    || compiler.limitsProfile !== WORLD_PACK_LIMITS_PROFILE_V2) {
    failWorldPackContract('PACK_SOURCE_INVALID', file, '/compiler', 'does not identify the Phase 8 compiler contract')
  }
  const content = objectAt(root.content, file, '/content')
  exactKeys(content, [
    'world', 'locations', 'entities', 'characters', 'scenes', 'playerSlots', 'cognition', 'memory', 'documents',
    'presentation', 'markdown',
  ], [], file, '/content')
  const parsedContent: WorldPackCompiledContentV2 = {
    world: parseWorldPackWorldSourceV2(content.world, `${file}#/content/world`),
    locations: parseWorldPackLocationsSource({ schemaVersion: 'worldpack-locations/v1', locations: content.locations }, `${file}#/content/locations`).locations,
    entities: parseWorldPackEntitiesSource({ schemaVersion: 'worldpack-entities/v1', entities: content.entities }, `${file}#/content/entities`).entities,
    characters: parseWorldPackCharactersSourceV2({ schemaVersion: WORLD_PACK_CHARACTERS_SCHEMA_VERSION_V2, characters: content.characters }, `${file}#/content/characters`).characters,
    scenes: parseWorldPackScenesSourceV2({ schemaVersion: WORLD_PACK_SCENES_SCHEMA_VERSION_V2, scenes: content.scenes }, `${file}#/content/scenes`).scenes,
    playerSlots: parseWorldPackPlayerSlotsSource({ schemaVersion: 'worldpack-player-slots/v1', playerSlots: content.playerSlots }, `${file}#/content/playerSlots`).playerSlots,
    cognition: parseWorldPackCognitionSourceV2({ schemaVersion: WORLD_PACK_COGNITION_SCHEMA_VERSION_V2, characters: content.cognition }, `${file}#/content/cognition`).characters,
    memory: parseWorldPackMemorySourceV2({ schemaVersion: WORLD_PACK_MEMORY_SCHEMA_VERSION_V2, characters: content.memory }, `${file}#/content/memory`).characters,
    documents: parseWorldPackDocumentsSourceV2({ schemaVersion: WORLD_PACK_DOCUMENTS_SCHEMA_VERSION_V2, documents: content.documents }, `${file}#/content/documents`).documents,
    presentation: parseWorldPackPresentationSource(content.presentation, `${file}#/content/presentation`),
    markdown: arrayAt(content.markdown, file, '/content/markdown').map((entry, index) => markdownAt(entry, file, `/content/markdown/${index}`)),
  }
  unique(parsedContent.markdown.map(value => value.path), file, '/content/markdown')
  const assets = arrayAt(root.assets, file, '/assets').map((entry, index) => assetAt(entry, file, `/assets/${index}`))
  unique(assets.map(value => value.path), file, '/assets')
  const acceptanceAssertions = arrayAt(root.acceptanceAssertions, file, '/acceptanceAssertions')
    .map((entry, index) => parseAssertion(entry, file, `/acceptanceAssertions/${index}`))
  unique(acceptanceAssertions.map(value => value.assertionId), file, '/acceptanceAssertions')
  const pluginLocks = pluginLocksAt(root.pluginLocks, file, '/pluginLocks', PHASE8_CORE_PROFILES, 'Phase 8')
  exactPhase8LocksAt(root.vocabularyLocks, PHASE8_VOCABULARY_LOCKS, 'phase8-vocabulary-lock-set/v1', file, '/vocabularyLocks')
  exactPhase8LocksAt(root.registryLocks, PHASE8_REGISTRY_LOCKS, 'phase8-registry-lock-set/v1', file, '/registryLocks')
  return {
    compiledSchemaVersion: WORLD_PACK_COMPILED_SCHEMA_VERSION_V2,
    packId: idAt(root.packId, file, '/packId', 'WorldPackId') as WorldPackId,
    packVersion: semverAt(root.packVersion, file, '/packVersion'),
    packHash: hashAt(root.packHash, file, '/packHash'),
    compiler: {
      id: WORLD_PACK_COMPILER_ID,
      version: WORLD_PACK_COMPILER_VERSION_V2,
      contractVersion: WORLD_PACK_COMPILER_CONTRACT_VERSION_V2,
      canonicalJsonVersion: 'world-json/v1',
      limitsProfile: WORLD_PACK_LIMITS_PROFILE_V2,
    },
    pluginLocks,
    vocabularyLocks: PHASE8_VOCABULARY_LOCKS,
    registryLocks: PHASE8_REGISTRY_LOCKS,
    content: parsedContent,
    assets,
    acceptanceAssertions,
  }
}

/** Validate one compiled v3 envelope while delegating the frozen Phase 8 content shape to the v2 parser. */
export function parseCompiledWorldPackV3(input: unknown, file = 'worldpack.json'): CompiledWorldPackV3 {
  const root = sourceDocument(input, file, MAX_COMPILED_BYTES)
  exactKeys(root, [
    'compiledSchemaVersion', 'packId', 'packVersion', 'packHash', 'compiler', 'pluginLocks', 'vocabularyLocks',
    'registryLocks', 'reaction', 'content', 'assets', 'acceptanceAssertions',
  ], [], file, '')
  if (root.compiledSchemaVersion !== WORLD_PACK_COMPILED_SCHEMA_VERSION_V3) {
    failWorldPackContract('PACK_SOURCE_INVALID', file, '/compiledSchemaVersion', `must be ${WORLD_PACK_COMPILED_SCHEMA_VERSION_V3}`)
  }
  const compiler = objectAt(root.compiler, file, '/compiler')
  exactKeys(compiler, ['id', 'version', 'contractVersion', 'canonicalJsonVersion', 'limitsProfile'], [], file, '/compiler')
  if (compiler.id !== WORLD_PACK_COMPILER_ID || compiler.version !== WORLD_PACK_COMPILER_VERSION_V3
    || compiler.contractVersion !== WORLD_PACK_COMPILER_CONTRACT_VERSION_V3 || compiler.canonicalJsonVersion !== 'world-json/v1'
    || compiler.limitsProfile !== WORLD_PACK_LIMITS_PROFILE_V2) {
    failWorldPackContract('PACK_SOURCE_INVALID', file, '/compiler', 'does not identify the Phase 9 compiler contract')
  }
  const { reaction: reactionInput, ...withoutReaction } = root
  const base = parseCompiledWorldPackV2({
    ...withoutReaction,
    compiledSchemaVersion: WORLD_PACK_COMPILED_SCHEMA_VERSION_V2,
    compiler: {
      id: WORLD_PACK_COMPILER_ID, version: WORLD_PACK_COMPILER_VERSION_V2,
      contractVersion: WORLD_PACK_COMPILER_CONTRACT_VERSION_V2,
      canonicalJsonVersion: 'world-json/v1', limitsProfile: WORLD_PACK_LIMITS_PROFILE_V2,
    },
  }, file)
  return {
    ...base,
    compiledSchemaVersion: WORLD_PACK_COMPILED_SCHEMA_VERSION_V3,
    compiler: {
      id: WORLD_PACK_COMPILER_ID, version: WORLD_PACK_COMPILER_VERSION_V3,
      contractVersion: WORLD_PACK_COMPILER_CONTRACT_VERSION_V3,
      canonicalJsonVersion: 'world-json/v1', limitsProfile: WORLD_PACK_LIMITS_PROFILE_V2,
    },
    reaction: parseWorldPackReactionSource(reactionInput, `${file}#/reaction`),
  }
}

/** Validate one compiled v4 envelope while preserving the frozen v3 content and Reaction semantics. */
export function parseCompiledWorldPackV4(input: unknown, file = 'worldpack.json'): CompiledWorldPackV4 {
  const root = sourceDocument(input, file, MAX_COMPILED_BYTES)
  exactKeys(root, [
    'compiledSchemaVersion', 'packId', 'packVersion', 'packHash', 'compiler', 'pluginLocks', 'vocabularyLocks',
    'registryLocks', 'reaction', 'manifestation', 'content', 'assets', 'acceptanceAssertions',
  ], [], file, '')
  if (root.compiledSchemaVersion !== WORLD_PACK_COMPILED_SCHEMA_VERSION_V4) {
    failWorldPackContract('PACK_SOURCE_INVALID', file, '/compiledSchemaVersion', `must be ${WORLD_PACK_COMPILED_SCHEMA_VERSION_V4}`)
  }
  const compiler = objectAt(root.compiler, file, '/compiler')
  exactKeys(compiler, ['id', 'version', 'contractVersion', 'canonicalJsonVersion', 'limitsProfile'], [], file, '/compiler')
  if (compiler.id !== WORLD_PACK_COMPILER_ID || compiler.version !== WORLD_PACK_COMPILER_VERSION_V4
    || compiler.contractVersion !== WORLD_PACK_COMPILER_CONTRACT_VERSION_V4 || compiler.canonicalJsonVersion !== 'world-json/v1'
    || compiler.limitsProfile !== WORLD_PACK_LIMITS_PROFILE_V2) {
    failWorldPackContract('PACK_SOURCE_INVALID', file, '/compiler', 'does not identify the manifestation compiler contract')
  }
  const { manifestation: manifestationInput, ...withoutManifestation } = root
  const base = parseCompiledWorldPackV3({
    ...withoutManifestation,
    compiledSchemaVersion: WORLD_PACK_COMPILED_SCHEMA_VERSION_V3,
    compiler: {
      id: WORLD_PACK_COMPILER_ID, version: WORLD_PACK_COMPILER_VERSION_V3,
      contractVersion: WORLD_PACK_COMPILER_CONTRACT_VERSION_V3,
      canonicalJsonVersion: 'world-json/v1', limitsProfile: WORLD_PACK_LIMITS_PROFILE_V2,
    },
  }, file)
  return {
    ...base,
    compiledSchemaVersion: WORLD_PACK_COMPILED_SCHEMA_VERSION_V4,
    compiler: {
      id: WORLD_PACK_COMPILER_ID, version: WORLD_PACK_COMPILER_VERSION_V4,
      contractVersion: WORLD_PACK_COMPILER_CONTRACT_VERSION_V4,
      canonicalJsonVersion: 'world-json/v1', limitsProfile: WORLD_PACK_LIMITS_PROFILE_V2,
    },
    manifestation: parseWorldPackManifestationSource(manifestationInput, `${file}#/manifestation`),
  }
}

function referenceAt(value: unknown, file: string, at: string): { readonly id: string; readonly version: number } {
  const row = objectAt(value, file, at)
  exactKeys(row, ['id', 'version'], [], file, at)
  return {
    id: textAt(row.id, file, `${at}/id`),
    version: integerAt(row.version, file, `${at}/version`, 1, Number.MAX_SAFE_INTEGER),
  }
}

function dependenciesAt(value: unknown, file: string, at: string): readonly { readonly id: string; readonly version: number }[] {
  const refs = arrayAt(value, file, at).map((entry, index) => referenceAt(entry, file, `${at}/${index}`))
  unique(refs.map(ref => `${ref.id}@${ref.version}`), file, at)
  return refs
}

function implementationLockAt(value: unknown, file: string, at: string): InteractionImplementationLock {
  const row = objectAt(value, file, at)
  exactKeys(row, ['ref', 'implementationHash', 'dependencies'], [], file, at)
  return {
    ref: referenceAt(row.ref, file, `${at}/ref`),
    implementationHash: hashAt(row.implementationHash, file, `${at}/implementationHash`),
    dependencies: dependenciesAt(row.dependencies, file, `${at}/dependencies`),
  }
}

/** Strict re-parse of the compiled interaction catalog. Activation still re-verifies it. */
export function parseInteractionCatalogV3(input: unknown, file = 'worldpack.json'): InteractionCatalogV3 {
  const root = objectAt(input, file, '')
  exactKeys(root, ['version', 'packages', 'definitions', 'bindings'], [], file, '')
  if (root.version !== 'interaction-catalog/v3') {
    failWorldPackContract('PACK_SOURCE_INVALID', file, '/version', 'must equal interaction-catalog/v3')
  }
  const packages = arrayAt(root.packages, file, '/packages').map((entry, index) => implementationLockAt(entry, file, `/packages/${index}`))
  if (packages.length === 0) failWorldPackContract('PACK_SOURCE_INVALID', file, '/packages', 'must select at least one package')
  if (packages.length > MAX_INTERACTION_PACKAGES) {
    failWorldPackContract('PACK_LIMIT_EXCEEDED', file, '/packages', `must select at most ${MAX_INTERACTION_PACKAGES} packages`)
  }
  unique(packages.map(value => `${value.ref.id}@${value.ref.version}`), file, '/packages')
  const definitions = arrayAt(root.definitions, file, '/definitions').map((entry, index): InteractionCatalogV3['definitions'][number] => {
    const at = `/definitions/${index}`
    const row = objectAt(entry, file, at)
    exactKeys(row, ['ref', 'definitionHash', 'implementationHash'], [], file, at)
    return {
      ref: referenceAt(row.ref, file, `${at}/ref`),
      definitionHash: hashAt(row.definitionHash, file, `${at}/definitionHash`),
      implementationHash: hashAt(row.implementationHash, file, `${at}/implementationHash`),
    }
  })
  if (definitions.length > MAX_INTERACTION_DEFINITIONS) {
    failWorldPackContract('PACK_LIMIT_EXCEEDED', file, '/definitions', `must select at most ${MAX_INTERACTION_DEFINITIONS} definitions`)
  }
  unique(definitions.map(value => `${value.ref.id}@${value.ref.version}`), file, '/definitions')
  const bindings = arrayAt(root.bindings, file, '/bindings').map((entry, index): InteractionBindingV3 => {
    const at = `/bindings/${index}`
    const row = objectAt(entry, file, at)
    exactKeys(row, ['bindingId', 'targetRef', 'definitionRef', 'config'], [], file, at)
    const targetRef = objectAt(row.targetRef, file, `${at}/targetRef`)
    exactKeys(targetRef, ['kind', 'id'], [], file, `${at}/targetRef`)
    const kind = literalAt(targetRef.kind, ['character', 'entity', 'relation'] as const, file, `${at}/targetRef/kind`)
    const config = objectAt(row.config, file, `${at}/config`)
    canonicalizeWorldJson(config as WorldJsonValue)
    return {
      bindingId: textAt(row.bindingId, file, `${at}/bindingId`),
      targetRef: { kind, id: textAt(targetRef.id, file, `${at}/targetRef/id`) },
      definitionRef: referenceAt(row.definitionRef, file, `${at}/definitionRef`),
      config: config as WorldJsonObject,
    }
  })
  if (bindings.length > MAX_INTERACTION_BINDINGS) {
    failWorldPackContract('PACK_LIMIT_EXCEEDED', file, '/bindings', `must contain at most ${MAX_INTERACTION_BINDINGS} bindings`)
  }
  unique(bindings.map(value => value.bindingId), file, '/bindings')
  return { version: 'interaction-catalog/v3', packages, definitions, bindings }
}

/**
 * Compile the world's interaction catalog from its author selection and the Host's trusted package
 * descriptions. The author writes identities only; every lock and hash is resolved here, so a label
 * can never select a definition and a world cannot invent a trusted implementation.
 */
export function compileInteractionCatalog(
  selection: WorldPackInteractionsSource,
  entities: readonly WorldPackEntitySourceV2[],
  characters: readonly WorldPackCharacterSourceV3[],
  packages: readonly InteractionPackageDescription[],
  selectionFile = 'interactions.json',
): InteractionCatalogV3 {
  const installed = packages.map((entry, index): InteractionPackageDescription => {
    const at = `/${index}`
    const row = objectAt(entry, 'interaction-packages', at)
    exactKeys(row, ['lock', 'definitions'], [], 'interaction-packages', at)
    const lockRow = objectAt(row.lock, 'interaction-packages', `${at}/lock`)
    exactKeys(lockRow, ['ref', 'implementationHash', 'dependencies'], [], 'interaction-packages', `${at}/lock`)
    const definitions = arrayAt(row.definitions, 'interaction-packages', `${at}/definitions`).map((item, offset): InteractionDefinitionImplementation => {
      const slot = `${at}/definitions/${offset}`
      const definition = objectAt(item, 'interaction-packages', slot)
      exactKeys(definition, ['spec', 'implementationHash'], [], 'interaction-packages', slot)
      const spec = definition.spec as InteractionDefinitionSpec
      if (spec === null || typeof spec !== 'object' || typeof spec.id !== 'string' || !Number.isSafeInteger(spec.version)) {
        failWorldPackContract('PACK_SOURCE_INVALID', 'interaction-packages', `${slot}/spec`, 'must name a definition identity')
      }
      return {
        spec,
        implementationHash: hashAt(definition.implementationHash, 'interaction-packages', `${slot}/implementationHash`),
      }
    })
    return { lock: implementationLockAt(lockRow, 'interaction-packages', `${at}/lock`), definitions }
  })
  unique(installed.map(entry => `${entry.lock.ref.id}@${entry.lock.ref.version}`), 'interaction-packages', '')
  const provided = new Map<string, { description: InteractionPackageDescription; definition: InteractionDefinitionImplementation }>()
  for (const description of installed) {
    for (const definition of description.definitions) {
      const identity = `${definition.spec.id}@${definition.spec.version}`
      if (provided.has(identity)) failWorldPackContract('PACK_DUPLICATE_ID', 'interaction-packages', '', `duplicate installed definition ${identity}`)
      provided.set(identity, { description, definition })
    }
  }
  const selectedPackages = selection.packages.map(pkg => {
    const identity = `${pkg.id}@${pkg.version}`
    const found = installed.find(entry => `${entry.lock.ref.id}@${entry.lock.ref.version}` === identity)
    if (found === undefined) failWorldPackContract('PLUGIN_NOT_REGISTERED', selectionFile, '/packages', `package ${identity} is not installed by the Host`)
    return found.lock
  })
  const enabled = new Set(selectedPackages.map(lock => `${lock.ref.id}@${lock.ref.version}`))
  const definitions = selection.definitions.map(ref => {
    const identity = `${ref.id}@${ref.version}`
    const found = provided.get(identity)
    if (found === undefined) failWorldPackContract('PACK_REFERENCE_INVALID', selectionFile, '/definitions', `definition ${identity} is not provided by an installed package`)
    if (!enabled.has(`${found.description.lock.ref.id}@${found.description.lock.ref.version}`)) {
      failWorldPackContract('PACK_REFERENCE_INVALID', selectionFile, '/definitions', `definition ${identity} belongs to a package the world did not select`)
    }
    const targetKind = found.definition.spec.participantRoles.find(role => role.source.kind === 'primaryTarget')?.kind
    return {
      ref, definitionHash: hashWorldJson('interaction-definition/v1', found.definition.spec),
      implementationHash: found.definition.implementationHash, targetKind,
    }
  })
  const declared = new Map(definitions.map(entry => [`${entry.ref.id}@${entry.ref.version}`, entry]))
  const bindings: InteractionBindingV3[] = []
  const bind = (targetRef: InteractionTargetRef, source: WorldPackInteractionBindingSource, at: string): void => {
    const identity = `${source.definition.id}@${source.definition.version}`
    const definition = declared.get(identity)
    if (definition === undefined) {
      failWorldPackContract('PACK_REFERENCE_INVALID', selectionFile, at, `binding references definition ${identity}, which this world did not enable`)
    }
    if (definition.targetKind !== undefined && definition.targetKind !== targetRef.kind) {
      failWorldPackContract('PACK_REFERENCE_INVALID', selectionFile, at, `binding target kind ${targetRef.kind} does not match the definition`)
    }
    bindings.push({
      bindingId: source.bindingId,
      targetRef,
      definitionRef: { id: source.definition.id, version: source.definition.version },
      config: bindingConfig(provided.get(identity)!.definition.spec, source.config, selectionFile, at),
    })
  }
  for (const target of entities) for (const source of target.interactionBindings ?? []) {
    bind({ kind: 'entity', id: target.entityId }, source, `/entities/${target.entityId}/${source.bindingId}`)
  }
  for (const target of characters) for (const source of target.interactionBindings ?? []) {
    bind({ kind: 'character', id: target.characterId }, source, `/characters/${target.characterId}/${source.bindingId}`)
  }
  if (bindings.length > MAX_INTERACTION_BINDINGS) {
    failWorldPackContract('PACK_LIMIT_EXCEEDED', selectionFile, '/bindings', `must declare at most ${MAX_INTERACTION_BINDINGS} bindings`)
  }
  unique(bindings.map(binding => binding.bindingId), selectionFile, '/bindings')
  const ordered = [...bindings].sort((left, right) => compareWorldText(left.bindingId, right.bindingId))
  return {
    version: 'interaction-catalog/v3',
    packages: [...selectedPackages].sort((left, right) => compareWorldText(`${left.ref.id}@${left.ref.version}`, `${right.ref.id}@${right.ref.version}`)),
    definitions: definitions.map(({ targetKind: _targetKind, ...entry }) => entry),
    bindings: ordered,
  }
}

/** The config is the author's only lever, and it can only narrow what the definition already allows. */
function bindingConfig(
  spec: InteractionDefinitionSpec,
  value: WorldJsonObject,
  file: string,
  at: string,
): WorldJsonObject {
  const row = objectAt(value, file, `${at}/config`)
  exactKeys(row, spec.bindingConfigSchema.fields.map(field => field.name), [], file, `${at}/config`)
  canonicalizeWorldJson(row as WorldJsonValue)
  for (const field of spec.bindingConfigSchema.fields) {
    const item = row[field.name]
    if (field.type === 'boolean') {
      if (typeof item !== 'boolean') failWorldPackContract('PACK_SOURCE_INVALID', file, `${at}/config/${field.name}`, 'must be a boolean')
      continue
    }
    if (field.type === 'integer') {
      integerAt(item, file, `${at}/config/${field.name}`, field.minimum, field.maximum)
      continue
    }
    if (typeof item !== 'string' || Buffer.byteLength(item, 'utf8') > field.maxBytes
      || (field.values.length > 0 && !field.values.includes(item))) {
      failWorldPackContract('PACK_SOURCE_INVALID', file, `${at}/config/${field.name}`, 'must be a string inside the declared domain')
    }
  }
  return row as WorldJsonObject
}

/** V5 adds the world's interaction catalog; the V4 envelope and its content validation are untouched. */
export function parseCompiledWorldPackV5(input: unknown, file = 'worldpack.json'): CompiledWorldPackV5 {
  const root = sourceDocument(input, file, MAX_COMPILED_BYTES)
  if (root.compiledSchemaVersion !== WORLD_PACK_COMPILED_SCHEMA_VERSION_V5) {
    failWorldPackContract('PACK_SOURCE_INVALID', file, '/compiledSchemaVersion', `must be ${WORLD_PACK_COMPILED_SCHEMA_VERSION_V5}`)
  }
  const interactions = parseInteractionCatalogV3(root.interactions, `${file}#/interactions`)
  const { interactions: _interactions, content, ...withoutInteractions } = root
  const envelope = objectAt(content, file, '/content')
  // The V4 parser re-parses content with the V1/V2 file shapes, which cannot carry bindings. Hand it
  // the binding-free projection and substitute the full V5 content afterwards; the target files are
  // then re-parsed under their V2/V3 shapes below, so nothing is validated only once.
  const stripped = {
    ...envelope,
    entities: arrayAt(envelope.entities, file, '/content/entities').map(entry => {
      const { interactionBindings: _entityBindings, ...rest } = objectAt(entry, file, '/content/entities')
      return rest
    }),
    characters: arrayAt(envelope.characters, file, '/content/characters').map(entry => {
      const { interactionBindings: _characterBindings, ...rest } = objectAt(entry, file, '/content/characters')
      return rest
    }),
  }
  const base = parseCompiledWorldPackV4({
    ...withoutInteractions,
    compiledSchemaVersion: WORLD_PACK_COMPILED_SCHEMA_VERSION_V4,
    content: stripped,
    compiler: {
      id: WORLD_PACK_COMPILER_ID, version: WORLD_PACK_COMPILER_VERSION_V4,
      contractVersion: WORLD_PACK_COMPILER_CONTRACT_VERSION_V4,
      canonicalJsonVersion: 'world-json/v1', limitsProfile: WORLD_PACK_LIMITS_PROFILE_V2,
    },
  }, file)
  return {
    ...base,
    compiledSchemaVersion: WORLD_PACK_COMPILED_SCHEMA_VERSION_V5,
    compiler: {
      id: WORLD_PACK_COMPILER_ID, version: WORLD_PACK_COMPILER_VERSION_V5,
      contractVersion: WORLD_PACK_COMPILER_CONTRACT_VERSION_V5,
      canonicalJsonVersion: 'world-json/v1', limitsProfile: WORLD_PACK_LIMITS_PROFILE_V2,
    },
    interactions,
    content: {
      ...base.content,
      entities: parseWorldPackEntitiesSourceV2(
        { schemaVersion: WORLD_PACK_ENTITIES_SCHEMA_VERSION_V2, entities: envelope.entities }, `${file}#/content/entities`,
      ).entities,
      characters: parseWorldPackCharactersSourceV3(
        { schemaVersion: WORLD_PACK_CHARACTERS_SCHEMA_VERSION_V3, characters: envelope.characters }, `${file}#/content/characters`,
      ).characters,
    },
  }
}

/** Convert a contract diagnostic into the stable world error code used by compiler and CLI boundaries. */export function worldPackErrorCode(code: WorldPackDiagnosticCode): 'PACK_SOURCE_INVALID' | 'PACK_REFERENCE_INVALID' | 'PACK_VERSION_DIVERGED' | 'PLUGIN_NOT_REGISTERED' | 'REGISTRY_HASH_MISMATCH' {
  if (code === 'PACK_REFERENCE_INVALID' || code === 'PACK_VERSION_DIVERGED'
    || code === 'PLUGIN_NOT_REGISTERED' || code === 'REGISTRY_HASH_MISMATCH') return code
  return 'PACK_SOURCE_INVALID'
}
