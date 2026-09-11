import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  brandId,
  hashWorldJson,
} from '@harness-world/contracts'
import {
  WorldPackCompilerV2,
  WorldPackCompilerV3,
  WorldPackCompilerV4,
  WorldPackCompiler,
  canonicalWorldPackBytes,
  canonicalWorldPackBytesV2,
  canonicalWorldPackBytesV3,
  canonicalWorldPackBytesV4,
  verifyCompiledWorldPack,
  verifyCompiledWorldPackV2,
  verifyCompiledWorldPackV3,
  verifyCompiledWorldPackV4,
} from './compiler.ts'
import type {
  CompiledWorldPack,
  CompiledWorldPackV2,
  CompiledWorldPackV3,
  CompiledWorldPackV4,
  WorldPackRuntimeOptions,
  WorldPackInspection,
  WorldPackTestReport,
} from './contracts.ts'
import {
  WORLD_PACK_COMPILED_SCHEMA_VERSION_V2,
  WORLD_PACK_COMPILED_SCHEMA_VERSION_V3,
  WORLD_PACK_COMPILED_SCHEMA_VERSION_V4,
  WORLD_PACK_SOURCE_SCHEMA_VERSION,
  WORLD_PACK_SOURCE_SCHEMA_VERSION_V2,
  WORLD_PACK_SOURCE_SCHEMA_VERSION_V3,
  WORLD_PACK_SOURCE_SCHEMA_VERSION_V4,
} from './contracts.ts'
import { parseStrictWorldJson } from './strict-json.ts'
import { failWorldPackContract } from './diagnostics.ts'

export type AnyCompiledWorldPack = CompiledWorldPack | CompiledWorldPackV2 | CompiledWorldPackV3 | CompiledWorldPackV4

export async function readStrictJson(path: string): Promise<import('@harness-world/contracts').WorldJsonValue> {
  const bytes = await readFile(path)
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch (error: unknown) {
    throw new TypeError(`World Pack document must be valid UTF-8: ${String(error)}`)
  }
  return parseStrictWorldJson(text, path)
}

function isV2CompiledPack(input: unknown): boolean {
  return (input as { readonly compiledSchemaVersion?: unknown } | null)?.compiledSchemaVersion
    === WORLD_PACK_COMPILED_SCHEMA_VERSION_V2
}

function schemaVersion(input: unknown): unknown {
  return (input as { readonly compiledSchemaVersion?: unknown } | null)?.compiledSchemaVersion
}

/** Select a frozen compiler only from the explicit source schema version. */
export async function compileWorldPackSource(sourceDirectory: string): Promise<AnyCompiledWorldPack> {
  const manifest = await readStrictJson(join(sourceDirectory, 'worldpack.source.json'))
  const version = (manifest as { readonly sourceSchemaVersion?: unknown } | null)?.sourceSchemaVersion
  if (version === WORLD_PACK_SOURCE_SCHEMA_VERSION_V4) return await new WorldPackCompilerV4().compile(sourceDirectory)
  if (version === WORLD_PACK_SOURCE_SCHEMA_VERSION_V3) return await new WorldPackCompilerV3().compile(sourceDirectory)
  if (version === WORLD_PACK_SOURCE_SCHEMA_VERSION_V2) return await new WorldPackCompilerV2().compile(sourceDirectory)
  if (version === WORLD_PACK_SOURCE_SCHEMA_VERSION) return await new WorldPackCompiler().compile(sourceDirectory)
  failWorldPackContract('PACK_SOURCE_INVALID', 'worldpack.source.json', '/sourceSchemaVersion', 'World Pack source schema version is unsupported')
}

/** Verify either frozen compiled envelope without implicit conversion between versions. */
async function readCompiledPack(path: string): Promise<AnyCompiledWorldPack> {
  const input = await readStrictJson(path)
  if (schemaVersion(input) === WORLD_PACK_COMPILED_SCHEMA_VERSION_V4) return verifyCompiledWorldPackV4(input)
  if (schemaVersion(input) === WORLD_PACK_COMPILED_SCHEMA_VERSION_V3) return verifyCompiledWorldPackV3(input)
  if (isV2CompiledPack(input)) return verifyCompiledWorldPackV2(input)
  return verifyCompiledWorldPack(input)
}

/** Bind the immutable envelope through its exact versioned compiler. */
export function adaptCompiledWorldPack(pack: AnyCompiledWorldPack, options: WorldPackRuntimeOptions) {
  if (options.interactionCatalog !== undefined) {
    if (pack.compiledSchemaVersion !== WORLD_PACK_COMPILED_SCHEMA_VERSION_V4) throw new TypeError('object interactions require a v4 Pack')
    const catalogVersion = (options.interactionCatalog as { readonly version?: unknown } | null)?.version
    return catalogVersion === 'interaction-catalog/v2'
      ? new WorldPackCompilerV4().adaptToCharacterInteractionWorldSpec(pack, options)
      : new WorldPackCompilerV4().adaptToInteractionWorldSpec(pack, options)
  }
  if (options.actionGroups !== undefined) {
    if (options.actionGroups !== 'bounded/v1' || pack.compiledSchemaVersion !== WORLD_PACK_COMPILED_SCHEMA_VERSION_V4) throw new TypeError('bounded action groups require a v4 Pack')
    return new WorldPackCompilerV4().adaptToActionGroupWorldSpec(pack, options)
  }
  if (pack.compiledSchemaVersion === WORLD_PACK_COMPILED_SCHEMA_VERSION_V4) {
    return new WorldPackCompilerV4().adaptToWorldSpec(pack, options)
  }
  if (pack.compiledSchemaVersion === WORLD_PACK_COMPILED_SCHEMA_VERSION_V3) {
    return new WorldPackCompilerV3().adaptToWorldSpec(pack, options)
  }
  return pack.compiledSchemaVersion === WORLD_PACK_COMPILED_SCHEMA_VERSION_V2
    ? new WorldPackCompilerV2().adaptToWorldSpec(pack, options)
    : new WorldPackCompiler().adaptToWorldSpec(pack, options)
}

/** Serialize either immutable envelope with its own canonical verifier. */
export function canonicalCompiledWorldPackBytes(pack: AnyCompiledWorldPack): Uint8Array {
  if (pack.compiledSchemaVersion === WORLD_PACK_COMPILED_SCHEMA_VERSION_V4) return canonicalWorldPackBytesV4(pack)
  if (pack.compiledSchemaVersion === WORLD_PACK_COMPILED_SCHEMA_VERSION_V3) return canonicalWorldPackBytesV3(pack)
  return pack.compiledSchemaVersion === WORLD_PACK_COMPILED_SCHEMA_VERSION_V2
    ? canonicalWorldPackBytesV2(pack)
    : canonicalWorldPackBytes(pack)
}

/** Read-only immutable artifact summary; source directories are never consulted. */
export class WorldPackInspector {
  async inspect(compiledPackPath: string): Promise<WorldPackInspection> {
    const pack = await readCompiledPack(compiledPackPath)
    return {
      packId: pack.packId,
      packVersion: pack.packVersion,
      packHash: pack.packHash,
      title: pack.content.world.title,
      characterCount: pack.content.characters.length,
      locationCount: pack.content.locations.length,
      entityCount: pack.content.entities.length,
      assertionCount: pack.acceptanceAssertions.length,
      pluginLocks: pack.pluginLocks,
      ...(pack.compiledSchemaVersion === WORLD_PACK_COMPILED_SCHEMA_VERSION_V3
        || pack.compiledSchemaVersion === WORLD_PACK_COMPILED_SCHEMA_VERSION_V4 ? { reaction: {
        mode: pack.reaction.mode,
        profile: pack.reaction.mode === 'responsive' ? pack.reaction.profile : null,
        maximumWaves: 3 as const,
        maximumNpcCalls: 8 as const,
        maximumCallsPerCharacter: 2 as const,
        maximumActionsPerCall: 1 as const,
        maximumNpcSpeechesPerPlayerInput: 8 as const,
        deadlineMs: 30_000 as const,
      } } : {}),
      ...(pack.compiledSchemaVersion === WORLD_PACK_COMPILED_SCHEMA_VERSION_V4
        ? { manifestation: pack.manifestation }
        : {}),
    }
  }
}

/** Deterministic compile/adapt test; declared runtime assertions remain Testkit inputs. */
export class WorldPackTestRunner {
  async run(sourceDirectory: string): Promise<WorldPackTestReport> {
    const pack = await compileWorldPackSource(sourceDirectory)
    const compiled = adaptCompiledWorldPack(pack, {
      address: {
        tenantId: brandId('tenant:world-pack-test', 'TenantId'),
        worldId: brandId('world:world-pack-test', 'WorldId'),
        branchId: brandId('branch:main', 'BranchId'),
      },
      principalId: 'principal:world-pack-test',
      sessionId: brandId('session:world-pack-test', 'SessionId'),
    })
    const assertionIds = pack.acceptanceAssertions.map(assertion => assertion.assertionId)
    return {
      status: 'compiled',
      assertionsExecuted: 0,
      packId: pack.packId,
      packVersion: pack.packVersion,
      packHash: pack.packHash,
      manifestHash: compiled.manifestHash,
      genesisHash: compiled.genesisHash,
      assertionPlanHash: hashWorldJson('world-pack-acceptance-plan/v1', pack.acceptanceAssertions),
      assertionIds,
    }
  }
}

export { readCompiledPack }
