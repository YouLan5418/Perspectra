import { readFile } from 'node:fs/promises'
import {
  brandId,
  hashWorldJson,
  type InteractionPackageDescription,
} from '@harness-world/contracts'
import {
  WorldPackCompilerV5,
  canonicalWorldPackBytesV5,
  verifyCompiledWorldPackV5,
} from './compiler.ts'
import type {
  CompiledWorldPackV5,
  WorldPackRuntimeOptions,
  WorldPackInspection,
  WorldPackTestReport,
} from './contracts.ts'
import { WORLD_PACK_LIMITS_PROFILE_V2 } from './contracts.ts'
import { parseStrictWorldJson } from './strict-json.ts'

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

/** Compile only the current v5 source format. */
export async function compileWorldPackSource(
  sourceDirectory: string,
  interactionPackages: readonly InteractionPackageDescription[] = [],
): Promise<CompiledWorldPackV5> {
  return await new WorldPackCompilerV5().compile(sourceDirectory, {
    limitsProfile: WORLD_PACK_LIMITS_PROFILE_V2, interactionPackages,
  })
}

/** Verify only the current immutable compiled envelope. */
async function readCompiledPack(path: string): Promise<CompiledWorldPackV5> {
  return verifyCompiledWorldPackV5(await readStrictJson(path))
}

/** Bind v5's frozen interaction selection to the current runtime. */
export function adaptCompiledWorldPack(pack: CompiledWorldPackV5, options: WorldPackRuntimeOptions) {
  if (options.interactionCatalog !== undefined || options.actionGroups !== undefined) {
    throw new TypeError('a compiled worldpack/v5 Pack carries its own interaction selection')
  }
  return new WorldPackCompilerV5().adaptToWorldSpec(pack, options)
}

/** Serialize the current immutable envelope. */
export function canonicalCompiledWorldPackBytes(pack: CompiledWorldPackV5): Uint8Array {
  return canonicalWorldPackBytesV5(pack)
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
      reaction: {
        mode: pack.reaction.mode,
        profile: pack.reaction.mode === 'responsive' ? pack.reaction.profile : null,
        maximumWaves: 3,
        maximumNpcCalls: 8,
        maximumCallsPerCharacter: 2,
        maximumActionsPerCall: 1,
        maximumNpcSpeechesPerPlayerInput: 8,
        deadlineMs: 30_000,
      },
      manifestation: pack.manifestation,
    }
  }
}

/** Compile/adapt test; declared runtime assertions remain Testkit inputs. */
export class WorldPackTestRunner {
  async run(sourceDirectory: string, interactionPackages: readonly InteractionPackageDescription[] = []): Promise<WorldPackTestReport> {
    const pack = await compileWorldPackSource(sourceDirectory, interactionPackages)
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
