import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { WorldError, brandId, hashWorldJson, type WorldAddress } from '@harness-world/contracts'
import { BranchRuntimeSlot, WorldRuntimeRegistry } from './runtime.ts'

function fixtureAddress(branch = 'main'): WorldAddress {
  return {
    tenantId: brandId('tenant:test', 'TenantId'),
    worldId: brandId('world:test', 'WorldId'),
    branchId: brandId(`branch:${branch}`, 'BranchId'),
  }
}

describe('WorldRuntimeRegistry', () => {
  it('isolates services, listeners, effects, and disposal by branch', async () => {
    const root = new Context()
    const registry = new WorldRuntimeRegistry(root)
    const manifest = hashWorldJson('manifest', { version: 1 })
    const leaseA = await registry.acquire(fixtureAddress('a'), manifest)
    const leaseA2 = await registry.acquire(fixtureAddress('a'), manifest)
    const leaseB = await registry.acquire(fixtureAddress('b'), manifest)
    expect(leaseA2.slot).toBe(leaseA.slot)
    expect(leaseA2.fencingToken).toBe(leaseA.fencingToken)
    expect(leaseB.slot).not.toBe(leaseA.slot)
    expect(leaseA.slot.services.kernel).not.toBe(leaseB.slot.services.kernel)
    expect(registry.activeSlotCount).toBe(2)

    leaseA.slot.emitProbe('a-only')
    leaseB.slot.emitProbe('b-only')
    expect(leaseA.slot.services.kernel.records).toEqual(['a-only'])
    expect(leaseB.slot.services.kernel.records).toEqual(['b-only'])

    await leaseA.dispose()
    await leaseA.dispose()
    expect(registry.activeSlotCount).toBe(2)
    await leaseA2.dispose()
    expect(registry.activeSlotCount).toBe(1)
    expect(() => leaseA.slot.emitProbe('disposed')).toThrow('disposed')
    await leaseA.slot.dispose()
    await leaseB.dispose()
    expect(registry.activeSlotCount).toBe(0)
  })

  it('rejects a manifest mismatch and removes failed mounts', async () => {
    const root = new Context()
    const registry = new WorldRuntimeRegistry(root)
    const address = fixtureAddress('manifest')
    const lease = await registry.acquire(address, hashWorldJson('manifest', 1))
    await expect(registry.acquire(address, hashWorldJson('manifest', 2))).rejects.toBeInstanceOf(WorldError)
    await lease.dispose()

    const failure = vi.spyOn(BranchRuntimeSlot, 'create').mockRejectedValueOnce(new Error('mount failed'))
    await expect(registry.acquire(fixtureAddress('failed'), hashWorldJson('manifest', 1))).rejects.toThrow('mount failed')
    expect(registry.activeSlotCount).toBe(0)
    failure.mockRestore()
  })
})
