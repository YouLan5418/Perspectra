import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { brandId, canonicalizeWorldJson } from '@harness-world/contracts'
import { runtimeManifestFromStored } from '@harness-world/kernel'
import { adaptCompiledWorldPack } from './tooling.ts'
import {
  WorldPackCompilerV4,
  canonicalWorldPackBytesV4,
  verifyCompiledWorldPackV4,
} from './compiler.ts'
import {
  parseCompiledWorldPackV4,
  parseWorldPackManifestationSource,
  parseWorldPackSourceManifestV4,
} from './schema.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function source(mode: 'enabled' | 'disabled' = 'enabled'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'worldpack-v4-'))
  roots.push(root)
  await cp(fileURLToPath(new URL('../../../examples/world-packs/rainy-road-companions/', import.meta.url)), root, { recursive: true })
  const manifest = JSON.parse(await readFile(join(root, 'worldpack.source.json'), 'utf8')) as Record<string, unknown>
  await writeFile(join(root, 'worldpack.source.json'), canonicalizeWorldJson({
    ...manifest,
    sourceSchemaVersion: 'worldpack-source/v4',
    packId: 'pack:expressive-social',
    reactionFile: 'reaction.json',
    manifestationFile: 'manifestation.json',
  }))
  await writeFile(join(root, 'reaction.json'), canonicalizeWorldJson({
    schemaVersion: 'worldpack-reaction/v1', mode: 'responsive', profile: 'responsive/v1',
  }))
  await writeFile(join(root, 'manifestation.json'), canonicalizeWorldJson({
    schemaVersion: 'worldpack-manifestation/v1', mode,
  }))
  return root
}

describe('WorldPackCompilerV4', () => {
  it('parses only exact v4 source and manifestation documents', () => {
    const base = {
      sourceSchemaVersion: 'worldpack-source/v4', packId: 'pack:test', packVersion: '1.0.0', worldFile: 'world.json',
      characterFiles: ['characters.json'], locationFiles: ['locations.json'], entityFiles: [], sceneFiles: ['scenes.json'],
      playerSlotFiles: ['player.json'], presentationFiles: ['presentation.json'], cognitionFiles: [], memoryFiles: [],
      documentFiles: [], markdownFiles: [], assetFiles: [], assertionFiles: [], reactionFile: 'reaction.json',
      manifestationFile: 'manifestation.json',
    }
    expect(parseWorldPackSourceManifestV4(base)).toEqual(base)
    expect(parseWorldPackManifestationSource({ schemaVersion: 'worldpack-manifestation/v1', mode: 'enabled' }))
      .toEqual({ schemaVersion: 'worldpack-manifestation/v1', mode: 'enabled' })
    expect(parseWorldPackManifestationSource({ schemaVersion: 'worldpack-manifestation/v1', mode: 'disabled' }))
      .toEqual({ schemaVersion: 'worldpack-manifestation/v1', mode: 'disabled' })
    for (const invalid of [
      { ...base, sourceSchemaVersion: 'worldpack-source/v3' },
      { ...base, unknown: true },
      { ...base, manifestationFile: 'reaction.json' },
      { ...base, assetFiles: Array.from({ length: 505 }, (_, index) => `asset-${index}`) },
    ]) expect(() => parseWorldPackSourceManifestV4(invalid)).toThrow()
    for (const invalid of [
      { schemaVersion: 'wrong', mode: 'enabled' },
      { schemaVersion: 'worldpack-manifestation/v1', mode: 'unknown' },
      { schemaVersion: 'worldpack-manifestation/v1', mode: 'enabled', extra: true },
    ]) expect(() => parseWorldPackManifestationSource(invalid)).toThrow()
  })

  it.each(['enabled', 'disabled'] as const)('compiles %s deterministically and binds Manifest v6', async mode => {
    const root = await source(mode)
    const compiler = new WorldPackCompilerV4()
    const first = await compiler.compile(root)
    expect(await compiler.compile(root)).toEqual(first)
    expect(first).toMatchObject({
      compiledSchemaVersion: 'worldpack/v4',
      compiler: { version: '0.4.0', contractVersion: 'worldpack-compiler/v4', limitsProfile: 'worldpack-limits/v2' },
      reaction: { schemaVersion: 'worldpack-reaction/v1', mode: 'responsive' },
      manifestation: { schemaVersion: 'worldpack-manifestation/v1', mode },
    })
    expect(verifyCompiledWorldPackV4(first)).toEqual(first)
    expect(parseCompiledWorldPackV4(first)).toEqual(first)
    expect(canonicalWorldPackBytesV4(first)).toEqual(canonicalizeWorldJson(first))
    const compiled = compiler.adaptToWorldSpec(first, {
      address: {
        tenantId: brandId('tenant:v4', 'TenantId'), worldId: brandId('world:v4', 'WorldId'),
        branchId: brandId('branch:main', 'BranchId'),
      },
      principalId: 'principal:player', sessionId: brandId('session:player', 'SessionId'),
    })
    expect(compiled.manifest).toMatchObject({
      schemaVersion: 6,
      reactionPolicy: { version: 'reaction-policy/v1', mode: 'responsive', profile: 'responsive/v1' },
      manifestationPolicy: { version: 'manifestation-policy/v1', mode },
      registries: { events: { definitions: expect.arrayContaining([
        expect.objectContaining({ name: 'character.manifested' }),
      ]) } },
    })
    expect(compiled.genesisEvents.at(-1)?.eventType).toBe('world.lifecycle-changed')
    const options = { address: compiled.manifest.address, principalId: 'principal:player', sessionId: brandId('session:player', 'SessionId') }
    if (mode === 'enabled') {
      const interactionCatalog = { version: 'object-interactions/v1', definitions: [{ interactionId: 'custom:collect', label: '收下', operation: 'take' }], bindings: first.content.entities.map(entity => ({ entityId: entity.entityId, interactionIds: ['custom:collect'] })) }
      const interaction = compiler.adaptToInteractionWorldSpec(first, { ...options, interactionCatalog })
      expect(interaction.manifest.schemaVersion).toBe(8)
      expect(interaction.manifest.interactionCatalog).toEqual(interactionCatalog)
      expect(interaction.manifest.registries.actions.definitions.map(value => value.name)).toEqual(['interact', 'move', 'speak'])
      expect(compiler.adaptToInteractionWorldSpec(first, { ...options, interactionCatalog })).toEqual(interaction)
      expect(() => compiler.adaptToInteractionWorldSpec(first, options)).toThrow('catalog is required')
      const characterCatalog = { version: 'interaction-catalog/v2', definitions: [], bindings: [] }
      const characterWorld = compiler.adaptToCharacterInteractionWorldSpec(first, { ...options, interactionCatalog: characterCatalog })
      expect(characterWorld.manifest).toMatchObject({ schemaVersion: 9, playerInputPolicy: { version: 'legacy-speech/v1' } })
      expect(runtimeManifestFromStored(characterWorld.manifest)).toEqual(characterWorld.manifest)
      expect(adaptCompiledWorldPack(first, { ...options, interactionCatalog: characterCatalog })).toEqual(characterWorld)
      expect(() => compiler.adaptToCharacterInteractionWorldSpec(first, options)).toThrow('catalog is required')
      expect(() => compiler.adaptToCharacterInteractionWorldSpec(first, { ...options, interactionCatalog })).toThrow('require interaction-catalog/v2')
      const grouped = compiler.adaptToActionGroupWorldSpec(first, options)
      expect(grouped.manifest).toMatchObject({ schemaVersion: 7, actionGroupPolicy: { version: 'bounded-action-group/v1' } })
      expect(grouped.manifestHash).not.toBe(compiled.manifestHash)
      expect(grouped.genesisEvents.find(e => e.eventType === 'world.manifest-locked')?.data).toMatchObject({ manifestHash: grouped.manifestHash })
    } else expect(() => compiler.adaptToActionGroupWorldSpec(first, options)).toThrow('enabled manifestation')
  })

  it('rejects profile changes, tampering, wrong envelopes, and unavailable sources', async () => {
    const root = await source()
    const compiler = new WorldPackCompilerV4()
    await expect(compiler.compile(root, { limitsProfile: 'worldpack-limits/v1' as 'worldpack-limits/v2' })).rejects.toThrow()
    const pack = await compiler.compile(root)
    expect(() => verifyCompiledWorldPackV4({ ...pack, manifestation: { ...pack.manifestation, mode: 'disabled' } }))
      .toThrow('does not match the compiled v4 envelope content')
    expect(() => parseCompiledWorldPackV4({ ...pack, compiledSchemaVersion: 'worldpack/v3' })).toThrow()
    expect(() => parseCompiledWorldPackV4({ ...pack, compiler: { ...pack.compiler, version: '0.3.0' } })).toThrow()

    await writeFile(join(root, 'reaction.json'), canonicalizeWorldJson({
      schemaVersion: 'worldpack-reaction/v1', mode: 'disabled',
    }))
    const charactersPath = join(root, 'characters.json')
    const characters = JSON.parse(await readFile(charactersPath, 'utf8')) as { characters: Array<{ lifecycle?: string }> }
    characters.characters[1]!.lifecycle = 'departed'
    await writeFile(charactersPath, canonicalizeWorldJson(characters))
    const disabled = compiler.adaptToWorldSpec(await compiler.compile(root), {
      address: {
        tenantId: brandId('tenant:v4-disabled', 'TenantId'), worldId: brandId('world:v4-disabled', 'WorldId'),
        branchId: brandId('branch:main', 'BranchId'),
      },
      principalId: 'principal:player', sessionId: brandId('session:player', 'SessionId'),
    })
    expect(disabled.manifest).toMatchObject({ reactionPolicy: { mode: 'disabled' } })
    expect(disabled.genesisEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ eventType: 'character.lifecycle-changed' }),
    ]))
    await expect(compiler.compile(join(root, 'absent'))).rejects.toThrow('cannot open source directory')
  })
})
