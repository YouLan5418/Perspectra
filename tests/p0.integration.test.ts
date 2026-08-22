import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterAll, describe, expect, it } from 'vitest'
import { brandId, canonicalizeWorldJson, hashWorldJson } from '@harness-world/contracts'
import { WorldRuntimeRegistry } from '@harness-world/runtime-cordis'
import { WorldSimulation } from '@harness-world/simulation'
import { ProjectionRebuilder, SessionDeliveryAdapter, WorldStore } from '@harness-world/store-sqlite'
import { fixtureAddress, fixtureDeliveryRequest } from '@harness-world/testkit'

const directory = mkdtempSync(join(tmpdir(), 'hcw-p0-'))
afterAll(() => rmSync(directory, { recursive: true, force: true }))

describe('Phase 0 acceptance path', () => {
  it('passes the six prototype contracts without a model or network', async () => {
    const root = new Context()
    const registry = new WorldRuntimeRegistry(root, {
      create: scope => ({ kernel: { address: scope.address }, store: {}, agents: {}, director: {} }),
    })
    const manifestHash = hashWorldJson('manifest', { version: 1 })
    const branchA = await registry.acquire(fixtureAddress('integration-a'), manifestHash)
    const branchB = await registry.acquire(fixtureAddress('integration-b'), manifestHash)
    expect(branchA.slot.services.kernel.component).toBe(branchA.slot.components.kernel)
    expect(branchA.slot.components.kernel).not.toBe(branchB.slot.components.kernel)
    await branchA.dispose()
    await branchB.dispose()

    const session = new SessionDeliveryAdapter(join(directory, 'session.sqlite'))
    expect((await session.appendIfAbsent(fixtureDeliveryRequest())).status).toBe('applied')
    expect((await session.appendIfAbsent(fixtureDeliveryRequest())).status).toBe('already_applied')
    session.close()

    const canonical = Buffer.from(canonicalizeWorldJson({ z: 1, a: 'e\u0301' })).toString()
    expect(canonical).toBe('{"a":"é","z":1}')

    const worldPath = join(directory, 'world.sqlite')
    const world = new WorldStore(worldPath)
    const address = fixtureAddress('integration-world')
    world.createBranch(address)
    const simulation = new WorldSimulation({
      store: world,
      address,
      playerCharacterId: brandId('character:player', 'CharacterId'),
      playerSessionId: brandId('session:player', 'SessionId'),
    })
    const round = await simulation.submitPlayerMessage({ idempotencyKey: 'integration', text: 'hello' })
    const forkSeq = round.commit.headSeq
    const child = fixtureAddress('integration-child')
    world.forkBranch(address, child, forkSeq)
    const bundle = new ProjectionRebuilder(world).rebuildAt(child, forkSeq)
    expect(bundle.observations).toHaveLength(1)
    const committedHash = round.commit.bundleHash
    world.close()

    const restarted = new WorldStore(worldPath)
    const replay = await new WorldSimulation({
      store: restarted,
      address,
      playerCharacterId: brandId('character:player', 'CharacterId'),
      playerSessionId: brandId('session:player', 'SessionId'),
    }).submitPlayerMessage({ idempotencyKey: 'integration', text: 'hello' })
    expect(replay.commit.bundleHash).toBe(committedHash)
    expect(replay.commit.status).toBe('already_committed')
    restarted.close()
  })
})
