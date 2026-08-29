import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  brandId,
  hashWorldJson,
} from '@harness-world/contracts'
import {
  WorldPackCompilerV2,
  WorldPackCompiler,
  canonicalWorldPackBytes,
  canonicalWorldPackBytesV2,
  verifyCompiledWorldPack,
  verifyCompiledWorldPackV2,
} from './compiler.ts'
import type {
  CompiledWorldPack,
  CompiledWorldPackV2,
  WorldPackRuntimeOptions,
  WorldPackInspection,
  WorldPackTestReport,
} from './contracts.ts'
import {
  WORLD_PACK_COMPILED_SCHEMA_VERSION_V2,
  WORLD_PACK_SOURCE_SCHEMA_VERSION_V2,
} from './contracts.ts'
import { parseStrictWorldJson } from './strict-json.ts'

export type AnyCompiledWorldPack = CompiledWorldPack | CompiledWorldPackV2

async function readStrictJson(path: string): Promise<unknown> {
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

/** Select a frozen compiler only from the explicit source schema version. */
export async function compileWorldPackSource(sourceDirectory: string): Promise<AnyCompiledWorldPack> {
  const manifest = await readStrictJson(join(sourceDirectory, 'worldpack.source.json'))
  return (manifest as { readonly sourceSchemaVersion?: unknown } | null)?.sourceSchemaVersion
    === WORLD_PACK_SOURCE_SCHEMA_VERSION_V2
    ? new WorldPackCompilerV2().compile(sourceDirectory)
    : new WorldPackCompiler().compile(sourceDirectory)
}

/** Verify either frozen compiled envelope without implicit conversion between versions. */
async function readCompiledPack(path: string): Promise<AnyCompiledWorldPack> {
  const input = await readStrictJson(path)
  return isV2CompiledPack(input) ? verifyCompiledWorldPackV2(input) : verifyCompiledWorldPack(input)
}

/** Bind the immutable envelope through its exact versioned compiler. */
export function adaptCompiledWorldPack(pack: AnyCompiledWorldPack, options: WorldPackRuntimeOptions) {
  return pack.compiledSchemaVersion === WORLD_PACK_COMPILED_SCHEMA_VERSION_V2
    ? new WorldPackCompilerV2().adaptToWorldSpec(pack, options)
    : new WorldPackCompiler().adaptToWorldSpec(pack, options)
}

/** Serialize either immutable envelope with its own canonical verifier. */
export function canonicalCompiledWorldPackBytes(pack: AnyCompiledWorldPack): Uint8Array {
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
