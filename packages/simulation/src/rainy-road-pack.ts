import { fileURLToPath } from 'node:url'
import { brandId, type WorldAddress } from '@harness-world/contracts'
import type { CompiledWorldSpec } from '@harness-world/kernel'
import {
  WorldPackCompilerV2,
  type CompiledWorldPackV2,
} from '@harness-world/world-pack'

export const RAINY_ROAD_IDS = Object.freeze({
  player: brandId('character:player', 'CharacterId'),
  alice: brandId('character:alice', 'CharacterId'),
  bob: brandId('character:bob', 'CharacterId'),
  principal: 'principal:rainy-road-player',
  session: brandId('session:rainy-road-player', 'SessionId'),
  shelter: 'location:road-shelter',
  station: 'location:station-platform',
  tickets: 'entity:ticket-bundle',
})

/** Repository-owned Phase 8 acceptance content. It contains no executable scenario code. */
export function rainyRoadSourceDirectory(): string {
  return fileURLToPath(new URL('../../../examples/world-packs/rainy-road-companions/', import.meta.url))
}

/** Compile the reference content through the public creator-facing v2 compiler. */
export function compileRainyRoadPack(sourceDirectory = rainyRoadSourceDirectory()): Promise<CompiledWorldPackV2> {
  return new WorldPackCompilerV2().compile(sourceDirectory)
}

/** Bind the immutable artifact to a runtime address without adding fixture-only Events. */
export function adaptRainyRoadPack(pack: CompiledWorldPackV2, address: WorldAddress): CompiledWorldSpec {
  return new WorldPackCompilerV2().adaptToWorldSpec(pack, {
    address,
    principalId: RAINY_ROAD_IDS.principal,
    sessionId: RAINY_ROAD_IDS.session,
  })
}
