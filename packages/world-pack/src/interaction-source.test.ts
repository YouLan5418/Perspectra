import { hashWorldJson, type InteractionPackageDescription } from '@harness-world/contracts'
import { describe, expect, it } from 'vitest'
import {
  compileInteractionCatalog,
  parseCompiledWorldPackV5,
  parseInteractionCatalogV3,
  parseWorldPackCharactersSourceV3,
  parseWorldPackEntitiesSourceV2,
  parseWorldPackInteractionsSource,
  parseWorldPackSourceManifestV5,
} from './schema.ts'

function definition(id: string, version = 1) {
  return {
    spec: {
      versionTag: 'interaction-definition/v1', id, version,
      participantRoles: [
        { name: 'actor', kind: 'character', source: { kind: 'hostActor' }, distinctFrom: [] },
        { name: 'item', kind: 'entity', source: { kind: 'primaryTarget' }, distinctFrom: [] },
      ],
      argumentSchema: { fields: [] }, bindingConfigSchema: { fields: [] },
      authorityPolicyRef: { id: 'base:actor-active', version: 1 }, preconditions: [], spatialRequirementRefs: [],
      effectBuilderRef: { id: 'base:take-effect', version: 1 }, effectCapabilityRefs: [{ id: 'base:take-effect', version: 1 }],
      dependencyRefs: [], limits: { maximumEvents: 1 },
    },
    implementationHash: hashWorldJson('fixture/v1', { id, version }),
  }
}

function packageDescription(id: string, definitions: readonly unknown[], dependencies: readonly { id: string; version: number }[] = []): InteractionPackageDescription {
  return {
    lock: { ref: { id, version: 1 }, implementationHash: hashWorldJson('fixture/lock/v1', { id }), dependencies },
    definitions,
  } as unknown as InteractionPackageDescription
}

const entity = (bindings: readonly { readonly bindingId: string; readonly id?: string }[] = []) => ({
  entityId: 'entity:cup', locationId: 'location:hall', kind: 'cup',
  interactionBindings: bindings.map(binding => ({ bindingId: binding.bindingId, definition: { id: binding.id ?? 'fixture:use', version: 1 }, config: {} })),
})

describe('interaction source rejection', () => {
  it('rejects the v5 manifest outside its own version and over the file limit', () => {
    expect(() => parseWorldPackSourceManifestV5({ sourceSchemaVersion: 'worldpack-source/v4' }))
      .toThrow(/must be worldpack-source\/v5/u)
    // V4 accepts exactly 512 declared files; the interaction file is the one that tips it over.
    const one = (name: string) => [name]
    expect(() => parseWorldPackSourceManifestV5({
      sourceSchemaVersion: 'worldpack-source/v5', packId: 'pack:limit', packVersion: '1.0.0',
      worldFile: 'world.json',
      characterFiles: one('characters.json'), locationFiles: one('locations.json'), entityFiles: one('entities.json'),
      sceneFiles: one('scenes.json'), playerSlotFiles: one('players.json'), presentationFiles: one('presentation.json'),
      cognitionFiles: one('cognition.json'), memoryFiles: one('memory.json'), documentFiles: one('documents.json'),
      markdownFiles: one('readme.md'), assertionFiles: one('assertions.json'),
      reactionFile: 'reaction.json', manifestationFile: 'manifestation.json', interactionFile: 'interactions.json',
      assetFiles: Array.from({ length: 498 }, (_, index) => `asset-${index}.bin`),
    })).toThrow(/at most 512 files/u)
  })

  it('rejects target and selection documents outside their own version', () => {
    expect(() => parseWorldPackEntitiesSourceV2({ schemaVersion: 'worldpack-entities/v1', entities: [] }))
      .toThrow(/must equal worldpack-entities\/v2/u)
    expect(() => parseWorldPackCharactersSourceV3({ schemaVersion: 'worldpack-characters/v2', characters: [] }))
      .toThrow(/must equal worldpack-characters\/v3/u)
    expect(() => parseWorldPackInteractionsSource({ schemaVersion: 'worldpack-interactions/v2', packages: [], definitions: [] }))
      .toThrow(/must equal worldpack-interactions\/v1/u)
  })

  it('rejects target files beyond their count limits', () => {
    expect(() => parseWorldPackEntitiesSourceV2({
      schemaVersion: 'worldpack-entities/v2',
      entities: Array.from({ length: 513 }, (_, index) => ({ entityId: `entity:${index}`, locationId: 'location:hall', kind: 'cup' })),
    })).toThrow(/at most 512 entities/u)
    expect(() => parseWorldPackCharactersSourceV3({
      schemaVersion: 'worldpack-characters/v3',
      characters: Array.from({ length: 257 }, (_, index) => ({
        characterId: `character:${index}`, displayName: `C${index}`, initialLocationId: 'location:hall',
      })),
    })).toThrow(/at most 256 characters/u)
  })

  it('rejects a duplicated binding id on one target and an unknown field', () => {
    expect(() => parseWorldPackEntitiesSourceV2({
      schemaVersion: 'worldpack-entities/v2',
      entities: [entity([{ bindingId: 'binding:same' }, { bindingId: 'binding:same' }])],
    })).toThrow(/duplicate/u)
    expect(() => parseWorldPackEntitiesSourceV2({
      schemaVersion: 'worldpack-entities/v2',
      entities: [{ entityId: 'entity:cup', locationId: 'location:hall', kind: 'cup', privileged: true }],
    })).toThrow(/is not allowed/u)
  })

  it('rejects a selection beyond the package and definition limits', () => {
    const selection = (packages: unknown[], definitions: unknown[]) => ({ schemaVersion: 'worldpack-interactions/v1', packages, definitions })
    expect(() => parseWorldPackInteractionsSource(selection([], []))).toThrow(/at least one package/u)
    expect(() => parseWorldPackInteractionsSource(selection(
      Array.from({ length: 33 }, (_, index) => ({ id: `package:${index}`, version: 1 })), [],
    ))).toThrow(/at most 32 packages/u)
    expect(() => parseWorldPackInteractionsSource(selection([{ id: 'package:interactions-basic', version: 1 }],
      Array.from({ length: 129 }, (_, index) => ({ id: `base:${index}`, version: 1 }))))).toThrow(/at most 128 definitions/u)
    expect(() => parseWorldPackInteractionsSource(selection(
      [{ id: 'package:interactions-basic', version: 1 }, { id: 'package:interactions-basic', version: 1 }], [],
    ))).toThrow(/duplicate/u)
  })

  it('rejects a compiled catalog outside its own version and limits', () => {
    const catalog = (over: Record<string, unknown>) => ({ version: 'interaction-catalog/v3', packages: [], definitions: [], bindings: [], ...over })
    const lock = { ref: { id: 'package:interactions-basic', version: 1 }, implementationHash: `sha256:${'a'.repeat(64)}`, dependencies: [] }
    expect(() => parseInteractionCatalogV3(catalog({ version: 'interaction-catalog/v2' }))).toThrow(/interaction-catalog\/v3/u)
    expect(() => parseInteractionCatalogV3(catalog({}))).toThrow(/at least one package/u)
    expect(() => parseInteractionCatalogV3(catalog({
      packages: Array.from({ length: 33 }, (_, index) => ({ ...lock, ref: { id: `package:${index}`, version: 1 } })),
    }))).toThrow(/at most 32 packages/u)
    expect(() => parseInteractionCatalogV3(catalog({
      packages: [lock],
      definitions: Array.from({ length: 129 }, (_, index) => ({
        ref: { id: `base:${index}`, version: 1 }, definitionHash: `sha256:${'b'.repeat(64)}`, implementationHash: `sha256:${'c'.repeat(64)}`,
      })),
    }))).toThrow(/at most 128 definitions/u)
    expect(() => parseInteractionCatalogV3(catalog({
      packages: [lock],
      bindings: Array.from({ length: 4097 }, (_, index) => ({
        bindingId: `binding:${index}`, targetRef: { kind: 'entity', id: 'entity:cup' },
        definitionRef: { id: 'base:take', version: 1 }, config: {},
      })),
    }))).toThrow(/at most 4096 bindings/u)
  })

  it('rejects a package description that cannot name a definition', () => {
    const broken = packageDescription('package:interactions-basic', [definition('fixture:use')])
    const selection = { schemaVersion: 'worldpack-interactions/v1' as const, packages: [{ id: 'package:interactions-basic', version: 1 }], definitions: [] }
    expect(() => compileInteractionCatalog(selection, [], [], [{
      lock: broken.lock,
      definitions: [{ spec: { versionTag: 'interaction-definition/v1' } as never, implementationHash: broken.definitions[0]!.implementationHash }],
    }])).toThrow(/must name a definition identity/u)
  })

  it('rejects an ambiguous or unselected definition provider', () => {
    const first = packageDescription('package:interactions-basic', [definition('fixture:use')])
    const second = packageDescription('package:other', [definition('fixture:use')])
    const selection = { schemaVersion: 'worldpack-interactions/v1' as const, packages: [{ id: 'package:interactions-basic', version: 1 }], definitions: [{ id: 'fixture:use', version: 1 }] }
    expect(() => compileInteractionCatalog(selection, [], [], [first, second])).toThrow(/duplicate installed definition/u)
    const elsewhere = packageDescription('package:elsewhere', [definition('fixture:other')])
    expect(() => compileInteractionCatalog({
      ...selection, definitions: [{ id: 'fixture:other', version: 1 }],
    }, [], [], [first, elsewhere])).toThrow(/did not select/u)
  })

  it('rejects more world bindings than the frozen limit', () => {
    const packages = [packageDescription('package:interactions-basic', [definition('fixture:use')])]
    const selection = { schemaVersion: 'worldpack-interactions/v1' as const, packages: [{ id: 'package:interactions-basic', version: 1 }], definitions: [{ id: 'fixture:use', version: 1 }] }
    const many = {
      entityId: 'entity:cup', locationId: 'location:hall', kind: 'cup',
      interactionBindings: Array.from({ length: 4097 }, (_, index) => ({
        bindingId: `binding:${index}`, definition: { id: 'fixture:use', version: 1 }, config: {},
      })),
    }
    expect(() => compileInteractionCatalog(selection, [many], [], packages)).toThrow(/at most 4096 bindings/u)
  })

  it('orders several selected packages canonically and carries their dependencies', () => {
    const alpha = packageDescription('package:alpha', [definition('fixture:alpha')], [{ id: 'base:rule', version: 1 }])
    const beta = packageDescription('package:beta', [definition('fixture:beta')])
    const selection = {
      schemaVersion: 'worldpack-interactions/v1' as const,
      packages: [{ id: 'package:beta', version: 1 }, { id: 'package:alpha', version: 1 }],
      definitions: [{ id: 'fixture:alpha', version: 1 }, { id: 'fixture:beta', version: 1 }],
    }
    const compiled = compileInteractionCatalog(
      selection,
      [{ entityId: 'entity:bare' } as never],
      [{ characterId: 'character:alice' } as never],
      [beta, alpha],
    )
    expect(compiled.packages.map(value => value.ref.id)).toEqual(['package:alpha', 'package:beta'])
    expect(compiled.packages[0]!.dependencies).toEqual([{ id: 'base:rule', version: 1 }])
  })

  it('rejects a compiled envelope that is not a v5 envelope', () => {
    expect(() => parseCompiledWorldPackV5({ compiledSchemaVersion: 'worldpack/v4' })).toThrow(/must be worldpack\/v5/u)
  })
})
