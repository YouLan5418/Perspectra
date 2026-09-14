import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  brandId,
  canonicalizeWorldJson,
  hashWorldJson,
  interactionPackageDescription,
  type InteractionPackageDescription,
  type WorldJsonValue,
} from '@harness-world/contracts'
import { createBasicInteractionPackage } from '@harness-world/interactions-basic'
import { SpeakMoveRulebook, characterInteractionManifestRegistries, runtimeManifestFromStored } from '@harness-world/kernel'
import { InteractionRegistry } from '@harness-world/interaction-runtime'
import {
  WorldPackCompilerV5,
  canonicalWorldPackBytesV5,
  verifyCompiledWorldPackV5,
} from './compiler.ts'
import {
  WorldPackInspector,
  adaptCompiledWorldPack,
  canonicalCompiledWorldPackBytes,
  compileWorldPackSource,
  readCompiledPack,
} from './tooling.ts'
import {
  parseWorldPackEntitiesSourceV2,
  parseWorldPackInteractionsSource,
  parseCompiledWorldPackV5,
  parseWorldPackSourceManifestV5,
} from './schema.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

const packages = [interactionPackageDescription(createBasicInteractionPackage())]
const address = {
  tenantId: brandId('tenant:worldpack-v5', 'TenantId'),
  worldId: brandId('world:worldpack-v5', 'WorldId'),
  branchId: brandId('branch:main', 'BranchId'),
}

interface SourceOptions {
  readonly bindings?: readonly { readonly bindingId: string; readonly id: string; readonly version: number; readonly config: Record<string, unknown> }[]
  readonly definitions?: readonly string[]
  readonly packageId?: string
  readonly packageVersion?: number
  readonly characters?: unknown
  readonly reactionMode?: 'disabled' | 'responsive'
  readonly relationBindings?: readonly {
    readonly bindingId: string; readonly relationClass: string
    readonly id: string; readonly version: number; readonly config: Record<string, unknown>
  }[]
}

/** A real v5 source: the v4 example on the V2/V3 target files plus an explicit selection. */
async function source(options: SourceOptions = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'worldpack-v5-'))
  roots.push(root)
  await cp(fileURLToPath(new URL('../../../examples/world-packs/rainy-road-companions/', import.meta.url)), root, { recursive: true })
  const manifest = JSON.parse(await readFile(join(root, 'worldpack.source.json'), 'utf8')) as Record<string, unknown>
  await writeFile(join(root, 'worldpack.source.json'), canonicalizeWorldJson({
    ...manifest,
    sourceSchemaVersion: 'worldpack-source/v5',
    packId: 'pack:interaction-wheel',
    reactionFile: 'reaction.json',
    manifestationFile: 'manifestation.json',
    interactionFile: 'interactions.json',
  }))
  await writeFile(join(root, 'reaction.json'), canonicalizeWorldJson(options.reactionMode === 'disabled'
    ? { schemaVersion: 'worldpack-reaction/v1', mode: 'disabled' }
    : { schemaVersion: 'worldpack-reaction/v1', mode: 'responsive', profile: 'responsive/v1' }))
  await writeFile(join(root, 'manifestation.json'), canonicalizeWorldJson({
    schemaVersion: 'worldpack-manifestation/v1', mode: 'enabled',
  }))
  await writeFile(join(root, 'entities.json'), JSON.stringify({
    schemaVersion: 'worldpack-entities/v2',
    entities: [{
      entityId: 'entity:ticket-bundle', locationId: 'location:road-shelter', kind: 'ticket_bundle',
      interactionBindings: (options.bindings ?? [
        { bindingId: 'binding:bundle-take', id: 'base:take', version: 1, config: {} },
        { bindingId: 'binding:bundle-drop', id: 'base:drop', version: 1, config: {} },
        { bindingId: 'binding:bundle-give', id: 'base:give', version: 1, config: {} },
      ]).map(binding => ({ bindingId: binding.bindingId, definition: { id: binding.id, version: binding.version }, config: binding.config })),
    }],
  }, null, 2))
  const characters = JSON.parse(await readFile(join(root, 'characters.json'), 'utf8')) as Record<string, unknown>
  await writeFile(join(root, 'characters.json'), JSON.stringify({
    ...(options.characters ?? characters), schemaVersion: 'worldpack-characters/v3',
  }, null, 2))
  await writeFile(join(root, 'interactions.json'), canonicalizeWorldJson({
    schemaVersion: 'worldpack-interactions/v1',
    packages: [{ id: options.packageId ?? 'package:interactions-basic', version: options.packageVersion ?? 1 }],
    definitions: (options.definitions ?? ['base:take', 'base:drop', 'base:give']).map(id => ({ id, version: 1 })),
    ...(options.relationBindings === undefined ? {} : {
      relationBindings: options.relationBindings.map(binding => ({
        bindingId: binding.bindingId, relationClass: binding.relationClass,
        definition: { id: binding.id, version: binding.version }, config: binding.config,
      })),
    }),
  }))
  return root
}

async function compile(options: SourceOptions = {}) {
  return await new WorldPackCompilerV5().compile(await source(options), {
    limitsProfile: 'worldpack-limits/v2', interactionPackages: packages,
  })
}

describe('WorldPackCompilerV5', () => {
  it('compiles the author selection into an interaction catalog with resolved locks', async () => {
    const pack = await compile()
    expect(pack.compiledSchemaVersion).toBe('worldpack/v5')
    expect(pack.interactions.version).toBe('interaction-catalog/v3')
    expect(pack.interactions.packages).toHaveLength(1)
    expect(pack.interactions.packages[0]!.ref).toEqual({ id: 'package:interactions-basic', version: 1 })
    expect(pack.interactions.definitions.map(entry => `${entry.ref.id}@${entry.ref.version}`))
      .toEqual(['base:take@1', 'base:drop@1', 'base:give@1'])
    // Every definition hash is derived from the installed description, never written by the author.
    for (const entry of pack.interactions.definitions) {
      expect(entry.definitionHash).toMatch(/^sha256:[0-9a-f]{64}$/u)
      expect(entry.implementationHash).toMatch(/^sha256:[0-9a-f]{64}$/u)
    }
    expect(pack.interactions.bindings.map(binding => binding.bindingId))
      .toEqual(['binding:bundle-drop', 'binding:bundle-give', 'binding:bundle-take'])
    expect(pack.interactions.bindings.every(binding => binding.targetRef.id === 'entity:ticket-bundle')).toBe(true)
    expect(verifyCompiledWorldPackV5(pack)).toEqual(pack)
    expect(canonicalWorldPackBytesV5(pack).byteLength).toBeGreaterThan(0)
  }, 60_000)

  it('changes only the catalog when the author changes only the content', async () => {
    const base = await compile()
    const extended = await compile({
      bindings: [
        { bindingId: 'binding:bundle-take', id: 'base:take', version: 1, config: {} },
        { bindingId: 'binding:bundle-drop', id: 'base:drop', version: 1, config: {} },
      ],
    })
    const dropped = extended.interactions.bindings.map(binding => binding.bindingId)
    expect(dropped).toEqual(['binding:bundle-drop', 'binding:bundle-take'])
    expect(base.interactions.bindings).toHaveLength(3)
    // The content is identical, so a binding-only edit moves the pack hash through the catalog alone.
    expect(base.packHash).not.toBe(extended.packHash)
    const identity = (pack: typeof base) => pack.content.entities.map(entity => ({
      entityId: entity.entityId, locationId: entity.locationId, kind: entity.kind,
    }))
    expect(identity(base)).toEqual(identity(extended))
  }, 60_000)

  it('rejects an author selection the Host cannot satisfy', async () => {
    await expect(compile({ packageId: 'package:not-installed' })).rejects.toThrow(/not installed/u)
    // base:hug is a proposal example, not a shipped definition, so it is not provided.
    await expect(compile({ definitions: ['base:take', 'base:hug'] })).rejects.toThrow(/not provided by an installed package/u)
    await expect(compile({ bindings: [
      { bindingId: 'binding:bundle-take', id: 'base:take', version: 2, config: {} },
    ] })).rejects.toThrow(/did not enable/u)
    await expect(compile({ bindings: [
      { bindingId: 'binding:duplicate', id: 'base:take', version: 1, config: {} },
      { bindingId: 'binding:duplicate', id: 'base:drop', version: 1, config: {} },
    ] })).rejects.toThrow(/duplicate/u)
    await expect(compile({ bindings: [
      { bindingId: 'binding:bundle-take', id: 'base:take', version: 1, config: { holder: 'character:alice' } },
    ] })).rejects.toThrow(/is not allowed/u)
  }, 60_000)

  it('binds a character target only to a definition that accepts it', async () => {
    const characters = JSON.parse(await readFile(
      fileURLToPath(new URL('../../../examples/world-packs/rainy-road-companions/characters.json', import.meta.url)), 'utf8',
    )) as { readonly characters: readonly Record<string, unknown>[] }
    const withBindings = {
      schemaVersion: 'worldpack-characters/v3',
      characters: characters.characters.map(character => character.characterId === 'character:alice'
        ? { ...character, interactionBindings: [{ bindingId: 'binding:alice-take', definition: { id: 'base:take', version: 1 }, config: {} }] }
        : character),
    }
    // base:take declares an entity primary target, so a character binding is a reference error.
    await expect(compile({ characters: withBindings })).rejects.toThrow(/target kind/u)
  }, 60_000)

  it('produces a catalog the runtime accepts, so compile and activation agree', async () => {
    const pack = await compile()
    const registry = new InteractionRegistry()
    registry.install(createBasicInteractionPackage())
    const frozen = registry.freeze({
      address,
      packages: pack.interactions.packages,
      definitions: pack.interactions.definitions,
      bindings: pack.interactions.bindings,
    })
    const adjudication = frozen.resolve({
      address, manifestHash: pack.packHash, asOfWorldSeq: 0,
      candidatePrefixHash: pack.packHash, actionId: 'action:take', actorId: brandId('character:player', 'CharacterId'),
      authority: { version: 'resolution-authority/v1', sourceRole: 'player', adjudicationMode: 'standard' },
      targets: [
        { ref: { kind: 'character', id: 'character:player' }, state: { lifecycle: 'active', locationId: 'location:road-shelter', sceneIds: ['scene:shelter'] } },
        { ref: { kind: 'entity', id: 'entity:ticket-bundle' }, state: { holderId: null, locationId: 'location:road-shelter' } },
      ],
      authorizedTargets: [{ kind: 'entity', id: 'entity:ticket-bundle' }],
    }, {
      targetRef: { kind: 'entity', id: 'entity:ticket-bundle' },
      bindingId: 'binding:bundle-take',
      definitionRef: { id: 'base:take', version: 1 },
      arguments: {},
    })
    expect(adjudication.status).toBe('accepted')
    expect(adjudication.events).toHaveLength(1)
  }, 60_000)

  it('keeps the v2 entity file and the v5 manifest parsers strict', async () => {
    expect(parseWorldPackEntitiesSourceV2({
      schemaVersion: 'worldpack-entities/v2',
      entities: [{ entityId: 'entity:cup', locationId: 'location:hall', kind: 'cup' }],
    }).entities).toEqual([{ entityId: 'entity:cup', locationId: 'location:hall', kind: 'cup' }])
    expect(parseWorldPackInteractionsSource({
      schemaVersion: 'worldpack-interactions/v1',
      packages: [{ id: 'package:interactions-basic', version: 1 }], definitions: [],
    }).definitions).toEqual([])
    const root = await source()
    const manifest = parseWorldPackSourceManifestV5(
      JSON.parse(await readFile(join(root, 'worldpack.source.json'), 'utf8')),
    )
    expect(manifest.sourceSchemaVersion).toBe('worldpack-source/v5')
    expect(manifest.interactionFile).toBe('interactions.json')
  }, 60_000)

  it('reaches the v5 envelope through the shared tooling entry points', async () => {
    const root = await source()
    const pack = await compileWorldPackSource(root, packages)
    expect(pack.compiledSchemaVersion).toBe('worldpack/v5')
    const bytes = canonicalCompiledWorldPackBytes(pack)
    const written = join(root, 'worldpack.json')
    await writeFile(written, bytes)
    const reread = await readCompiledPack(written)
    expect(reread.compiledSchemaVersion).toBe('worldpack/v5')
    expect(await new WorldPackInspector().inspect(written)).toMatchObject({
      packId: 'pack:interaction-wheel', entityCount: 1,
      manifestation: { mode: 'enabled' }, reaction: { mode: 'responsive' },
    })
    // The v5 Pack owns its selection, so it binds to v10 and refuses a second one, whichever
    // second one the caller tries to impose.
    for (const override of [{ interactionCatalog: { version: 'interaction-catalog/v2' } }, { actionGroups: 'bounded/v1' }] as const) {
      expect(() => adaptCompiledWorldPack(pack, {
        address, principalId: 'principal:player', sessionId: brandId('session:worldpack-v5', 'SessionId'),
        ...override,
      })).toThrow(/carries its own interaction selection/u)
    }
    expect(() => parseCompiledWorldPackV5({ ...pack, compiledSchemaVersion: 'worldpack/v4' })).toThrow(/compiledSchemaVersion/u)
  }, 60_000)

  it('rejects a hand-edited catalog whose bindings no longer match the content', async () => {
    const pack = await compile()
    const retamper = (mutate: (draft: Record<string, unknown>) => void): unknown => {
      const { packHash: _packHash, ...unsigned } = pack
      const draft = JSON.parse(JSON.stringify(unsigned)) as Record<string, unknown>
      mutate(draft)
      return { ...draft, packHash: hashWorldJson('compiled-world-pack/v5', draft as unknown as WorldJsonValue) }
    }
    const missingTarget = retamper(draft => {
      const interactions = draft.interactions as { bindings: { targetRef: { id: string } }[] }
      interactions.bindings[0]!.targetRef.id = 'entity:ghost'
    })
    expect(() => verifyCompiledWorldPackV5(missingTarget)).toThrow(/unknown entity target/u)
    const missingDefinition = retamper(draft => { (draft.interactions as { definitions: unknown[] }).definitions = [] })
    expect(() => verifyCompiledWorldPackV5(missingDefinition)).toThrow(/outside the catalog/u)
    // A relation target names a class: an id the catalog does not enable is refused, and one it does
    // enable is legal without ever naming an instance.
    const unknownClass = retamper(draft => {
      const interactions = draft.interactions as { bindings: { targetRef: { kind: string; id: string } }[] }
      interactions.bindings[0]!.targetRef = { kind: 'relation', id: 'relation:any' }
    })
    expect(() => verifyCompiledWorldPackV5(unknownClass)).toThrow(/relation class relation:any/u)
    // This check is about the reference only; whether the named class actually creates relations is
    // the runtime's business, and freeze() refuses one that does not.
    const relationClass = retamper(draft => {
      const interactions = draft.interactions as { bindings: { targetRef: { kind: string; id: string } }[] }
      interactions.bindings[0]!.targetRef = { kind: 'relation', id: 'base:take' }
    })
    expect(verifyCompiledWorldPackV5(relationClass).interactions.bindings[0]!.targetRef)
      .toEqual({ kind: 'relation', id: 'base:take' })
    // A character target is legal once the binding actually names a compiled character.
    const characterTarget = retamper(draft => {
      const interactions = draft.interactions as { bindings: { targetRef: { kind: string; id: string } }[] }
      interactions.bindings[0]!.targetRef = { kind: 'character', id: 'character:alice' }
    })
    expect(verifyCompiledWorldPackV5(characterTarget).interactions.bindings[0]!.targetRef.kind).toBe('character')
    // The envelope hash is the last check, so a mismatched hash must still be rejected.
    expect(() => verifyCompiledWorldPackV5({ ...pack, packHash: `sha256:${'0'.repeat(64)}` }))
      .toThrow(/does not match the compiled v5 envelope/u)
  }, 60_000)

  it('validates author config against the definition schema and nothing wider', async () => {
    const spec = {
      versionTag: 'interaction-definition/v1', id: 'fixture:configure', version: 1,
      participantRoles: [
        { name: 'actor', kind: 'character', source: { kind: 'hostActor' }, distinctFrom: [] },
        { name: 'item', kind: 'entity', source: { kind: 'primaryTarget' }, distinctFrom: [] },
      ],
      argumentSchema: { fields: [] },
      bindingConfigSchema: { fields: [
        { name: 'strict', type: 'boolean' },
        { name: 'attempts', type: 'integer', minimum: 1, maximum: 3 },
        { name: 'tone', type: 'string', maxBytes: 16, values: ['soft', 'firm'] },
      ] },
      authorityPolicyRef: { id: 'base:actor-active', version: 1 },
      preconditions: [], spatialRequirementRefs: [],
      effectBuilderRef: { id: 'base:take-effect', version: 1 }, effectCapabilityRefs: [{ id: 'base:take-effect', version: 1 }],
      dependencyRefs: [], limits: { maximumEvents: 1 },
    }
    const hash = (value: string): `sha256:${string}` => hashWorldJson('fixture/v1', { value })
    const configured = [{
      lock: { ref: { id: 'package:interactions-basic', version: 1 }, implementationHash: hash('lock'), dependencies: [] },
      definitions: [{ spec, implementationHash: hash('implementation') }],
    }] as unknown as readonly InteractionPackageDescription[]
    const run = async (config: Record<string, unknown>) => await new WorldPackCompilerV5().compile(await source({
      bindings: [{ bindingId: 'binding:bundle-take', id: 'fixture:configure', version: 1, config }],
      definitions: ['fixture:configure'],
    }), { limitsProfile: 'worldpack-limits/v2', interactionPackages: configured })
    const accepted = await run({ strict: true, attempts: 2, tone: 'soft' })
    expect(accepted.interactions.bindings[0]!.config).toEqual({ strict: true, attempts: 2, tone: 'soft' })
    await expect(run({ strict: 'yes', attempts: 2, tone: 'soft' })).rejects.toThrow(/must be a boolean/u)
    await expect(run({ strict: true, attempts: 9, tone: 'soft' })).rejects.toThrow(/safe integer/u)
    await expect(run({ strict: true, attempts: 2, tone: 'loud' })).rejects.toThrow(/declared domain/u)
    await expect(run({ strict: true, attempts: 2 })).rejects.toThrow(/is required|is not allowed/u)
  }, 60_000)

  it('reports the encoded config budget the runtime enforces, not only per-field bounds', async () => {
    // Four legal 1024-byte fields. Every field passes on its own, but the encoded object is 5161
    // bytes, which the runtime refuses; the compiler has to say so rather than emit a catalog that
    // freeze() will reject later.
    const spec = {
      versionTag: 'interaction-definition/v1', id: 'fixture:bulk', version: 1,
      participantRoles: [
        { name: 'actor', kind: 'character', source: { kind: 'hostActor' }, distinctFrom: [] },
        { name: 'item', kind: 'entity', source: { kind: 'primaryTarget' }, distinctFrom: [] },
      ],
      argumentSchema: { fields: [] },
      bindingConfigSchema: { fields: ['a', 'b', 'c', 'd'].map(name => ({ name, type: 'string', maxBytes: 1024, values: [] })) },
      authorityPolicyRef: { id: 'base:actor-active', version: 1 },
      preconditions: [], spatialRequirementRefs: [],
      effectBuilderRef: { id: 'base:take-effect', version: 1 }, effectCapabilityRefs: [{ id: 'base:take-effect', version: 1 }],
      dependencyRefs: [], performancePolicyRef: { id: 'base:no-performance', version: 1 }, limits: { maximumEvents: 1 },
    }
    const description = [{
      lock: { ref: { id: 'package:bulk', version: 1 }, implementationHash: hashWorldJson('fixture/lock/v1', { id: 'bulk' }), dependencies: [] },
      definitions: [{ spec, implementationHash: hashWorldJson('fixture/impl/v1', { id: 'bulk' }) }],
    }] as unknown as readonly InteractionPackageDescription[]
    const bulk = { a: '中'.repeat(340), b: '中'.repeat(340), c: '中'.repeat(340), d: '中'.repeat(340) }
    await expect(new WorldPackCompilerV5().compile(await source({
      packageId: 'package:bulk',
      bindings: [{ bindingId: 'binding:bulk', id: 'fixture:bulk', version: 1, config: bulk }],
      definitions: ['fixture:bulk'],
    }), { limitsProfile: 'worldpack-limits/v2', interactionPackages: description })).rejects.toThrow(/encode at most 4096 bytes/u)
  }, 60_000)
})

const runtimeOptions = () => ({
  address, principalId: 'principal:player', sessionId: brandId('session:worldpack-v5', 'SessionId'),
})

/** Build a real v10 Manifest, then hand back a deep copy the caller may tamper with. */
async function compiledV10(): Promise<Record<string, unknown>> {
  const pack = await compile()
  const spec = new WorldPackCompilerV5().adaptToWorldSpec(pack, runtimeOptions())
  return JSON.parse(JSON.stringify(spec.manifest)) as Record<string, unknown>
}

describe('Manifest v10 binding for a compiled worldpack/v5', () => {
  it('binds the pack selection to v10 and re-reads the same bytes as a stored Manifest', async () => {
    const pack = await compile()
    const spec = new WorldPackCompilerV5().adaptToWorldSpec(pack, runtimeOptions())
    expect(spec.manifest.schemaVersion).toBe(10)
    expect(spec.manifest.actionGroupPolicy).toEqual({ version: 'bounded-action-group/v2' })
    // The catalog is carried over verbatim: the package locks the world has to resolve are the ones
    // the compiler already committed to, not a re-derivation.
    expect(spec.manifest.interactionCatalog).toEqual(pack.interactions)
    expect(spec.manifest.registries).toEqual(characterInteractionManifestRegistries())
    expect(spec.manifest.rulebook).toEqual(pack.content.world.coreProfiles.rulebook)
    // Content, reaction and manifestation policy are the v6 shape, so only execution changed.
    expect(spec.manifest.characters).toHaveLength(pack.content.characters.length)
    expect(spec.manifest.reactionPolicy).toEqual(pack.reaction.mode === 'disabled'
      ? { version: 'reaction-policy/v1', mode: 'disabled' }
      : { version: 'reaction-policy/v1', mode: 'responsive', profile: pack.reaction.profile })
    expect(spec.manifest.manifestationPolicy).toEqual({ version: 'manifestation-policy/v1', mode: 'enabled' })
    expect(spec.manifestHash).toMatch(/^sha256:[0-9a-f]{64}$/u)
    expect(spec.genesisEvents[0]).toEqual({ eventType: 'world.created', eventVersion: 1, data: { specHash: spec.manifest.specHash } })
    // A v10 stored Manifest re-reads its own selection rather than trusting it.
    const stored = runtimeManifestFromStored(spec.manifest as unknown as WorldJsonValue)
    expect(stored.schemaVersion).toBe(10)
    expect(runtimeManifestFromStored(spec.manifest as unknown as WorldJsonValue)).toEqual(stored)
  }, 60_000)

  it('moves the spec hash when only the selection changes', async () => {
    const narrow = await compile({
      bindings: [{ bindingId: 'binding:bundle-take', id: 'base:take', version: 1, config: {} }],
    })
    const wide = await compile()
    const narrowSpec = new WorldPackCompilerV5().adaptToWorldSpec(narrow, runtimeOptions())
    const wideSpec = new WorldPackCompilerV5().adaptToWorldSpec(wide, runtimeOptions())
    expect(narrowSpec.manifest.specHash).not.toBe(wideSpec.manifest.specHash)
    expect(narrowSpec.manifestHash).not.toBe(wideSpec.manifestHash)
  }, 60_000)

  it('re-reads every reference of a stored v10 selection and refuses each tampered one', async () => {
    const base = await compiledV10()
    const stored = (mutate: (draft: Record<string, unknown>) => void): WorldJsonValue => {
      const draft = JSON.parse(JSON.stringify(base)) as Record<string, unknown>
      mutate(draft)
      return draft as WorldJsonValue
    }
    const selection = (draft: Record<string, unknown>): Record<string, unknown> => draft.interactionCatalog as Record<string, unknown>
    const definitionLock = (overrides: Record<string, unknown> = {}) => ({
      ref: { id: 'package:interactions-basic', version: 1 }, implementationHash: `sha256:${'a'.repeat(64)}`,
      dependencies: [], ...overrides,
    })

    expect(() => runtimeManifestFromStored(stored(draft => { selection(draft).version = 'interaction-catalog/v2' })))
      .toThrow(/interaction-catalog\/v3/u)
    expect(() => runtimeManifestFromStored(stored(draft => { selection(draft).packages = [] })))
      .toThrow(/outside the frozen selection budget/u)
    expect(() => runtimeManifestFromStored(stored(draft => {
      selection(draft).packages = Array.from({ length: 33 }, () => definitionLock())
    }))).toThrow(/outside the frozen selection budget/u)
    expect(() => runtimeManifestFromStored(stored(draft => {
      selection(draft).packages = [definitionLock(), definitionLock()]
    }))).toThrow(/duplicate identifiers/u)
    expect(() => runtimeManifestFromStored(stored(draft => {
      selection(draft).packages = [{ ...definitionLock(), extra: true }]
    }))).toThrow(/missing or unknown fields/u)
    expect(() => runtimeManifestFromStored(stored(draft => {
      selection(draft).packages = [definitionLock({ dependencies: [{ id: 'package:x', version: 1 }, { id: 'package:x', version: 1 }] })]
    }))).toThrow(/duplicate identifiers/u)
    expect(() => runtimeManifestFromStored(stored(draft => {
      selection(draft).packages = [definitionLock({ ref: { id: 'package:x', version: 0 } })]
    }))).toThrow(/positive safe integer/u)
    expect(() => runtimeManifestFromStored(stored(draft => {
      const definitions = selection(draft).definitions as Record<string, unknown>[]
      definitions[0]!.extra = true
    }))).toThrow(/missing or unknown fields/u)
    expect(() => runtimeManifestFromStored(stored(draft => {
      selection(draft).definitions = Array.from({ length: 129 }, (_, index) => ({
        ref: { id: `base:d${index}`, version: 1 }, definitionHash: `sha256:${'b'.repeat(64)}`, implementationHash: `sha256:${'c'.repeat(64)}`,
      }))
    }))).toThrow(/outside the frozen selection budget/u)
    expect(() => runtimeManifestFromStored(stored(draft => {
      const definitions = selection(draft).definitions as Record<string, unknown>[]
      definitions[1] = { ...definitions[0]! }
    }))).toThrow(/duplicate identifiers/u)
    expect(() => runtimeManifestFromStored(stored(draft => {
      const bindings = selection(draft).bindings as Record<string, unknown>[]
      bindings[0]!.targetRef = { kind: 'unknown', id: 'entity:ticket-bundle' }
    }))).toThrow(/kind is unknown/u)
    expect(() => runtimeManifestFromStored(stored(draft => {
      const bindings = selection(draft).bindings as Record<string, unknown>[]
      bindings[0]!.definitionRef = { id: 'base:take', version: 2 }
    }))).toThrow(/did not enable/u)
    expect(() => runtimeManifestFromStored(stored(draft => {
      const bindings = selection(draft).bindings as Record<string, unknown>[]
      bindings[0]!.targetRef = { kind: 'entity', id: 'entity:ghost' }
    }))).toThrow(/names an unknown entity target/u)
    expect(() => runtimeManifestFromStored(stored(draft => {
      const bindings = selection(draft).bindings as Record<string, unknown>[]
      bindings[0]!.targetRef = { kind: 'character', id: 'character:ghost' }
    }))).toThrow(/names an unknown character target/u)
    // A relation binding names a class. An id the world did not enable is refused, because a static
    // Manifest could never name an instance and must not pretend to.
    expect(() => runtimeManifestFromStored(stored(draft => {
      const bindings = selection(draft).bindings as Record<string, unknown>[]
      bindings[0]!.targetRef = { kind: 'relation', id: 'relation:any' }
    }))).toThrow(/names relation class relation:any, which the world did not enable/u)
    expect(() => runtimeManifestFromStored(stored(draft => {
      const bindings = selection(draft).bindings as Record<string, unknown>[]
      bindings[0]!.config = null
    }))).toThrow(/config must be an object/u)
    expect(() => runtimeManifestFromStored(stored(draft => {
      const bindings = selection(draft).bindings as Record<string, unknown>[]
      bindings[1]!.bindingId = bindings[0]!.bindingId
    }))).toThrow(/duplicate identifiers/u)
    expect(() => runtimeManifestFromStored(stored(draft => {
      selection(draft).bindings = Array.from({ length: 4097 }, (_, index) => ({
        bindingId: `binding:b${index}`, targetRef: { kind: 'entity', id: 'entity:ticket-bundle' },
        definitionRef: { id: 'base:take', version: 1 }, config: {},
      }))
    }))).toThrow(/outside the frozen selection budget/u)
    expect(() => runtimeManifestFromStored(stored(draft => { selection(draft).extra = true })))
      .toThrow(/missing or unknown fields/u)
  }, 60_000)

  it('reaches the v10 binding through the shared tooling entry point', async () => {
    const spec = adaptCompiledWorldPack(await compile(), runtimeOptions())
    expect(spec.manifest.schemaVersion).toBe(10)
    const viaCompiler = new WorldPackCompilerV5().adaptToWorldSpec(await compile(), runtimeOptions())
    // The tooling path selects the versioned compiler rather than reimplementing the binding, so the
    // two must agree byte for byte.
    expect(spec.manifest).toEqual(viaCompiler.manifest)
    expect(spec.manifestHash).toBe(viaCompiler.manifestHash)
  }, 60_000)

  it('binds a relation class, so the release action is addressable at all', async () => {
    const characters = JSON.parse(await readFile(
      fileURLToPath(new URL('../../../examples/world-packs/rainy-road-companions/characters.json', import.meta.url)), 'utf8',
    )) as { readonly characters: readonly Record<string, unknown>[] }
    const pack = await compile({
      bindings: [{ bindingId: 'binding:bundle-take', id: 'base:take', version: 1, config: {} }],
      definitions: ['base:take', 'base:hold-hand', 'base:end-contact'],
      characters: {
        schemaVersion: 'worldpack-characters/v3',
        characters: characters.characters.map(character => character.characterId === 'character:alice'
          ? { ...character, interactionBindings: [{ bindingId: 'binding:alice-hold', definition: { id: 'base:hold-hand', version: 1 }, config: {} }] }
          : character),
      },
      relationBindings: [
        { bindingId: 'binding:release', relationClass: 'base:hold-hand', id: 'base:end-contact', version: 1, config: {} },
      ],
    })
    expect(pack.interactions.bindings.find(entry => entry.bindingId === 'binding:release')!.targetRef)
      .toEqual({ kind: 'relation', id: 'base:hold-hand' })
    // Compilation is only worth anything if the runtime accepts the same bytes, so the strong check is
    // that freeze() addresses an instance through the class the author named - and only that class.
    const registry = new InteractionRegistry()
    registry.install(createBasicInteractionPackage())
    const frozen = registry.freeze({
      address, packages: pack.interactions.packages,
      definitions: pack.interactions.definitions, bindings: pack.interactions.bindings,
    })
    const held = { kind: 'relation' as const, id: 'relation:held' }
    const host = (interactionId: string) => ({
      address, manifestHash: pack.packHash, asOfWorldSeq: 0, candidatePrefixHash: pack.packHash,
      actionId: 'action:release', actorId: brandId('character:player', 'CharacterId'),
      authority: { version: 'resolution-authority/v1', sourceRole: 'player', adjudicationMode: 'manual_player_immediate' } as never,
      targets: [
        { ref: { kind: 'character' as const, id: 'character:player' }, state: { lifecycle: 'active', locationId: 'location:road-shelter', sceneIds: ['scene:shelter'] } },
        { ref: { kind: 'character' as const, id: 'character:alice' }, state: { lifecycle: 'active', locationId: 'location:road-shelter', sceneIds: ['scene:shelter'] } },
        { ref: held, state: { interactionId, initiatorId: 'character:player', targetId: 'character:alice', active: true } },
      ],
      authorizedTargets: [
        { kind: 'character' as const, id: 'character:alice' }, held,
      ],
    })
    const release = {
      targetRef: held, bindingId: 'binding:release', definitionRef: { id: 'base:end-contact', version: 1 }, arguments: {},
    }
    expect(frozen.resolve(host('base:hold-hand') as never, release).status).toBe('accepted')
    // A relation of another class is not addressable through this binding, so the request is refused
    // instead of ending somebody else's relation.
    expect(() => frozen.resolve(host('base:other') as never, release)).toThrow(/does not match enabled binding/u)
    // The stored view re-reads the class reference too, so the release binding survives a round trip.
    const spec = new WorldPackCompilerV5().adaptToWorldSpec(pack, runtimeOptions())
    expect(runtimeManifestFromStored(spec.manifest as unknown as WorldJsonValue).schemaVersion).toBe(10)
  }, 60_000)

  it('refuses a relation class the world did not enable', async () => {
    await expect(compile({
      bindings: [{ bindingId: 'binding:bundle-take', id: 'base:take', version: 1, config: {} }],
      definitions: ['base:take', 'base:hold-hand', 'base:end-contact'],
      relationBindings: [
        { bindingId: 'binding:release', relationClass: 'base:hug', id: 'base:end-contact', version: 1, config: {} },
      ],
    })).rejects.toThrow(/relation class base:hug is not an enabled definition/u)
  }, 60_000)

  it('reads the relation binding source strictly', async () => {
    const root = await source({
      bindings: [{ bindingId: 'binding:bundle-take', id: 'base:take', version: 1, config: {} }],
      definitions: ['base:take', 'base:hold-hand', 'base:end-contact'],
      relationBindings: [
        { bindingId: 'binding:release', relationClass: 'base:hold-hand', id: 'base:end-contact', version: 1, config: {} },
      ],
    })
    const raw = JSON.parse(await readFile(join(root, 'interactions.json'), 'utf8')) as Record<string, unknown>
    const parsed = parseWorldPackInteractionsSource(raw)
    expect(parsed.relationBindings).toEqual([{
      bindingId: 'binding:release', relationClass: 'base:hold-hand',
      definition: { id: 'base:end-contact', version: 1 }, config: {},
    }])
    // Absent means none, which is how every world authored before this stayed valid.
    expect(parseWorldPackInteractionsSource({
      schemaVersion: 'worldpack-interactions/v1',
      packages: [{ id: 'package:interactions-basic', version: 1 }], definitions: [],
    }).relationBindings).toEqual([])
    const withBinding = (mutate: (draft: Record<string, unknown>) => void): unknown => {
      const draft = JSON.parse(JSON.stringify(raw)) as Record<string, unknown>
      mutate(draft)
      return draft
    }
    const first = (draft: Record<string, unknown>) => (draft.relationBindings as Record<string, unknown>[])[0]!
    expect(() => parseWorldPackInteractionsSource(withBinding(draft => { first(draft).extra = true })))
      .toThrow(/extra: is not allowed/u)
    expect(() => parseWorldPackInteractionsSource(withBinding(draft => { first(draft).bindingId = '' })))
      .toThrow(/bindingId/u)
    expect(() => parseWorldPackInteractionsSource(withBinding(draft => { first(draft).definition = { id: 'base:take', version: 0 } })))
      .toThrow(/safe integer from 1/u)
    expect(() => parseWorldPackInteractionsSource(withBinding(draft => { first(draft).config = null })))
      .toThrow(/\/config: must be an object/u)
    expect(() => parseWorldPackInteractionsSource(withBinding(draft => {
      draft.relationBindings = [first(draft), first(draft)]
    }))).toThrow(/contains duplicate values/u)
    expect(() => parseWorldPackInteractionsSource(withBinding(draft => { draft.relationBindings = 'no' })))
      .toThrow(/must be an array/u)
    expect(() => parseWorldPackInteractionsSource(withBinding(draft => {
      draft.relationBindings = Array.from({ length: 4097 }, (_, index) => ({
        bindingId: `binding:r${index}`, relationClass: 'base:hold-hand',
        definition: { id: 'base:end-contact', version: 1 }, config: {},
      }))
    }))).toThrow(/at most 4096 relation bindings/u)
  }, 60_000)

  it('refuses the legacy interact and take verbs on the v10 path instead of falling back', async () => {
    const pack = await compile()
    const manifest = new WorldPackCompilerV5().adaptToWorldSpec(pack, runtimeOptions()).manifest
    const rulebook = new SpeakMoveRulebook()
    const events = [{
      eventType: 'character.created', eventVersion: 1,
      data: { characterId: 'character:player', locationId: 'location:road-shelter', lifecycleState: 'active' },
    }]
    // Both verbs belong to the frozen path in v10, so the shared Rulebook refuses rather than
    // quietly resolving them through the closed catalog it no longer owns.
    for (const actionType of ['interact', 'take']) {
      const resolution = rulebook.resolve(manifest, events, 'character:player', { actionType, parameters: {} })
      expect(resolution.status).toBe('rejected')
      expect(resolution.reason).toContain('frozen interaction path')
    }
    expect(rulebook.resolve(manifest, events, 'character:player', { actionType: 'speak', parameters: { text: '走吧' } }).status)
      .toBe('accepted')
    // A move still comes from the shared Rulebook, and it names no relation: closing relations is the
    // frozen lifecycle plan's step, not the move's.
    const target = manifest.locations.find(location => location.locationId !== 'location:road-shelter')!.locationId
    const move = rulebook.resolve(manifest, events, 'character:player', { actionType: 'move', parameters: { locationId: target } })
    expect(move.status).toBe('accepted')
    expect(move.events.map(event => event.eventType)).toEqual(['character.moved'])
  }, 60_000)

  it('carries a disabled reaction policy and a non-active character into v10 unchanged', async () => {
    const characters = JSON.parse(await readFile(
      fileURLToPath(new URL('../../../examples/world-packs/rainy-road-companions/characters.json', import.meta.url)), 'utf8',
    )) as { readonly characters: readonly Record<string, unknown>[] }
    const pack = await compile({
      reactionMode: 'disabled',
      characters: {
        schemaVersion: 'worldpack-characters/v3',
        characters: characters.characters.map(character => character.characterId === 'character:bob'
          ? { ...character, lifecycle: 'departed' } : character),
      },
    })
    const spec = new WorldPackCompilerV5().adaptToWorldSpec(pack, runtimeOptions())
    expect(spec.manifest.reactionPolicy).toEqual({ version: 'reaction-policy/v1', mode: 'disabled' })
    expect(spec.manifest.characters.find(character => character.characterId === 'character:bob')!.lifecycle).toBe('departed')
    // A character that is not active gets the Genesis transition rather than being started active.
    const transitions = spec.genesisEvents.filter(event => event.eventType === 'character.lifecycle-changed')
    expect(transitions).toHaveLength(1)
    expect((transitions[0]!.data as { lifecycleState: string }).lifecycleState).toBe('departed')
  }, 60_000)

  it('keeps the v10 shape closed against the neighbouring versions', async () => {
    const base = await compiledV10()
    const stored = (mutate: (draft: Record<string, unknown>) => void): WorldJsonValue => {
      const draft = JSON.parse(JSON.stringify(base)) as Record<string, unknown>
      mutate(draft)
      return draft as WorldJsonValue
    }
    // v10 keeps the v9-era Host authority but not the v1 action group policy, and it does not accept
    // the v9 catalog either.
    expect(() => runtimeManifestFromStored(stored(draft => { draft.actionGroupPolicy = { version: 'bounded-action-group/v1' } })))
      .toThrow(/unsupported action group policy/u)
    expect(() => runtimeManifestFromStored(stored(draft => { draft.manifestationPolicy = { version: 'manifestation-policy/v1', mode: 'disabled' } })))
      .toThrow(/manifestation enabled/u)
    expect(() => runtimeManifestFromStored(stored(draft => { draft.interactionCatalog = { version: 'interaction-catalog/v2', packages: [], definitions: [], bindings: [] } })))
      .toThrow(/interaction-catalog\/v3/u)
    expect(() => runtimeManifestFromStored(stored(draft => { draft.playerInputPolicy = { version: 'nonsense/v1' } })))
      .toThrow(/playerInputPolicy version is unsupported/u)
    expect(() => runtimeManifestFromStored(stored(draft => { draft.schemaVersion = 9 })))
      .toThrow(/unsupported action group policy/u)
    // Re-read as v9 the v3 catalog is not a version the v9 path can even parse, and the older
    // object-interactions catalog is refused by name rather than silently upcast.
    expect(() => runtimeManifestFromStored(stored(draft => {
      draft.schemaVersion = 9
      draft.actionGroupPolicy = { version: 'bounded-action-group/v1' }
    }))).toThrow(/invalid interaction catalog/u)
    expect(() => runtimeManifestFromStored(stored(draft => {
      draft.schemaVersion = 9
      draft.actionGroupPolicy = { version: 'bounded-action-group/v1' }
      draft.interactionCatalog = { version: 'object-interactions/v1', definitions: [], bindings: [] }
    }))).toThrow(/Manifest v9 requires interaction-catalog\/v2/u)
  }, 60_000)
})
