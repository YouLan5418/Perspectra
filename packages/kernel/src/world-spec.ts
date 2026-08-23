import {
  brandId,
  canonicalizeWorldJson,
  hashWorldJson,
  type CharacterId,
  type SessionId,
  type WorldAddress,
  type WorldEventDraft,
  type WorldHash,
  type WorldJsonObject,
  type WorldJsonValue,
} from '@harness-world/contracts'

export interface LocationSpec extends WorldJsonObject { readonly locationId: string; readonly name: string }
export interface EntitySpec extends WorldJsonObject { readonly entityId: string; readonly locationId: string; readonly kind: string }
export interface CharacterSpec extends WorldJsonObject { readonly characterId: CharacterId; readonly name: string; readonly locationId: string }
export interface PlayerBindingSpec extends WorldJsonObject { readonly principalId: string; readonly characterId: CharacterId; readonly sessionId: SessionId }
export interface PluginSpec extends WorldJsonObject { readonly pluginId: string; readonly version: string }
export interface SceneSpec extends WorldJsonObject { readonly sceneId: string; readonly participantIds: readonly CharacterId[] }
export interface GoalSpec extends WorldJsonObject { readonly goalId: string; readonly characterId: CharacterId; readonly value: WorldJsonValue }
export interface ClaimSpec extends WorldJsonObject { readonly claimId: string; readonly characterId: CharacterId; readonly value: WorldJsonValue }
export interface ObservationSpec extends WorldJsonObject { readonly observationId: string; readonly observerId: CharacterId; readonly value: WorldJsonValue }
export interface WorldMetadata extends WorldJsonObject { readonly title: string; readonly description: string }
export interface RuntimePolicy extends WorldJsonObject {
  readonly npcInitialAvailability: 'provisioning' | 'ready'
  readonly playerInitialAvailability: 'ready'
}
export interface RegistryDefinition extends WorldJsonObject { readonly name: string; readonly version: number; readonly schemaHash: WorldHash }
export interface FrozenRegistry extends WorldJsonObject { readonly definitions: readonly RegistryDefinition[]; readonly registryHash: WorldHash }
export interface ManifestRegistries extends WorldJsonObject {
  readonly events: FrozenRegistry
  readonly actions: FrozenRegistry
  readonly projections: FrozenRegistry
  readonly rules: FrozenRegistry
}

export interface CompiledWorldManifest extends WorldJsonObject {
  readonly schemaVersion: 2
  readonly address: WorldAddress
  readonly specHash: WorldHash
  readonly genesisPlanHash: WorldHash
  readonly canonicalVersion: 'world-json/v1'
  readonly hashVersion: 'sha256/v1'
  readonly metadata: WorldMetadata
  readonly timeMode: 'TURN_DRIVEN'
  readonly roundQueueLimit: number
  readonly runtimePolicy: RuntimePolicy
  readonly rulebook: { readonly rulebookId: 'builtin:speak-move'; readonly version: 1 | 2 | 3 | 4 }
  readonly registries: ManifestRegistries
  readonly locations: readonly LocationSpec[]
  readonly entities: readonly EntitySpec[]
  readonly characters: readonly CharacterSpec[]
  readonly scenes: readonly SceneSpec[]
  readonly goals: readonly GoalSpec[]
  readonly claims: readonly ClaimSpec[]
  readonly observations: readonly ObservationSpec[]
  readonly playerBindings: readonly PlayerBindingSpec[]
  readonly plugins: readonly PluginSpec[]
}

export interface CompiledWorldSpec {
  readonly manifest: CompiledWorldManifest
  readonly manifestHash: WorldHash
  readonly genesisEvents: readonly WorldEventDraft[]
  readonly genesisHash: WorldHash
}

/**
 * Build an execution-only V2 view over an immutable stored Manifest.
 * Stored V1 bytes and their manifestHash remain authoritative and are never rewritten.
 */
export function runtimeManifestFromStored(value: WorldJsonValue): CompiledWorldManifest {
  canonicalizeWorldJson(value)
  const root = objectAt(value, 'StoredWorldManifest')
  if (root.schemaVersion === 1) return new WorldSpecCompiler().compile(value).manifest
  if (root.schemaVersion !== 2) throw new TypeError('stored Manifest schemaVersion is unsupported')
  const runtimePolicy = objectAt(root.runtimePolicy, 'StoredWorldManifest.runtimePolicy')
  exactKeys(runtimePolicy, ['npcInitialAvailability', 'playerInitialAvailability'], 'StoredWorldManifest.runtimePolicy')
  if (runtimePolicy.npcInitialAvailability !== 'provisioning' && runtimePolicy.npcInitialAvailability !== 'ready') {
    throw new TypeError('stored Manifest npcInitialAvailability is invalid')
  }
  if (runtimePolicy.playerInitialAvailability !== 'ready') throw new TypeError('stored Manifest playerInitialAvailability is invalid')
  arrayAt(root.locations, 'StoredWorldManifest.locations')
  arrayAt(root.characters, 'StoredWorldManifest.characters')
  arrayAt(root.playerBindings, 'StoredWorldManifest.playerBindings')
  return value as CompiledWorldManifest
}

export function runtimeManifestFromStoredRecord(
  record: { readonly manifest: WorldJsonValue } | undefined,
): CompiledWorldManifest {
  if (record === undefined) throw new Error('branch runtime has no stored Manifest')
  return runtimeManifestFromStored(record.manifest)
}

function objectAt(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError(`${path} must be an object`)
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], path: string): void {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new TypeError(`${path} contains missing or unknown fields`)
}

function textAt(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) throw new TypeError(`${path} must be a non-empty, unpadded string`)
  return value
}

function stringAt(value: unknown, path: string): string {
  if (typeof value !== 'string') throw new TypeError(`${path} must be a string`)
  return value
}

function arrayAt(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${path} must be an array`)
  return value
}

function unique(values: readonly string[], path: string): void {
  if (new Set(values).size !== values.length) throw new TypeError(`${path} contains duplicate identifiers`)
}

function definition(name: string): RegistryDefinition {
  return { name, version: 1, schemaHash: hashWorldJson('registry-definition-schema', { name, version: 1 }) }
}

function registry(kind: string, names: readonly string[]): FrozenRegistry {
  const definitions = [...names].sort().map(name => definition(name))
  return { definitions, registryHash: hashWorldJson(`compiled-${kind}-registry`, definitions) }
}

function registries(rulebookVersion: 1 | 2 | 3 | 4): ManifestRegistries {
  const entityEvents = rulebookVersion >= 2 ? ['entity.taken'] : []
  const entityActions = rulebookVersion >= 2 ? ['take'] : []
  const investigationEvents = rulebookVersion >= 3
    ? ['character.asked', 'entity.inspected', 'evidence.presented', 'investigation.accusation-resolved', 'investigation.case-closed']
    : []
  const authorEvents = rulebookVersion >= 4 ? ['investigation.culprit-seeded'] : []
  const investigationActions = rulebookVersion >= 3 ? ['accuse', 'ask', 'inspect', 'present_evidence'] : []
  return {
    events: registry('event', [
      'action.rejected', 'action.resolved', 'character.created', 'character.lifecycle-changed', 'character.moved',
      'character.speak', 'claim.remove', 'claim.upsert', 'entity.upsert', 'goal.remove', 'goal.upsert', 'location.upsert',
      'observation.remove', 'observation.upsert', 'player.binding.upsert', 'round.participant-terminal', 'scene.remove',
      'scene.upsert', 'visibility.remove', 'visibility.upsert', 'world.created',
      'world.lifecycle-changed', 'world.manifest-locked', 'world.tick-advanced', ...entityEvents, ...investigationEvents,
      ...authorEvents,
    ]),
    actions: registry('action', ['move', 'speak', ...entityActions, ...investigationActions]),
    projections: registry('projection', ['character', 'claim', 'goal', 'observation', 'scene', 'visibility']),
    rules: registry('rule', [rulebookVersion === 1 ? 'builtin:speak-move' : `builtin:speak-move/v${rulebookVersion}`]),
  }
}

/** Pure compatibility upcast. It never mutates or re-hashes an already stored event. */
export function upcastWorldSpecV1(input: Record<string, unknown>): Record<string, unknown> {
  exactKeys(input, ['schemaVersion', 'address', 'timeMode', 'roundQueueLimit', 'rulebook', 'locations', 'characters', 'playerBindings', 'plugins'], 'WorldSpecV1')
  const address = objectAt(input.address, 'WorldSpecV1.address')
  return {
    ...input,
    schemaVersion: 2,
    metadata: { title: textAt(address.worldId, 'worldId'), description: '' },
    runtimePolicy: { npcInitialAvailability: 'ready', playerInitialAvailability: 'ready' },
    entities: [], scenes: [], goals: [], claims: [], observations: [],
  }
}

function normalizedInput(input: unknown): Record<string, unknown> {
  canonicalizeWorldJson(input as WorldJsonValue)
  const root = objectAt(input, 'WorldSpec')
  return root.schemaVersion === 1 ? upcastWorldSpecV1(root) : root
}

function parseSeeds<T>(
  root: Record<string, unknown>, field: string, idKey: string, ownerKey: string, characterIds: Set<CharacterId>,
  make: (id: string, owner: CharacterId, value: WorldJsonValue) => T,
): T[] {
  return arrayAt(root[field], `WorldSpec.${field}`).map((entry, index) => {
    const value = objectAt(entry, `${field}[${index}]`)
    exactKeys(value, [idKey, ownerKey, 'value'], `${field}[${index}]`)
    const owner = brandId(textAt(value[ownerKey], `${field}.${ownerKey}`), 'CharacterId')
    if (!characterIds.has(owner)) throw new TypeError(`${field} references unknown character ${owner}`)
    return make(textAt(value[idKey], `${field}.${idKey}`), owner, value.value as WorldJsonValue)
  })
}

/** Strict compiler from declarative WorldSpec V1/V2 into one hash-stable V2 execution contract. */
export class WorldSpecCompiler {
  compile(input: unknown): CompiledWorldSpec {
    const root = normalizedInput(input)
    exactKeys(root, [
      'schemaVersion', 'address', 'metadata', 'timeMode', 'roundQueueLimit', 'runtimePolicy', 'rulebook', 'locations',
      'entities', 'characters', 'scenes', 'goals', 'claims', 'observations', 'playerBindings', 'plugins',
    ], 'WorldSpec')
    if (root.schemaVersion !== 2) throw new TypeError('WorldSpec.schemaVersion must be 1 or 2')
    if (root.timeMode !== 'TURN_DRIVEN') throw new TypeError('WorldSpec.timeMode must be TURN_DRIVEN in V0')
    if (!Number.isSafeInteger(root.roundQueueLimit) || (root.roundQueueLimit as number) <= 0) throw new TypeError('WorldSpec.roundQueueLimit must be a positive safe integer')

    const av = objectAt(root.address, 'WorldSpec.address')
    exactKeys(av, ['tenantId', 'worldId', 'branchId'], 'WorldSpec.address')
    const address: WorldAddress = {
      tenantId: brandId(textAt(av.tenantId, 'tenantId'), 'TenantId'),
      worldId: brandId(textAt(av.worldId, 'worldId'), 'WorldId'),
      branchId: brandId(textAt(av.branchId, 'branchId'), 'BranchId'),
    }
    const mv = objectAt(root.metadata, 'WorldSpec.metadata')
    exactKeys(mv, ['title', 'description'], 'WorldSpec.metadata')
    const metadata: WorldMetadata = { title: textAt(mv.title, 'metadata.title'), description: stringAt(mv.description, 'metadata.description') }
    const rv = objectAt(root.runtimePolicy, 'WorldSpec.runtimePolicy')
    exactKeys(rv, ['npcInitialAvailability', 'playerInitialAvailability'], 'WorldSpec.runtimePolicy')
    if (rv.npcInitialAvailability !== 'provisioning' && rv.npcInitialAvailability !== 'ready') throw new TypeError('runtimePolicy.npcInitialAvailability is invalid')
    if (rv.playerInitialAvailability !== 'ready') throw new TypeError('runtimePolicy.playerInitialAvailability must be ready')
    const runtimePolicy: RuntimePolicy = { npcInitialAvailability: rv.npcInitialAvailability, playerInitialAvailability: 'ready' }

    const rulebookValue = objectAt(root.rulebook, 'WorldSpec.rulebook')
    exactKeys(rulebookValue, ['rulebookId', 'version'], 'WorldSpec.rulebook')
    if (rulebookValue.rulebookId !== 'builtin:speak-move'
      || (rulebookValue.version !== 1 && rulebookValue.version !== 2
        && rulebookValue.version !== 3 && rulebookValue.version !== 4)) {
      throw new TypeError('WorldSpec.rulebook must select builtin:speak-move version 1, 2, 3, or 4')
    }
    const rulebookVersion = rulebookValue.version as 1 | 2 | 3 | 4

    const locations = arrayAt(root.locations, 'WorldSpec.locations').map((entry, index): LocationSpec => {
      const value = objectAt(entry, `locations[${index}]`); exactKeys(value, ['locationId', 'name'], `locations[${index}]`)
      return { locationId: textAt(value.locationId, 'locationId'), name: textAt(value.name, 'location.name') }
    }).sort((a, b) => a.locationId.localeCompare(b.locationId))
    if (locations.length === 0) throw new TypeError('WorldSpec.locations cannot be empty')
    unique(locations.map(value => value.locationId), 'WorldSpec.locations')
    const locationIds = new Set(locations.map(value => value.locationId))

    const entities = arrayAt(root.entities, 'WorldSpec.entities').map((entry, index): EntitySpec => {
      const value = objectAt(entry, `entities[${index}]`); exactKeys(value, ['entityId', 'locationId', 'kind'], `entities[${index}]`)
      const locationId = textAt(value.locationId, 'entity.locationId')
      if (!locationIds.has(locationId)) throw new TypeError(`entity references unknown location ${locationId}`)
      return { entityId: textAt(value.entityId, 'entityId'), locationId, kind: textAt(value.kind, 'entity.kind') }
    }).sort((a, b) => a.entityId.localeCompare(b.entityId))
    unique(entities.map(value => value.entityId), 'WorldSpec.entities')

    const characters = arrayAt(root.characters, 'WorldSpec.characters').map((entry, index): CharacterSpec => {
      const value = objectAt(entry, `characters[${index}]`); exactKeys(value, ['characterId', 'name', 'locationId'], `characters[${index}]`)
      const locationId = textAt(value.locationId, 'character.locationId')
      if (!locationIds.has(locationId)) throw new TypeError(`character references unknown location ${locationId}`)
      return { characterId: brandId(textAt(value.characterId, 'characterId'), 'CharacterId'), name: textAt(value.name, 'character.name'), locationId }
    }).sort((a, b) => a.characterId.localeCompare(b.characterId))
    if (characters.length === 0) throw new TypeError('WorldSpec.characters cannot be empty')
    unique(characters.map(value => value.characterId), 'WorldSpec.characters')
    const characterIds = new Set(characters.map(value => value.characterId))

    const goals = parseSeeds(root, 'goals', 'goalId', 'characterId', characterIds, (goalId, characterId, value): GoalSpec => ({ goalId, characterId, value })).sort((a, b) => a.goalId.localeCompare(b.goalId)); unique(goals.map(v => v.goalId), 'WorldSpec.goals')
    const claims = parseSeeds(root, 'claims', 'claimId', 'characterId', characterIds, (claimId, characterId, value): ClaimSpec => ({ claimId, characterId, value })).sort((a, b) => a.claimId.localeCompare(b.claimId)); unique(claims.map(v => v.claimId), 'WorldSpec.claims')
    const observations = parseSeeds(root, 'observations', 'observationId', 'observerId', characterIds, (observationId, observerId, value): ObservationSpec => ({ observationId, observerId, value })).sort((a, b) => a.observationId.localeCompare(b.observationId)); unique(observations.map(v => v.observationId), 'WorldSpec.observations')

    const scenes = arrayAt(root.scenes, 'WorldSpec.scenes').map((entry, index): SceneSpec => {
      const value = objectAt(entry, `scenes[${index}]`); exactKeys(value, ['sceneId', 'participantIds'], `scenes[${index}]`)
      const participantIds = arrayAt(value.participantIds, 'scene.participantIds').map(id => brandId(textAt(id, 'scene.participantId'), 'CharacterId')).sort()
      unique(participantIds, 'scene.participantIds')
      if (participantIds.some(id => !characterIds.has(id))) throw new TypeError('scene references unknown character')
      return { sceneId: textAt(value.sceneId, 'sceneId'), participantIds }
    }).sort((a, b) => a.sceneId.localeCompare(b.sceneId)); unique(scenes.map(v => v.sceneId), 'WorldSpec.scenes')

    const playerBindings = arrayAt(root.playerBindings, 'WorldSpec.playerBindings').map((entry, index): PlayerBindingSpec => {
      const value = objectAt(entry, `playerBindings[${index}]`); exactKeys(value, ['principalId', 'characterId', 'sessionId'], `playerBindings[${index}]`)
      const characterId = brandId(textAt(value.characterId, 'binding.characterId'), 'CharacterId')
      if (!characterIds.has(characterId)) throw new TypeError(`binding references unknown character ${characterId}`)
      return { principalId: textAt(value.principalId, 'principalId'), characterId, sessionId: brandId(textAt(value.sessionId, 'sessionId'), 'SessionId') }
    }).sort((a, b) => a.principalId.localeCompare(b.principalId))
    if (playerBindings.length === 0) throw new TypeError('WorldSpec.playerBindings cannot be empty')
    unique(playerBindings.map(v => v.principalId), 'WorldSpec.playerBindings principals'); unique(playerBindings.map(v => v.characterId), 'WorldSpec.playerBindings characters')

    const plugins = arrayAt(root.plugins, 'WorldSpec.plugins').map((entry, index): PluginSpec => {
      const value = objectAt(entry, `plugins[${index}]`); exactKeys(value, ['pluginId', 'version'], `plugins[${index}]`)
      const version = textAt(value.version, 'plugin.version')
      if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new TypeError('plugin.version must be exact semver')
      return { pluginId: textAt(value.pluginId, 'pluginId'), version }
    }).sort((a, b) => a.pluginId.localeCompare(b.pluginId)); unique(plugins.map(v => v.pluginId), 'WorldSpec.plugins')

    const normalizedSpec = { schemaVersion: 2 as const, address, metadata, timeMode: 'TURN_DRIVEN' as const, roundQueueLimit: root.roundQueueLimit as number, runtimePolicy, rulebook: { rulebookId: 'builtin:speak-move' as const, version: rulebookVersion }, locations, entities, characters, scenes, goals, claims, observations, playerBindings, plugins }
    const specHash = hashWorldJson('world-spec-v2', normalizedSpec)
    const genesisPlanHash = hashWorldJson('world-genesis-semantic-plan-v1', { address, locations, entities, characters, scenes, goals, claims, observations, playerBindings, lifecycle: 'active' })
    const manifest: CompiledWorldManifest = { ...normalizedSpec, specHash, genesisPlanHash, canonicalVersion: 'world-json/v1', hashVersion: 'sha256/v1', registries: registries(rulebookVersion) }
    const manifestHash = hashWorldJson('compiled-world-manifest', manifest)
    const genesisEvents: readonly WorldEventDraft[] = [
      { eventType: 'world.created', eventVersion: 1, data: { specHash } },
      { eventType: 'world.manifest-locked', eventVersion: 1, data: { manifestHash, genesisPlanHash } },
      ...locations.map(value => ({ eventType: 'location.upsert', eventVersion: 1, data: value })),
      ...entities.map(value => ({ eventType: 'entity.upsert', eventVersion: 1, data: value })),
      ...characters.map(value => ({ eventType: 'character.created', eventVersion: 1, data: { ...value, lifecycleState: 'active' } })),
      ...scenes.map(value => ({ eventType: 'scene.upsert', eventVersion: 1, data: { sceneId: value.sceneId, value: { participantIds: value.participantIds } } })),
      ...goals.map(value => ({ eventType: 'goal.upsert', eventVersion: 1, data: { id: value.goalId, value: { characterId: value.characterId, seed: value.value } } })),
      ...claims.map(value => ({ eventType: 'claim.upsert', eventVersion: 1, data: { id: value.claimId, value: { characterId: value.characterId, seed: value.value } } })),
      ...(rulebookVersion >= 4 ? claims.flatMap(value => {
        const seed = typeof value.value === 'object' && value.value !== null && !Array.isArray(value.value)
          ? value.value as Record<string, unknown>
          : undefined
        const proposition = typeof seed?.proposition === 'object' && seed.proposition !== null && !Array.isArray(seed.proposition)
          ? seed.proposition as Record<string, unknown>
          : undefined
        return seed?.source === 'author-secret' && proposition?.subject === value.characterId
          && proposition.predicate === 'is_culprit' && proposition.object === true
          ? [{
            eventType: 'investigation.culprit-seeded', eventVersion: 1,
            data: { culpritId: value.characterId, sourceClaimId: value.claimId },
          }]
          : []
      }) : []),
      ...observations.map(value => ({ eventType: 'observation.upsert', eventVersion: 1, data: { id: value.observationId, value: { observerId: value.observerId, seed: value.value } } })),
      ...playerBindings.map(value => ({ eventType: 'player.binding.upsert', eventVersion: 1, data: value })),
      { eventType: 'world.lifecycle-changed', eventVersion: 1, data: { lifecycleState: 'active' } },
    ]
    return { manifest, manifestHash, genesisEvents, genesisHash: hashWorldJson('world-genesis-plan', genesisEvents) }
  }
}
