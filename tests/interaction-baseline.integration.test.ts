import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  PHASE8_REGISTRY_SET_HASH,
  PHASE8_VOCABULARY_REGISTRY_HASH,
  brandId,
  type WorldJsonValue,
} from '@harness-world/contracts'
import { CONTEXT_SCHEMA_VERSION } from '@harness-world/agents'
import { WORLD_SCHEMA_VERSION } from '@harness-world/store-sqlite'
import { adaptCompiledWorldPack, compileWorldPackSource } from '@harness-world/world-pack'

/**
 * Pre-I0 freeze for the interaction abstraction work.
 *
 * The proposal in docs/2026-09-13_方案-交互抽象与按需交互包-report.md promises that
 * Manifest v1-v9 keep their original compilation, protocols and Resolver, and that historical
 * Event / Authority / Hash values do not move. Its I0 gate requires the old golden data to be
 * frozen *before* any refactor, precisely so the values cannot be back-filled from a refactored
 * result later.
 *
 * Until this file existed nothing pinned the v7/v8/v9 hashes: the action group and interaction
 * suites assert behaviour, not bytes. Compiling one real example pack and pinning the four
 * adaptation outcomes gives the new workstream a reference that fails loudly instead of silently
 * reinterpreting an already compiled world.
 *
 * A failure here is not automatically a bug. It means a manifest shape or hash input changed, and
 * the compatibility matrix has to be re-derived deliberately rather than assumed.
 */

const source = fileURLToPath(new URL('../examples/world-packs/ai-girls-awaken/', import.meta.url))
const objectCatalog = fileURLToPath(new URL('../examples/world-packs/ai-girls-awaken.interactions.json', import.meta.url))
const characterCatalog = fileURLToPath(new URL('../examples/world-packs/ai-girls-awaken.character-interactions.json', import.meta.url))

const runtime = {
  address: {
    tenantId: brandId('tenant:interaction-baseline', 'TenantId'),
    worldId: brandId('world:interaction-baseline', 'WorldId'),
    branchId: brandId('branch:main', 'BranchId'),
  },
  principalId: 'principal:player',
  sessionId: brandId('session:interaction-baseline', 'SessionId'),
}

async function catalog(path: string): Promise<WorldJsonValue> {
  return JSON.parse(await readFile(path, 'utf8')) as WorldJsonValue
}

describe('interaction abstraction baseline', () => {
  it('keeps the compiled pack and every Manifest v6-v9 adaptation byte-identical', async () => {
    const pack = await compileWorldPackSource(source)
    expect(pack.packHash).toBe('sha256:a7423fe872937dcc4b29df75d6df2d7bc7977877e770dc9b4e2c69b4d3d9630c')

    const adapted = [
      { version: 6, spec: adaptCompiledWorldPack(pack, runtime),
        manifestHash: 'sha256:2a7335d102738e5bf362476425e51fc61869c30d4cb780430581edf18442350c',
        genesisHash: 'sha256:e6f9b6d848f0cb52ddfd6240e2c1e6ca6791315934a1c8abdf46fffaa4a056a8' },
      { version: 7, spec: adaptCompiledWorldPack(pack, { ...runtime, actionGroups: 'bounded/v1' }),
        manifestHash: 'sha256:08c9f0e9067b57ed839b4257e384ffa0fc8ec97c9e90d4ebc7bcc04403e34a67',
        genesisHash: 'sha256:0e237550283bfa5b6f46ec0cebd5a33682c04ec5e3ba8af848af9a7b884efb38' },
      { version: 8, spec: adaptCompiledWorldPack(pack, { ...runtime, interactionCatalog: await catalog(objectCatalog) }),
        manifestHash: 'sha256:8c3143a191fee7ac8ec4f22ddd41e8aba4c685be177ee2c1f73d5bee650748de',
        genesisHash: 'sha256:d274129643414f859dcff9892733fe8a7c6ae56338e2e07627ad64efcc3643f8' },
      { version: 9, spec: adaptCompiledWorldPack(pack, { ...runtime, interactionCatalog: await catalog(characterCatalog) }),
        manifestHash: 'sha256:cc57dca1a112f373d62fbcba9a3d515f8f78809d6c5822c6fe6816e2cf57e4fe',
        genesisHash: 'sha256:fb7d104f2403008af0f3e87e2abe53fda33ab7a7d79dc728421e9a0a4d5da2df' },
    ]
    for (const { version, spec, manifestHash, genesisHash } of adapted) {
      expect(spec.manifest.schemaVersion, `Manifest v${version} gate moved`).toBe(version)
      expect(spec.manifestHash, `Manifest v${version} manifestHash moved`).toBe(manifestHash)
      expect(spec.genesisHash, `Manifest v${version} genesisHash moved`).toBe(genesisHash)
    }
  }, 60_000)

  it('keeps the frozen registry and vocabulary hashes', () => {
    expect(PHASE8_REGISTRY_SET_HASH).toBe('sha256:a810b8d50789bcc664b62ba78d855690929c2ea1f4846e70ca8f20512eb0f0a1')
    expect(PHASE8_VOCABULARY_REGISTRY_HASH).toBe('sha256:6d9f4c810955104568d2d11176b92b8179ba40254ca55bef80b66b83363b7c93')
  })

  it('keeps the stored schema versions that already compiled worlds depend on', () => {
    // These are literals on purpose. Every other test asserts them through the exported constant,
    // which passes for any value, and that is how the two branches once moved CONTEXT_SCHEMA_VERSION
    // to 6 independently without any test noticing. A new workstream that needs a bump must change
    // this line in its own commit and state why.
    expect(WORLD_SCHEMA_VERSION).toBe(18)
    expect(CONTEXT_SCHEMA_VERSION).toBe(7)
  })
})
