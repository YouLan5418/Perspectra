import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { WorldError, brandId, hashWorldJson, type WorldAddress } from '@harness-world/contracts'
import {
  BranchRuntimeSlot,
  WorldRuntimeRegistry,
  type BranchComponentFactory,
  type BranchExecutionLane,
} from './runtime.ts'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /** @mode emit */
    'phase6/probe'(value: string): void
  }
}

class TestComponent {
  readonly records: string[] = []
  lifecycle: 'active' | 'closed' | 'disposed' = 'active'

  constructor(readonly ownerKey: string, readonly kind: string) {}

  dispose(): void {
    this.lifecycle = 'disposed'
  }
}

class CloseComponent {
  lifecycle: 'active' | 'closed' = 'active'

  close(): void {
    this.lifecycle = 'closed'
  }
}

function fixtureAddress(branch = 'main'): WorldAddress {
  return {
    tenantId: brandId('tenant:test', 'TenantId'),
    worldId: brandId('world:test', 'WorldId'),
    branchId: brandId(`branch:${branch}`, 'BranchId'),
  }
}

function componentFactory(
  created: Array<TestComponent | CloseComponent>,
  scopes: BranchExecutionLane[] = [],
): BranchComponentFactory {
  return {
    create(scope: BranchExecutionLane) {
      scopes.push(scope)
      const ownerKey = scope.address.branchId
      const kernel = new TestComponent(ownerKey, 'kernel')
      const store = new CloseComponent()
      const agents = new TestComponent(ownerKey, 'agents')
      const director = { ownerKey }
      created.push(kernel, store, agents)
      scope.context.on('phase6/probe', value => kernel.records.push(value))
      return { kernel, store, agents, director }
    },
  }
}

describe('WorldRuntimeRegistry', () => {
  it('isolates injected components, listeners, services, effects, and disposal by branch', async () => {
    const root = new Context()
    const created: Array<TestComponent | CloseComponent> = []
    const registry = new WorldRuntimeRegistry(root, componentFactory(created))
    const manifest = hashWorldJson('manifest', { version: 1 })
    const leaseA = await registry.acquire(fixtureAddress('a'), manifest)
    const leaseA2 = await registry.acquire(fixtureAddress('a'), manifest)
    const leaseB = await registry.acquire(fixtureAddress('b'), manifest)
    expect(leaseA2.slot).toBe(leaseA.slot)
    expect(leaseB.slot).not.toBe(leaseA.slot)
    expect(leaseA.slot.services.kernel).not.toBe(leaseB.slot.services.kernel)
    expect(leaseA.slot.services.kernel.component).toBe(leaseA.slot.components.kernel)
    expect(registry.activeSlotCount).toBe(2)

    leaseA.slot.context.emit(leaseA.slot.context, 'phase6/probe', 'a-only')
    leaseB.slot.context.emit(leaseB.slot.context, 'phase6/probe', 'b-only')
    expect((leaseA.slot.components.kernel as TestComponent).records).toEqual(['a-only'])
    expect((leaseB.slot.components.kernel as TestComponent).records).toEqual(['b-only'])

    await leaseA.dispose()
    await leaseA.dispose()
    expect(registry.activeSlotCount).toBe(2)
    await leaseA2.dispose()
    expect(registry.activeSlotCount).toBe(1)
    const beforeDisposedEmit = (leaseA.slot.components.kernel as TestComponent).records.slice()
    leaseA.slot.context.emit(leaseA.slot.context, 'phase6/probe', 'disposed')
    expect((leaseA.slot.components.kernel as TestComponent).records).toEqual(beforeDisposedEmit)
    expect((leaseA.slot.components.kernel as TestComponent).lifecycle).toBe('disposed')
    expect((leaseA.slot.components.store as CloseComponent).lifecycle).toBe('closed')
    expect((leaseA.slot.components.agents as TestComponent).lifecycle).toBe('disposed')
    await leaseA.slot.dispose()
    await leaseB.dispose()
    expect(registry.activeSlotCount).toBe(0)
    expect(created.every(component => component.lifecycle !== 'active')).toBe(true)
  })

  it('rejects a manifest mismatch and removes failed mounts', async () => {
    const root = new Context()
    const registry = new WorldRuntimeRegistry(root, componentFactory([]))
    const address = fixtureAddress('manifest')
    const lease = await registry.acquire(address, hashWorldJson('manifest', 1))
    await expect(registry.acquire(address, hashWorldJson('manifest', 2))).rejects.toBeInstanceOf(WorldError)
    await lease.dispose()

    const failure = vi.spyOn(BranchRuntimeSlot, 'create').mockRejectedValueOnce(new Error('mount failed'))
    await expect(registry.acquire(fixtureAddress('failed'), hashWorldJson('manifest', 1))).rejects.toThrow('mount failed')
    expect(registry.activeSlotCount).toBe(0)
    failure.mockRestore()
  })

  it('reserves a reference before awaiting an already-mounted slot', async () => {
    const root = new Context()
    const registry = new WorldRuntimeRegistry(root, componentFactory([]))
    const address = fixtureAddress('reservation')
    const manifest = hashWorldJson('manifest', 1)
    const first = await registry.acquire(address, manifest)
    const acquiring = registry.acquire(address, manifest)
    await first.dispose()
    const second = await acquiring
    expect(registry.activeSlotCount).toBe(1)
    await expect(second.slot.enqueueRound(async () => 'still-mounted')).resolves.toBe('still-mounted')
    await second.dispose()
    expect(registry.activeSlotCount).toBe(0)
  })

  it('runs each branch FIFO independently and continues after one rejected job', async () => {
    const root = new Context()
    const scopes: BranchExecutionLane[] = []
    const registry = new WorldRuntimeRegistry(root, componentFactory([], scopes))
    const manifest = hashWorldJson('manifest', 1)
    const lease = await registry.acquire(fixtureAddress('fifo'), manifest)
    const order: string[] = []
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const first = scopes[0]!.enqueueRound(async () => {
      order.push('first:start')
      await gate
      order.push('first:end')
      return 1
    })
    const second = lease.slot.enqueueRound(async () => {
      order.push('second')
      return 2
    })
    await Promise.resolve()
    expect(order).toEqual(['first:start'])
    release()
    await expect(Promise.all([first, second])).resolves.toEqual([1, 2])
    expect(order).toEqual(['first:start', 'first:end', 'second'])
    await expect(lease.slot.enqueueRound(async () => { throw new Error('job failed') })).rejects.toThrow('job failed')
    await expect(lease.slot.enqueueRound(async () => 3)).resolves.toBe(3)
    await lease.dispose()
    await expect(lease.slot.enqueueRound(async () => 4)).rejects.toThrow('disposed')
  })
})
