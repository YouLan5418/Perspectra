import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { brandId } from '@harness-world/contracts'
import { WorldBootstrap, WorldSpecCompiler, type CompiledWorldSpec, type RoundExecutionLane } from '@harness-world/kernel'
import {
  BranchAdministration,
  CharacterRuntimeAvailabilityService,
  RoundInbox,
  SessionDeliveryAdapter,
  SessionOutboxWorker,
  WorldOutbox,
  WorldStore,
  WriterLeaseService,
} from '@harness-world/store-sqlite'
import { BranchOperationCoordinator, type CriticalDeliveryDrainPort } from './branch-operation-coordinator.ts'
import { RoundCoordinator } from './round-coordinator.ts'

const directories: string[] = []

function paths(): { world: string; session: string } {
  const directory = mkdtempSync(join(tmpdir(), 'hcw-branch-operation-'))
  directories.push(directory)
  return { world: join(directory, 'world.sqlite'), session: join(directory, 'session.sqlite') }
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function compiled(): CompiledWorldSpec {
  return new WorldSpecCompiler().compile({
    schemaVersion: 1,
    address: { tenantId: 'tenant:operations', worldId: 'world:operations', branchId: 'branch:main' },
    timeMode: 'TURN_DRIVEN',
    roundQueueLimit: 8,
    rulebook: { rulebookId: 'builtin:speak-move', version: 1 },
    locations: [{ locationId: 'location:room', name: 'Room' }],
    characters: [{ characterId: 'character:player', name: 'Player', locationId: 'location:room' }],
    playerBindings: [{ principalId: 'principal:player', characterId: 'character:player', sessionId: 'session:player' }],
    plugins: [],
  })
}

function lane(world: CompiledWorldSpec): RoundExecutionLane {
  let tail: Promise<void> = Promise.resolve()
  return {
    address: world.manifest.address,
    manifestHash: world.manifestHash,
    enqueueRound<T>(work: () => Promise<T>): Promise<T> {
      const result = tail.then(work, work)
      tail = result.then(() => undefined, () => undefined)
      return result
    },
  }
}

function coordinator(path: string, world: CompiledWorldSpec) {
  const store = new WorldStore(path)
  const inbox = new RoundInbox(path)
  const leases = new WriterLeaseService(path)
  const availability = new CharacterRuntimeAvailabilityService(path)
  availability.initialize(world.manifest.address, world.manifest.characters.map(value => ({ characterId: value.characterId, state: 'ready' })))
  const rounds = new RoundCoordinator({
    store,
    inbox,
    leases,
    availability,
    runtimeLane: lane(world),
    ownerId: 'coordinator:operations',
    participants: [],
    modelBudgetTokens: 0,
  })
  return { store, inbox, leases, availability, rounds }
}

function enqueueAccepted(inbox: RoundInbox, world: CompiledWorldSpec, idempotencyKey: string): void {
  inbox.enqueue({
    address: world.manifest.address,
    idempotencyKey,
    principalId: 'principal:player',
    input: { actionType: 'speak', parameters: { text: idempotencyKey } },
    correlationId: idempotencyKey,
  }, 8)
}

describe('BranchOperationCoordinator', () => {
  it('reopens a drained source after fork failure but keeps it draining when Round drain fails', async () => {
    const path = paths().world
    const world = compiled()
    const setup = new WorldStore(path)
    new WorldBootstrap(setup).activate(world)
    const child = { ...world.manifest.address, branchId: brandId('branch:occupied', 'BranchId') }
    setup.createBranch(child)
    setup.close()
    const runtime = coordinator(path, world)
    const administration = new BranchAdministration(path)
    const operations = new BranchOperationCoordinator(runtime.store, administration, runtime.rounds, {
      drainCritical: async () => 0,
    })
    await expect(operations.forkAtHead({
      parent: world.manifest.address,
      child,
      reason: 'occupied child',
      correlationId: 'fork:occupied',
    })).rejects.toThrow()
    expect(administration.status(world.manifest.address).admissionState).toBe('open')
    await expect(runtime.rounds.submit({
      idempotencyKey: 'after-compensation', principalId: 'principal:player',
      action: { actionType: 'speak', parameters: { text: 'still open' } }, correlationId: 'after-compensation',
    })).resolves.toMatchObject({ status: 'accepted' })

    const failingDrain = new BranchOperationCoordinator(runtime.store, administration, {
      drainAccepted: async () => { throw new Error('drain integrity failure') },
      close: () => undefined,
    }, { drainCritical: async () => 0 })
    await expect(failingDrain.forkAtHead({
      parent: world.manifest.address,
      child: { ...world.manifest.address, branchId: brandId('branch:not-created', 'BranchId') },
      reason: 'failed drain',
      correlationId: 'fork:failed-drain',
    })).rejects.toThrow('drain integrity failure')
    expect(administration.status(world.manifest.address).admissionState).toBe('draining')
    administration.setAdmission(world.manifest.address, 'open', 'prepare compensation failure', 'fork:prepare-compensation')
    class FailingCompensationAdministration extends BranchAdministration {
      override setAdmission(...args: Parameters<BranchAdministration['setAdmission']>) {
        if (args[1] === 'open') throw new Error('compensation failed')
        return super.setAdmission(...args)
      }
    }
    const failingCompensation = new FailingCompensationAdministration(path)
    const uncompensated = new BranchOperationCoordinator(runtime.store, failingCompensation, runtime.rounds, {
      drainCritical: async () => 0,
    })
    await expect(uncompensated.forkAtHead({
      parent: world.manifest.address,
      child,
      reason: 'force compensation failure',
      correlationId: 'fork:compensation-failure',
    })).rejects.toThrow('could not be reopened')
    failingCompensation.close()
    runtime.rounds.close()
    runtime.inbox.close()
    runtime.availability.close()
    runtime.leases.close()
    administration.close()
    runtime.store.close()
  })

  it('closes admission, drains accepted FIFO work, forks at the resulting head, and reopens the source', async () => {
    const path = paths().world
    const world = compiled()
    const setup = new WorldStore(path)
    new WorldBootstrap(setup).activate(world)
    setup.close()
    const runtime = coordinator(path, world)
    enqueueAccepted(runtime.inbox, world, 'accepted-before-fork')
    const administration = new BranchAdministration(path)
    const operations = new BranchOperationCoordinator(runtime.store, administration, runtime.rounds, {
      drainCritical: async () => 0,
    })
    const child = { ...world.manifest.address, branchId: brandId('branch:child', 'BranchId') }
    expect(() => runtime.store.forkDrainedBranch(world.manifest.address, child, runtime.store.head(world.manifest.address).headSeq))
      .toThrow('requires admission state draining')
    const result = await operations.forkAtHead({
      parent: world.manifest.address,
      child,
      reason: 'create checkpoint branch',
      correlationId: 'operation:fork',
    })
    expect(result).toMatchObject({ drainedRounds: 1, parentState: { admissionState: 'open', lifecycleState: 'active' } })
    expect(runtime.store.head(child)).toEqual(runtime.store.head(world.manifest.address))
    expect(result.forkSeq).toBe(runtime.store.head(child).headSeq)
    const childHead = runtime.store.head(child)
    const childRounds = new RoundCoordinator({
      store: runtime.store,
      inbox: runtime.inbox,
      leases: runtime.leases,
      availability: runtime.availability,
      runtimeLane: { ...lane(world), address: child },
      ownerId: 'coordinator:child',
      participants: [],
      modelBudgetTokens: 0,
    })
    await expect(childRounds.submit({
      idempotencyKey: 'child-round', principalId: 'principal:player',
      action: { actionType: 'speak', parameters: { text: 'child continues' } }, correlationId: 'child-round',
    })).resolves.toMatchObject({ tick: 2 })
    expect(runtime.store.head(child).headSeq).toBeGreaterThan(childHead.headSeq)
    expect(runtime.store.head(world.manifest.address).headSeq).toBe(childHead.headSeq)
    await expect(runtime.rounds.submit({
      idempotencyKey: 'after-fork', principalId: 'principal:player',
      action: { actionType: 'speak', parameters: { text: 'source continues' } }, correlationId: 'after-fork',
    })).resolves.toMatchObject({ tick: 2 })
    childRounds.close()
    runtime.rounds.close()
    runtime.inbox.close()
    runtime.availability.close()
    runtime.leases.close()
    administration.close()
    runtime.store.close()
  })

  it('drains Round and critical Outbox work, releases the writer, then archives irreversibly', async () => {
    const path = paths()
    const world = compiled()
    const setup = new WorldStore(path.world)
    new WorldBootstrap(setup).activate(world)
    setup.close()
    const runtime = coordinator(path.world, world)
    enqueueAccepted(runtime.inbox, world, 'accepted-before-archive')
    const administration = new BranchAdministration(path.world)
    const outbox = new WorldOutbox(path.world, undefined, {
      workerId: 'worker:branch-operation',
      createClaimToken: () => 'branch-operation',
    })
    const session = new SessionDeliveryAdapter(path.session)
    const worker = new SessionOutboxWorker(outbox, session, world.manifest.address)
    const deliveries: CriticalDeliveryDrainPort = {
      async drainCritical(correlationId: string): Promise<number> {
        let count = 0
        while (true) {
          const result = await worker.runOnce(correlationId)
          if (result.status === 'idle') return count
          if (result.status !== 'delivered') throw new Error(`critical delivery ended as ${result.status}`)
          count += 1
        }
      },
    }
    const operations = new BranchOperationCoordinator(runtime.store, administration, runtime.rounds, deliveries)
    const result = await operations.archive({
      address: world.manifest.address,
      reason: 'story complete',
      correlationId: 'operation:archive',
    })
    expect(result).toMatchObject({
      drainedRounds: 1,
      drainedDeliveries: 1,
      state: { admissionState: 'draining', lifecycleState: 'archived' },
    })
    expect(session.cursor(brandId('session:player', 'SessionId'))).toBe(1)
    await expect(runtime.rounds.drainAccepted('after-archive')).rejects.toThrow('closed')
    await expect(runtime.rounds.submit({
      idempotencyKey: 'after-archive', principalId: 'principal:player',
      action: { actionType: 'speak', parameters: { text: 'blocked' } }, correlationId: 'after-archive',
    })).rejects.toThrow('closed')
    outbox.close()
    session.close()
    runtime.inbox.close()
    runtime.availability.close()
    runtime.leases.close()
    administration.close()
    runtime.store.close()
  })
})
