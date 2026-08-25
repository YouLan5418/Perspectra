import { readFile } from 'node:fs/promises'
import {
  brandId,
  hashWorldJson,
} from '@harness-world/contracts'
import {
  WorldPackCompiler,
  verifyCompiledWorldPack,
} from './compiler.ts'
import type {
  WorldPackInspection,
  WorldPackTestReport,
} from './contracts.ts'
import { parseStrictWorldJson } from './strict-json.ts'

async function readCompiledPack(path: string) {
  const bytes = await readFile(path)
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch (error: unknown) {
    throw new TypeError(`compiled Pack must be valid UTF-8: ${String(error)}`)
  }
  return verifyCompiledWorldPack(parseStrictWorldJson(text, path))
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
    const compiler = new WorldPackCompiler()
    const pack = await compiler.compile(sourceDirectory)
    const compiled = compiler.adaptToWorldSpec(pack, {
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
