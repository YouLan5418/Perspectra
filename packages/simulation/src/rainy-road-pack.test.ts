import { cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { brandId, PHASE8_REGISTRY_LOCKS, PHASE8_VOCABULARY_LOCKS } from '@harness-world/contracts'
import { WorldBootstrap } from '@harness-world/kernel'
import { CognitionProjectionRebuilder, WorldStore } from '@harness-world/store-sqlite'
import {
  RAINY_ROAD_IDS,
  adaptRainyRoadPack,
  compileRainyRoadPack,
  rainyRoadSourceDirectory,
} from './rainy-road-pack.ts'

const roots: string[] = []

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'rainy-road-pack-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('Phase 8 rainy-road acceptance Pack source', () => {
  it('compiles a stable non-specialized Manifest v4 and cognition boundary', async () => {
    const source = await temporaryRoot()
    await cp(rainyRoadSourceDirectory(), source, { recursive: true })
    const pack = await compileRainyRoadPack(source)
    expect(pack).toMatchObject({
      compiledSchemaVersion: 'worldpack/v2',
      packId: 'pack:rainy-road-companions',
      packVersion: '1.0.0',
      content: {
        world: { title: '雨夜同行' },
        characters: [
          { characterId: RAINY_ROAD_IDS.alice },
          { characterId: RAINY_ROAD_IDS.bob },
          { characterId: RAINY_ROAD_IDS.player },
        ],
      },
      vocabularyLocks: PHASE8_VOCABULARY_LOCKS,
      registryLocks: PHASE8_REGISTRY_LOCKS,
    })
    expect(pack.packHash).toBe('sha256:9796276f19488bdc7d94a59f6c728ef5134d32ce5abfe0b8458e992f9601f08b')
    expect(JSON.stringify(pack)).not.toMatch(/investigation|evidence|accuse|travel_action/iu)

    const address = {
      tenantId: brandId('tenant:rainy-road', 'TenantId'),
      worldId: brandId('world:rainy-road', 'WorldId'),
      branchId: brandId('branch:main', 'BranchId'),
    }
    const compiled = adaptRainyRoadPack(pack, address)
    expect(compiled.manifest).toMatchObject({
      schemaVersion: 4,
      rulebook: { rulebookId: 'builtin:speak-move', version: 2 },
      contentPack: {
        runtimeCapabilities: {
          cognitionProjectionVersion: 1,
          sceneDecisionVersion: 2,
          cognitiveMemoryVersion: 2,
          agentContextVersion: 2,
        },
      },
    })
    const store = new WorldStore(join(source, 'world.sqlite'))
    try {
      new WorldBootstrap(store).activate(compiled)
      const cognition = new CognitionProjectionRebuilder(store)
      const head = store.head(address)
      const alice = cognition.rebuildCharacterAt(address, RAINY_ROAD_IDS.alice, head.headSeq)
      const bob = cognition.rebuildCharacterAt(address, RAINY_ROAD_IDS.bob, head.headSeq)
      const player = cognition.rebuildCharacterAt(address, RAINY_ROAD_IDS.player, head.headSeq)
      expect(JSON.stringify(alice)).toContain('is_irresponsible')
      expect(JSON.stringify(alice)).toContain('competence')
      expect(JSON.stringify(alice)).toContain('honesty')
      expect(JSON.stringify(bob)).toContain('late_because_helped_injured_stranger')
      expect(JSON.stringify(alice)).not.toContain('late_because_helped_injured_stranger')
      expect(JSON.stringify(player)).not.toContain('late_because_helped_injured_stranger')
    } finally {
      store.close()
    }
  })

  it('does not depend on the repository source directory after compilation', async () => {
    const source = await temporaryRoot()
    await cp(rainyRoadSourceDirectory(), source, { recursive: true })
    const pack = await compileRainyRoadPack(source)
    await rm(source, { recursive: true, force: true })
    expect(adaptRainyRoadPack(pack, {
      tenantId: brandId('tenant:rainy-road-copy', 'TenantId'),
      worldId: brandId('world:rainy-road-copy', 'WorldId'),
      branchId: brandId('branch:main', 'BranchId'),
    }).manifest.contentPack?.packHash).toBe(pack.packHash)
  })
})
