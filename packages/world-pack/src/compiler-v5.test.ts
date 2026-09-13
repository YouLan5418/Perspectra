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
  await writeFile(join(root, 'reaction.json'), canonicalizeWorldJson({
    schemaVersion: 'worldpack-reaction/v1', mode: 'responsive', profile: 'responsive/v1',
  }))
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
    await expect(compile({ definitions: ['base:take', 'base:hold-hand'] })).rejects.toThrow(/not provided by an installed package/u)
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
    // Manifest v10 binding is not wired yet, so adaptation must fail closed rather than guess.
    expect(() => adaptCompiledWorldPack(pack, {
      address, principalId: 'principal:player', sessionId: brandId('session:worldpack-v5', 'SessionId'),
    })).toThrow(/not wired yet/u)
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
    // A relation target has no declared set of its own in this slice, so it fails closed too.
    const relationTarget = retamper(draft => {
      const interactions = draft.interactions as { bindings: { targetRef: { kind: string; id: string } }[] }
      interactions.bindings[0]!.targetRef = { kind: 'relation', id: 'relation:any' }
    })
    expect(() => verifyCompiledWorldPackV5(relationTarget)).toThrow(/unknown relation target/u)
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
