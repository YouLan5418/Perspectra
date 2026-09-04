import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { brandId, canonicalizeWorldJson } from '@harness-world/contracts'
import {
  WorldPackCompilerV3,
  canonicalWorldPackBytesV3,
  verifyCompiledWorldPackV3,
} from './compiler.ts'
import {
  parseCompiledWorldPackV3,
  parseWorldPackReactionSource,
  parseWorldPackSourceManifestV3,
} from './schema.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function source(mode: 'responsive' | 'disabled' = 'responsive'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'worldpack-v3-'))
  roots.push(root)
  await cp(fileURLToPath(new URL('../../../examples/world-packs/rainy-road-companions/', import.meta.url)), root, { recursive: true })
  const manifest = JSON.parse(await readFile(join(root, 'worldpack.source.json'), 'utf8')) as Record<string, unknown>
  await writeFile(join(root, 'worldpack.source.json'), canonicalizeWorldJson({
    ...manifest, sourceSchemaVersion: 'worldpack-source/v3', packId: 'pack:responsive-social', reactionFile: 'reaction.json',
  }))
  await writeFile(join(root, 'reaction.json'), canonicalizeWorldJson(mode === 'responsive'
    ? { schemaVersion: 'worldpack-reaction/v1', mode, profile: 'responsive/v1' }
    : { schemaVersion: 'worldpack-reaction/v1', mode }))
  return root
}

describe('WorldPackCompilerV3', () => {
  it('parses only the exact v3 source and Reaction shapes', () => {
    const base = {
      sourceSchemaVersion: 'worldpack-source/v3', packId: 'pack:test', packVersion: '1.0.0', worldFile: 'world.json',
      characterFiles: ['characters.json'], locationFiles: ['locations.json'], entityFiles: [], sceneFiles: ['scenes.json'],
      playerSlotFiles: ['player.json'], presentationFiles: ['presentation.json'], cognitionFiles: [], memoryFiles: [],
      documentFiles: [], markdownFiles: [], assetFiles: [], assertionFiles: [], reactionFile: 'reaction.json',
    }
    expect(parseWorldPackSourceManifestV3(base)).toEqual(base)
    expect(parseWorldPackReactionSource({ schemaVersion: 'worldpack-reaction/v1', mode: 'disabled' })).toEqual({
      schemaVersion: 'worldpack-reaction/v1', mode: 'disabled',
    })
    expect(parseWorldPackReactionSource({
      schemaVersion: 'worldpack-reaction/v1', mode: 'responsive', profile: 'responsive/v1',
    })).toEqual({ schemaVersion: 'worldpack-reaction/v1', mode: 'responsive', profile: 'responsive/v1' })
    for (const invalid of [
      { ...base, sourceSchemaVersion: 'worldpack-source/v2' },
      { ...base, unknown: true },
      { ...base, reactionFile: 'world.json' },
      { ...base, assetFiles: Array.from({ length: 506 }, (_, index) => `asset-${index}`) },
    ]) expect(() => parseWorldPackSourceManifestV3(invalid)).toThrow()
    for (const invalid of [
      { schemaVersion: 'wrong', mode: 'disabled' },
      { schemaVersion: 'wrong', mode: 'responsive', profile: 'responsive/v1' },
      { schemaVersion: 'worldpack-reaction/v1', mode: 'unknown', profile: 'responsive/v1' },
      { schemaVersion: 'worldpack-reaction/v1', mode: 'responsive', profile: 'wrong' },
      { schemaVersion: 'worldpack-reaction/v1', mode: 'disabled', profile: 'responsive/v1' },
    ]) expect(() => parseWorldPackReactionSource(invalid)).toThrow()
  })

  it.each(['responsive', 'disabled'] as const)('compiles %s deterministically and binds only its explicit policy', async mode => {
    const root = await source(mode)
    const compiler = new WorldPackCompilerV3()
    const first = await compiler.compile(root)
    const second = await compiler.compile(root)
    expect(second).toEqual(first)
    expect(first).toMatchObject({
      compiledSchemaVersion: 'worldpack/v3',
      compiler: { version: '0.3.0', contractVersion: 'worldpack-compiler/v3', limitsProfile: 'worldpack-limits/v2' },
      reaction: { schemaVersion: 'worldpack-reaction/v1', mode },
    })
    expect(verifyCompiledWorldPackV3(first)).toEqual(first)
    expect(parseCompiledWorldPackV3(first)).toEqual(first)
    expect(canonicalWorldPackBytesV3(first)).toEqual(canonicalizeWorldJson(first))
    const compiled = compiler.adaptToWorldSpec(first, {
      address: {
        tenantId: brandId('tenant:v3', 'TenantId'), worldId: brandId('world:v3', 'WorldId'),
        branchId: brandId('branch:main', 'BranchId'),
      },
      principalId: 'principal:player', sessionId: brandId('session:player', 'SessionId'),
    })
    expect(compiled.manifest).toMatchObject({
      schemaVersion: 5,
      reactionPolicy: mode === 'responsive'
        ? { version: 'reaction-policy/v1', mode: 'responsive', profile: 'responsive/v1' }
        : { version: 'reaction-policy/v1', mode: 'disabled' },
      runtimePolicy: { npcInitialAvailability: 'ready' },
    })
    expect(compiled.genesisEvents.at(-1)?.eventType).toBe('world.lifecycle-changed')
  })

  it('rejects profile changes, tampering, wrong compiler identity, and unavailable sources', async () => {
    const root = await source()
    const compiler = new WorldPackCompilerV3()
    await expect(compiler.compile(root, { limitsProfile: 'worldpack-limits/v1' as 'worldpack-limits/v2' })).rejects.toThrow()
    const pack = await compiler.compile(root)
    expect(() => verifyCompiledWorldPackV3({ ...pack, reaction: { ...pack.reaction, mode: 'disabled' } })).toThrow()
    expect(() => verifyCompiledWorldPackV3({ ...pack, packVersion: '1.0.1' })).toThrow('does not match the compiled v3 envelope content')
    expect(() => parseCompiledWorldPackV3({ ...pack, compiledSchemaVersion: 'worldpack/v2' })).toThrow()
    expect(() => parseCompiledWorldPackV3({ ...pack, compiler: { ...pack.compiler, version: '0.2.0' } })).toThrow()
    const charactersPath = join(root, 'characters.json')
    const characters = JSON.parse(await readFile(charactersPath, 'utf8')) as { characters: Array<{ lifecycle?: string }> }
    characters.characters[1]!.lifecycle = 'departed'
    await writeFile(charactersPath, canonicalizeWorldJson(characters))
    const nonActive = compiler.adaptToWorldSpec(await compiler.compile(root), {
      address: {
        tenantId: brandId('tenant:v3-non-active', 'TenantId'), worldId: brandId('world:v3-non-active', 'WorldId'),
        branchId: brandId('branch:main', 'BranchId'),
      },
      principalId: 'principal:player', sessionId: brandId('session:player', 'SessionId'),
    })
    expect(nonActive.genesisEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ eventType: 'character.lifecycle-changed' }),
    ]))
    await expect(compiler.compile(join(root, 'absent'))).rejects.toThrow('cannot open source directory')
  })
})
