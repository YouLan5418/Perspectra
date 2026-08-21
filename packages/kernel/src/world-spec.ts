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

export interface LocationSpec extends WorldJsonObject {
  readonly locationId: string
  readonly name: string
}

export interface CharacterSpec extends WorldJsonObject {
  readonly characterId: CharacterId
  readonly name: string
  readonly locationId: string
}

export interface PlayerBindingSpec extends WorldJsonObject {
  readonly principalId: string
  readonly characterId: CharacterId
  readonly sessionId: SessionId
}

export interface PluginSpec extends WorldJsonObject {
  readonly pluginId: string
  readonly version: string
}

export interface CompiledWorldManifest extends WorldJsonObject {
  readonly schemaVersion: 1
  readonly address: WorldAddress
  readonly timeMode: 'TURN_DRIVEN'
  readonly roundQueueLimit: number
  readonly rulebook: { readonly rulebookId: 'builtin:speak-move'; readonly version: 1 }
  readonly locations: readonly LocationSpec[]
  readonly characters: readonly CharacterSpec[]
  readonly playerBindings: readonly PlayerBindingSpec[]
  readonly plugins: readonly PluginSpec[]
}

export interface CompiledWorldSpec {
  readonly manifest: CompiledWorldManifest
  readonly manifestHash: WorldHash
  readonly genesisEvents: readonly WorldEventDraft[]
  readonly genesisHash: WorldHash
}

function objectAt(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError(`${path} must be an object`)
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], path: string): void {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${path} contains missing or unknown fields`)
  }
}

function textAt(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new TypeError(`${path} must be a non-empty, unpadded string`)
  }
  return value
}

function arrayAt(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${path} must be an array`)
  return value
}

function unique(values: readonly string[], path: string): void {
  if (new Set(values).size !== values.length) throw new TypeError(`${path} contains duplicate identifiers`)
}

/** Strict compiler from declarative WorldSpec V1 into hash-stable runtime inputs. */
export class WorldSpecCompiler {
  compile(input: unknown): CompiledWorldSpec {
    canonicalizeWorldJson(input as WorldJsonValue)
    const root = objectAt(input, 'WorldSpec')
    exactKeys(root, ['schemaVersion', 'address', 'timeMode', 'roundQueueLimit', 'rulebook', 'locations', 'characters', 'playerBindings', 'plugins'], 'WorldSpec')
    if (root.schemaVersion !== 1) throw new TypeError('WorldSpec.schemaVersion must be 1')
    if (root.timeMode !== 'TURN_DRIVEN') throw new TypeError('WorldSpec.timeMode must be TURN_DRIVEN in V0')
    if (!Number.isSafeInteger(root.roundQueueLimit) || (root.roundQueueLimit as number) <= 0) {
      throw new TypeError('WorldSpec.roundQueueLimit must be a positive safe integer')
    }

    const addressValue = objectAt(root.address, 'WorldSpec.address')
    exactKeys(addressValue, ['tenantId', 'worldId', 'branchId'], 'WorldSpec.address')
    const address: WorldAddress = {
      tenantId: brandId(textAt(addressValue.tenantId, 'tenantId'), 'TenantId'),
      worldId: brandId(textAt(addressValue.worldId, 'worldId'), 'WorldId'),
      branchId: brandId(textAt(addressValue.branchId, 'branchId'), 'BranchId'),
    }
    const rulebookValue = objectAt(root.rulebook, 'WorldSpec.rulebook')
    exactKeys(rulebookValue, ['rulebookId', 'version'], 'WorldSpec.rulebook')
    if (rulebookValue.rulebookId !== 'builtin:speak-move' || rulebookValue.version !== 1) {
      throw new TypeError('WorldSpec.rulebook must select builtin:speak-move version 1')
    }

    const locations = arrayAt(root.locations, 'WorldSpec.locations').map((entry, index): LocationSpec => {
      const value = objectAt(entry, `locations[${index}]`)
      exactKeys(value, ['locationId', 'name'], `locations[${index}]`)
      return { locationId: textAt(value.locationId, 'locationId'), name: textAt(value.name, 'location.name') }
    }).sort((left, right) => left.locationId.localeCompare(right.locationId))
    if (locations.length === 0) throw new TypeError('WorldSpec.locations cannot be empty')
    unique(locations.map(value => value.locationId), 'WorldSpec.locations')
    const locationIds = new Set(locations.map(value => value.locationId))

    const characters = arrayAt(root.characters, 'WorldSpec.characters').map((entry, index): CharacterSpec => {
      const value = objectAt(entry, `characters[${index}]`)
      exactKeys(value, ['characterId', 'name', 'locationId'], `characters[${index}]`)
      const locationId = textAt(value.locationId, 'character.locationId')
      if (!locationIds.has(locationId)) throw new TypeError(`character references unknown location ${locationId}`)
      return {
        characterId: brandId(textAt(value.characterId, 'characterId'), 'CharacterId'),
        name: textAt(value.name, 'character.name'),
        locationId,
      }
    }).sort((left, right) => left.characterId.localeCompare(right.characterId))
    if (characters.length === 0) throw new TypeError('WorldSpec.characters cannot be empty')
    unique(characters.map(value => value.characterId), 'WorldSpec.characters')
    const characterIds = new Set(characters.map(value => value.characterId))

    const playerBindings = arrayAt(root.playerBindings, 'WorldSpec.playerBindings').map((entry, index): PlayerBindingSpec => {
      const value = objectAt(entry, `playerBindings[${index}]`)
      exactKeys(value, ['principalId', 'characterId', 'sessionId'], `playerBindings[${index}]`)
      const characterId = brandId(textAt(value.characterId, 'binding.characterId'), 'CharacterId')
      if (!characterIds.has(characterId)) throw new TypeError(`binding references unknown character ${characterId}`)
      return {
        principalId: textAt(value.principalId, 'principalId'),
        characterId,
        sessionId: brandId(textAt(value.sessionId, 'sessionId'), 'SessionId'),
      }
    }).sort((left, right) => left.principalId.localeCompare(right.principalId))
    if (playerBindings.length === 0) throw new TypeError('WorldSpec.playerBindings cannot be empty')
    unique(playerBindings.map(value => value.principalId), 'WorldSpec.playerBindings principals')
    unique(playerBindings.map(value => value.characterId), 'WorldSpec.playerBindings characters')

    const plugins = arrayAt(root.plugins, 'WorldSpec.plugins').map((entry, index): PluginSpec => {
      const value = objectAt(entry, `plugins[${index}]`)
      exactKeys(value, ['pluginId', 'version'], `plugins[${index}]`)
      const version = textAt(value.version, 'plugin.version')
      if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new TypeError('plugin.version must be exact semver')
      return { pluginId: textAt(value.pluginId, 'pluginId'), version }
    }).sort((left, right) => left.pluginId.localeCompare(right.pluginId))
    unique(plugins.map(value => value.pluginId), 'WorldSpec.plugins')

    const manifest: CompiledWorldManifest = {
      schemaVersion: 1,
      address,
      timeMode: 'TURN_DRIVEN',
      roundQueueLimit: root.roundQueueLimit as number,
      rulebook: { rulebookId: 'builtin:speak-move', version: 1 },
      locations,
      characters,
      playerBindings,
      plugins,
    }
    const genesisEvents: readonly WorldEventDraft[] = [
      { eventType: 'world.activated', eventVersion: 1, data: { manifestHash: hashWorldJson('compiled-world-manifest', manifest) } },
      ...locations.map(location => ({ eventType: 'location.upsert', eventVersion: 1, data: location })),
      ...characters.map(character => ({ eventType: 'character.upsert', eventVersion: 1, data: character })),
      ...playerBindings.map(binding => ({ eventType: 'player.binding.upsert', eventVersion: 1, data: binding })),
    ]
    return {
      manifest,
      manifestHash: hashWorldJson('compiled-world-manifest', manifest),
      genesisEvents,
      genesisHash: hashWorldJson('world-genesis-plan', genesisEvents),
    }
  }
}
