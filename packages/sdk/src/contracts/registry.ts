import { hashWorldJson, type WorldHash, type WorldJsonObject } from './world-json.ts'

export type RegistryKind = 'event' | 'action' | 'projection' | 'rule'

export interface RegistryDefinition extends WorldJsonObject {
  readonly name: string
  readonly version: number
  readonly schemaHash: WorldHash
}
export interface RegistryManifest extends WorldJsonObject {
  readonly registryKind: RegistryKind
  readonly definitions: readonly RegistryDefinition[]
}

/** Mutable-at-boot, immutable-at-runtime definition registry. */
export class VersionedRegistry {
  readonly #definitions = new Map<string, RegistryDefinition>()
  #frozen = false

  constructor(readonly kind: RegistryKind) {}

  /** Register one exact name/version/schema tuple before the manifest is frozen. */
  register(definition: RegistryDefinition): void {
    if (this.#frozen) throw new Error(`${this.kind} registry is frozen`)
    if (!Number.isSafeInteger(definition.version) || definition.version < 1) {
      throw new TypeError('registry definition version must be a positive safe integer')
    }
    const key = `${definition.name}@${definition.version}`
    if (this.#definitions.has(key)) throw new Error(`duplicate ${this.kind} definition ${key}`)
    this.#definitions.set(key, Object.freeze({ ...definition }))
  }

  /** Resolve one definition without applying version fallback. */
  get(name: string, version: number): RegistryDefinition | undefined {
    return this.#definitions.get(`${name}@${version}`)
  }

  /** Freeze registration and return the sorted, hashable manifest. */
  freeze(): { readonly manifest: RegistryManifest; readonly hash: WorldHash } {
    this.#frozen = true
    const definitions = [...this.#definitions.values()].sort((left, right) => {
      if (left.name !== right.name) return left.name < right.name ? -1 : 1
      return left.version - right.version
    })
    const manifest: RegistryManifest = { registryKind: this.kind, definitions }
    return { manifest, hash: hashWorldJson('world-registry-manifest', manifest) }
  }
}
