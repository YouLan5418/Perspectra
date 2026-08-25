import {
  assertProtocolString,
  brandId,
  canonicalizeWorldJson,
  type BrandedId,
  type WorldHash,
  type WorldJsonValue,
} from '@harness-world/contracts'
import {
  PHASE7_CORE_PROFILES,
  WORLD_PACK_COMPILED_SCHEMA_VERSION,
  WORLD_PACK_COMPILER_CONTRACT_VERSION,
  WORLD_PACK_COMPILER_ID,
  WORLD_PACK_COMPILER_VERSION,
  WORLD_PACK_LIMITS_PROFILE,
  WORLD_PACK_SOURCE_SCHEMA_VERSION,
  type CompiledWorldPack,
  type WorldPackAcceptanceAssertion,
  type WorldPackAssertionsSource,
  type WorldPackAssetLock,
  type WorldPackCharacterSource,
  type WorldPackCharactersSource,
  type WorldPackCompiledContent,
  type WorldPackCoreProfiles,
  type WorldPackId,
  type WorldPackInitialClaimSource,
  type WorldPackInitialFactSource,
  type WorldPackInitialGoalSource,
  type WorldPackInitialObservationSource,
  type WorldPackLocationSource,
  type WorldPackLocationsSource,
  type WorldPackMarkdownContent,
  type WorldPackPlayerSlotSource,
  type WorldPackPlayerSlotsSource,
  type WorldPackPluginLock,
  type WorldPackPresentationSource,
  type WorldPackSceneSource,
  type WorldPackScenesSource,
  type WorldPackSlotId,
  type WorldPackSourceManifest,
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

function idAt<Name extends string>(value: unknown, file: string, at: string, name: Name): BrandedId<Name> {
  return brandId(textAt(value, file, at), name)
}

function integerAt(value: unknown, file: string, at: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    failWorldPackContract('PACK_SOURCE_INVALID', file, at, `must be a safe integer from ${minimum} through ${maximum}`)
  }
  return value as number
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

function profileAt(value: unknown, file: string, at: string): WorldPackCoreProfiles {
  if (value === undefined) return copyCoreProfiles()
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
  const normalized: WorldPackCoreProfiles = {
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
  if (JSON.stringify(normalized) !== JSON.stringify(PHASE7_CORE_PROFILES)) {
    failWorldPackContract('PACK_PROFILE_NOT_ALLOWED', file, at, 'must select the exact Phase 7 Core profiles')
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
    'characterFiles', 'locationFiles', 'sceneFiles', 'playerSlotFiles', 'presentationFiles',
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
    sceneFiles: lists.sceneFiles,
    playerSlotFiles: lists.playerSlotFiles,
    presentationFiles: lists.presentationFiles,
    markdownFiles: lists.markdownFiles,
    assetFiles: lists.assetFiles,
    assertionFiles: lists.assertionFiles,
  }
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

function pluginLocksAt(value: unknown, file: string, at: string): WorldPackPluginLock[] {
  const allowed = new Map<string, readonly [string, string]>([
    ['rulebook', ['builtin:speak-move', '2']],
    ['scene-decision', ['builtin:scene-decision', '1.0.0']],
    ['agent-context', ['builtin:agent-context', '2.0.0']],
    ['presentation', ['builtin:deterministic-presentation', '1.0.0']],
  ])
  const locks = arrayAt(value, file, at).map((entry, index): WorldPackPluginLock => {
    const itemAt = `${at}/${index}`; const item = objectAt(entry, file, itemAt); exactKeys(item, ['kind', 'id', 'version'], [], file, itemAt)
    const kind = textAt(item.kind, file, `${itemAt}/kind`)
    const expected = allowed.get(kind)
    if (expected === undefined || item.id !== expected[0] || String(item.version) !== expected[1]) {
      failWorldPackContract('PACK_PROFILE_NOT_ALLOWED', file, itemAt, 'is not an exact Phase 7 plugin lock')
    }
    return { kind: kind as WorldPackPluginLock['kind'], id: textAt(item.id, file, `${itemAt}/id`), version: textAt(item.version, file, `${itemAt}/version`) }
  })
  unique(locks.map(lock => lock.kind), file, at)
  if (locks.length !== allowed.size) failWorldPackContract('PACK_PROFILE_NOT_ALLOWED', file, at, 'must lock every Phase 7 Core profile')
  return locks
}

function markdownAt(value: unknown, file: string, at: string): WorldPackMarkdownContent {
  const item = objectAt(value, file, at); exactKeys(item, ['path', 'text', 'contentHash'], [], file, at)
  const text = stringAt(item.text, file, `${at}/text`)
  if (new TextEncoder().encode(text).byteLength > MAX_MARKDOWN_BYTES) {
    failWorldPackContract('PACK_LIMIT_EXCEEDED', file, `${at}/text`, `exceeds the ${MAX_MARKDOWN_BYTES}-byte Markdown limit`)
  }
  return { path: textAt(item.path, file, `${at}/path`), text, contentHash: hashAt(item.contentHash, file, `${at}/contentHash`) }
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
  const content = objectAt(root.content, file, '/content'); exactKeys(content, ['world', 'locations', 'characters', 'scenes', 'playerSlots', 'presentation', 'markdown'], [], file, '/content')
  const parsedContent: WorldPackCompiledContent = {
    world: parseWorldPackWorldSource(content.world, `${file}#/content/world`),
    locations: parseWorldPackLocationsSource({ schemaVersion: 'worldpack-locations/v1', locations: content.locations }, `${file}#/content/locations`).locations,
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

/** Convert a contract diagnostic into the stable world error code used by compiler and CLI boundaries. */
export function worldPackErrorCode(code: WorldPackDiagnosticCode): 'PACK_SOURCE_INVALID' | 'PACK_REFERENCE_INVALID' {
  return code === 'PACK_REFERENCE_INVALID' ? 'PACK_REFERENCE_INVALID' : 'PACK_SOURCE_INVALID'
}
