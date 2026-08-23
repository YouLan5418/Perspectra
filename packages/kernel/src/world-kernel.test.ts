import { Context } from '@deepseek-ai/cordis'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { hashWorldJson, WorldError } from '@harness-world/contracts'
import { WorldRuntimeRegistry, type BranchComponentFactory } from '@harness-world/runtime-cordis'
import { BranchAdministration, RoundInbox, WorldStore, WriterLeaseService } from '@harness-world/store-sqlite'
import {
  currentEntityState,
  SpeakMoveRulebook,
} from './rulebook.ts'
import { createCoreRulebookRegistry, RulebookRegistry } from './rulebook-registry.ts'
import { WorldBootstrap } from './world-bootstrap.ts'
import { parsePlayerRoundResult, WorldKernel } from './world-kernel.ts'
import { WorldSpecCompiler } from './world-spec.ts'

const directories: string[] = []

function database(name: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'hcw-world-kernel-'))
  directories.push(directory)
  return join(directory, name)
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function compiled() {
  return new WorldSpecCompiler().compile({
    schemaVersion: 1,
    address: { tenantId: 'tenant:kernel', worldId: 'world:kernel', branchId: 'branch:main' },
    timeMode: 'TURN_DRIVEN',
    roundQueueLimit: 8,
    rulebook: { rulebookId: 'builtin:speak-move', version: 1 },
    locations: [
      { locationId: 'location:a', name: 'Alpha' },
      { locationId: 'location:b', name: 'Beta' },
    ],
    characters: [{ characterId: 'character:player', name: 'Player', locationId: 'location:a' }],
    playerBindings: [{ principalId: 'principal:player', characterId: 'character:player', sessionId: 'session:player' }],
    plugins: [],
  })
}

async function runtimeFor(manifestHash: ReturnType<typeof hashWorldJson>) {
  const factory: BranchComponentFactory = {
    create: () => ({ kernel: {}, store: {}, agents: {}, director: {} }),
  }
  const registry = new WorldRuntimeRegistry(new Context(), factory)
  const lease = await registry.acquire(compiled().manifest.address, manifestHash)
  return { registry, lease }
}

describe('SpeakMoveRulebook', () => {
  it('resolves exact core versions and fails closed without fallback', () => {
    const world = compiled()
    const registry = createCoreRulebookRegistry()
    const v1 = registry.resolve('builtin:speak-move', 1, 'registry:v1')
    const context = {
      manifest: world.manifest,
      events: [{ eventType: 'character.created', data: { characterId: 'character:player', locationId: 'location:a' } }],
      characterId: 'character:player',
    }
    expect(v1.affordances(context)).toEqual([
      { actionType: 'speak', actionVersion: 1 },
      { actionType: 'move', actionVersion: 1 },
    ])
    expect(v1.resolve({ ...context, action: { actionType: 'speak', parameters: { text: 'registered' } } }).status).toBe('accepted')
    const v2 = registry.resolve('builtin:speak-move', 2, 'registry:v2')
    expect(v2.affordances({ ...context, manifest: { ...world.manifest, rulebook: { ...world.manifest.rulebook, version: 2 } } }))
      .toContainEqual({ actionType: 'take', actionVersion: 1 })
    expect(() => registry.resolve('builtin:speak-move', 3, 'registry:missing', world.manifest.address))
      .toThrowError(expect.objectContaining<Partial<WorldError>>({ envelope: expect.objectContaining({
        errorCode: 'RULEBOOK_NOT_REGISTERED', retryable: false,
        details: { rulebookId: 'builtin:speak-move', version: 3 },
      }) }))
    expect(() => registry.resolve('builtin:speak-move', 3, 'registry:missing-no-address')).toThrow(WorldError)
    const custom = new RulebookRegistry()
    custom.register('custom:fixture', 1, v1)
    expect(custom.resolve('custom:fixture', 1, 'registry:custom')).toBe(v1)
    expect(() => custom.register('custom:fixture', 1, v1)).toThrow('duplicate')
    expect(() => custom.register('', 1, v1)).toThrow(TypeError)
    expect(() => custom.register('custom:bad', 0, v1)).toThrow(TypeError)
  })

  it('resolves speech, movement without history, and every rejection shape', () => {
    const world = compiled()
    const rulebook = new SpeakMoveRulebook()
    const history = [{ eventType: 'character.created', data: { characterId: 'character:player', locationId: 'location:a' } }]
    const spoken = rulebook.resolve(world.manifest, history, 'character:player', { actionType: 'speak', parameters: { text: 'hello' } })
    expect(spoken).toMatchObject({ status: 'accepted', events: [{ eventType: 'character.speak', data: { text: 'hello' } }] })
    expect(rulebook.resolve(world.manifest, history, 'character:player', { actionType: 'speak', parameters: null }).status).toBe('rejected')
    expect(rulebook.resolve(world.manifest, history, 'character:player', { actionType: 'speak', parameters: { text: '' } }).status).toBe('rejected')
    const moved = rulebook.resolve(world.manifest, history, 'character:player', { actionType: 'move', parameters: { locationId: 'location:b' } })
    expect(moved.events[0]?.data).toMatchObject({ fromLocationId: 'location:a', toLocationId: 'location:b' })
    expect(rulebook.resolve(world.manifest, [{ eventType: 'character.created', data: { characterId: 'character:player' } }], 'character:player', {
      actionType: 'move', parameters: { locationId: 'location:b' },
    }).events[0]?.data).toMatchObject({ fromLocationId: null })
    expect(rulebook.resolve(world.manifest, history, 'character:player', { actionType: 'move', parameters: [] }).status).toBe('rejected')
    expect(rulebook.resolve(world.manifest, history, 'character:player', { actionType: 'move', parameters: { locationId: 1 } }).status).toBe('rejected')
    expect(rulebook.resolve(world.manifest, history, 'character:player', { actionType: 'wait', parameters: {} }).status).toBe('rejected')
    expect(rulebook.resolve(world.manifest, [], 'character:player', { actionType: 'speak', parameters: { text: 'no actor' } }).status).toBe('rejected')
    for (const lifecycleState of ['incapacitated', 'dead', 'departed'] as const) {
      expect(rulebook.resolve(world.manifest, [...history, {
        eventType: 'character.lifecycle-changed', data: { characterId: 'character:player', lifecycleState },
      }], 'character:player', { actionType: 'speak', parameters: { text: 'blocked' } })).toMatchObject({
        status: 'rejected', reason: `character lifecycle ${lifecycleState} cannot act`,
      })
    }
  })

  it('takes an available manifest entity once under Rulebook v2', () => {
    const base = compiled().manifest
    const manifest = {
      ...base,
      rulebook: { rulebookId: 'builtin:speak-move' as const, version: 2 as const },
      entities: [{ entityId: 'entity:key', locationId: 'location:a', kind: 'key' }],
    }
    const rulebook = new SpeakMoveRulebook()
    const history = [
      { eventType: 'character.created', data: { characterId: 'character:player', locationId: 'location:a' } },
      { eventType: 'entity.upsert', data: { entityId: 'entity:key', locationId: 'location:a', kind: 'key' } },
    ]
    expect(currentEntityState(history, 'entity:missing')).toBeUndefined()
    expect(currentEntityState(history, 'entity:key')).toEqual({
      entityId: 'entity:key', locationId: 'location:a', holderId: null, kind: 'key',
    })
    const taken = rulebook.resolve(manifest, history, 'character:player', {
      actionType: 'take', parameters: { entityId: 'entity:key' },
    })
    expect(taken).toMatchObject({
      status: 'accepted',
      events: [{ eventType: 'entity.taken', data: { entityId: 'entity:key', characterId: 'character:player' } }],
    })
    const after = [...history, ...taken.events]
    expect(currentEntityState(after, 'entity:key')).toEqual({
      entityId: 'entity:key', locationId: null, holderId: 'character:player', kind: 'key',
    })
    expect(() => currentEntityState([
      { eventType: 'entity.upsert', data: { entityId: 'entity:key', locationId: null, kind: 'key' } },
    ], 'entity:key')).toThrow('malformed')
    expect(() => currentEntityState([
      { eventType: 'entity.taken', data: { entityId: 'entity:key', characterId: 'character:player', fromLocationId: 'location:a' } },
    ], 'entity:key')).toThrow('violates')
    expect(() => currentEntityState([...history, {
      eventType: 'entity.taken', data: { entityId: 'entity:key', characterId: 1, fromLocationId: 'location:a' },
    }], 'entity:key')).toThrow('violates')
    expect(() => currentEntityState([...history, {
      eventType: 'entity.taken', data: { entityId: 'entity:key', characterId: 'character:player', fromLocationId: 'location:b' },
    }], 'entity:key')).toThrow('violates')
    expect(() => currentEntityState([...after, ...taken.events], 'entity:key')).toThrow('violates')
    expect(rulebook.resolve(manifest, after, 'character:player', {
      actionType: 'take', parameters: { entityId: 'entity:key' },
    })).toMatchObject({ status: 'rejected', reason: 'ITEM_NOT_AVAILABLE' })
    expect(rulebook.resolve(manifest, history, 'character:player', {
      actionType: 'take', parameters: { entityId: 'entity:missing' },
    })).toMatchObject({ status: 'rejected', reason: 'take requires a manifest entityId' })
    expect(rulebook.resolve(manifest, history, 'character:player', {
      actionType: 'take', parameters: null,
    })).toMatchObject({ status: 'rejected', reason: 'take requires a manifest entityId' })
    expect(rulebook.resolve(base, history, 'character:player', {
      actionType: 'take', parameters: { entityId: 'entity:key' },
    })).toMatchObject({ status: 'rejected', reason: 'action type is not afforded by the V0 Rulebook' })
    expect(rulebook.resolve(manifest, [
      ...history,
      { eventType: 'character.moved', data: { characterId: 'character:player', toLocationId: 'location:b' } },
    ], 'character:player', {
      actionType: 'take', parameters: { entityId: 'entity:key' },
    })).toMatchObject({ status: 'rejected', reason: 'ITEM_NOT_AVAILABLE' })
  })

})

describe('WorldKernel', () => {
  it('strictly parses durable completed Round results', () => {
    const valid = {
      status: 'accepted',
      reason: null,
      headSeq: 1,
      tick: 1,
      bundleHash: `sha256:${'a'.repeat(64)}`,
    } as const
    expect(parsePlayerRoundResult(valid)).toEqual(valid)
    for (const invalid of [
      null,
      [],
      'result',
      { ...valid, extra: true },
      { ...valid, status: 'committed' },
      { ...valid, reason: 1 },
      { ...valid, headSeq: 1.5 },
      { ...valid, headSeq: -1 },
      { ...valid, tick: 1.5 },
      { ...valid, tick: -1 },
      { ...valid, bundleHash: null },
      { ...valid, bundleHash: 'sha256:short' },
    ]) expect(() => parsePlayerRoundResult(invalid as never)).toThrow(TypeError)
  })

  it('commits authorized speak/move/rejections without an Agent and replays after restart', async () => {
    const path = database('kernel.sqlite')
    const world = compiled()
    const store = new WorldStore(path)
    new WorldBootstrap(store).activate(world)
    const runtime = await runtimeFor(world.manifestHash)
    const inbox = new RoundInbox(path)
    const leases = new WriterLeaseService(path)
    const kernel = new WorldKernel({ store, inbox, leases, runtimeLane: runtime.lease.slot, ownerId: 'kernel:first' })
    const genesis = store.head(world.manifest.address)
    expect(() => kernel.submitPlayerInput({
      idempotencyKey: 'unauthorized',
      principalId: 'principal:other',
      action: { actionType: 'speak', parameters: { text: 'no' } },
      correlationId: 'unauthorized',
    })).toThrow('no PlayerBinding')
    expect(() => kernel.submitPlayerInput({
      idempotencyKey: '',
      principalId: 'principal:player',
      action: { actionType: 'speak', parameters: { text: 'no' } },
      correlationId: 'invalid',
    })).toThrow(TypeError)
    expect(() => kernel.submitPlayerInput({
      idempotencyKey: 'invalid-principal-type',
      principalId: 1 as never,
      action: { actionType: 'speak', parameters: { text: 'no' } },
      correlationId: 'invalid',
    })).toThrow('principalId must be a string')
    expect(() => kernel.submitPlayerInput({
      idempotencyKey: 'invalid-action-shape',
      principalId: 'principal:player',
      action: { actionType: 'speak', parameters: {}, extra: true } as never,
      correlationId: 'invalid',
    })).toThrow('exactly')
    expect(store.head(world.manifest.address)).toEqual(genesis)

    inbox.enqueue({
      address: world.manifest.address,
      idempotencyKey: 'prior',
      principalId: 'principal:player',
      input: { actionType: 'speak', parameters: { text: 'prior' } },
      correlationId: 'prior',
    }, 8)
    const spoken = await kernel.submitPlayerInput({
      idempotencyKey: 'speak:1',
      principalId: 'principal:player',
      action: { actionType: 'speak', parameters: { text: 'hello' } },
      correlationId: 'speak',
    })
    expect(spoken).toMatchObject({ status: 'accepted', tick: 2 })
    expect(await kernel.submitPlayerInput({
      idempotencyKey: 'speak:1',
      principalId: 'principal:player',
      action: { actionType: 'speak', parameters: { text: 'hello' } },
      correlationId: 'retry',
    })).toEqual(spoken)
    expect(() => kernel.submitPlayerInput({
      idempotencyKey: 'speak:1',
      principalId: 'principal:player',
      action: { actionType: 'speak', parameters: { text: 'changed' } },
      correlationId: 'conflict',
    })).toThrow('different player input')
    const administration = new BranchAdministration(path)
    administration.setAdmission(world.manifest.address, 'draining', 'retry proof', 'kernel:draining')
    expect(await kernel.submitPlayerInput({
      idempotencyKey: 'speak:1',
      principalId: 'principal:player',
      action: { actionType: 'speak', parameters: { text: 'hello' } },
      correlationId: 'draining-retry',
    })).toEqual(spoken)
    expect(() => kernel.submitPlayerInput({
      idempotencyKey: 'draining:new',
      principalId: 'principal:player',
      action: { actionType: 'speak', parameters: { text: 'new' } },
      correlationId: 'draining-new',
    })).toThrow('branch admission is draining')
    administration.setAdmission(world.manifest.address, 'open', 'resume', 'kernel:open')
    administration.close()

    const moved = await kernel.submitPlayerInput({
      idempotencyKey: 'move:1',
      principalId: 'principal:player',
      action: { actionType: 'move', parameters: { locationId: 'location:b' } },
      correlationId: 'move',
    })
    expect(moved).toMatchObject({ status: 'accepted', tick: 3 })
    const same = await kernel.submitPlayerInput({
      idempotencyKey: 'move:same',
      principalId: 'principal:player',
      action: { actionType: 'move', parameters: { locationId: 'location:b' } },
      correlationId: 'move-same',
    })
    expect(same).toMatchObject({ status: 'rejected', tick: 4 })
    const unknown = await kernel.submitPlayerInput({
      idempotencyKey: 'move:unknown',
      principalId: 'principal:player',
      action: { actionType: 'move', parameters: { locationId: 'location:missing' } },
      correlationId: 'move-unknown',
    })
    expect(unknown).toMatchObject({ status: 'rejected', tick: 5 })
    const unsupported = await kernel.submitPlayerInput({
      idempotencyKey: 'unsupported',
      principalId: 'principal:player',
      action: { actionType: 'dance', parameters: {} },
      correlationId: 'unsupported',
    })
    expect(unsupported).toMatchObject({ status: 'rejected', tick: 6 })
    const eventHashes = store.readEvents(world.manifest.address).map(event => event.eventHash)
    kernel.close()
    kernel.close()
    await expect(kernel.submitPlayerInput({
      idempotencyKey: 'closed',
      principalId: 'principal:player',
      action: { actionType: 'speak', parameters: { text: 'closed' } },
      correlationId: 'closed',
    })).rejects.toThrow('closed')
    inbox.close()
    leases.close()
    store.close()
    await runtime.lease.dispose()

    const restartedStore = new WorldStore(path)
    const restartedRuntime = await runtimeFor(world.manifestHash)
    const restartedInbox = new RoundInbox(path)
    const restartedLeases = new WriterLeaseService(path)
    const restarted = new WorldKernel({
      store: restartedStore,
      inbox: restartedInbox,
      leases: restartedLeases,
      runtimeLane: restartedRuntime.lease.slot,
      ownerId: 'kernel:second',
    })
    expect(await restarted.submitPlayerInput({
      idempotencyKey: 'speak:1',
      principalId: 'principal:player',
      action: { actionType: 'speak', parameters: { text: 'hello' } },
      correlationId: 'restart-retry',
    })).toEqual(spoken)
    expect(restartedStore.readEvents(world.manifest.address).map(event => event.eventHash)).toEqual(eventHashes)
    restarted.close()
    restartedInbox.close()
    restartedLeases.close()
    restartedStore.close()
    await restartedRuntime.lease.dispose()
  })

  it('recovers a commit made before Inbox completion using the same transaction hash', async () => {
    const path = database('post-commit-recovery.sqlite')
    const world = compiled()
    const setup = new WorldStore(path)
    new WorldBootstrap(setup).activate(world)
    setup.close()
    const runtime = await runtimeFor(world.manifestHash)
    const faultingStore = new WorldStore(path, { hit(point) { if (point === 'store.after-commit') throw new Error('after commit') } })
    const inbox = new RoundInbox(path)
    const leases = new WriterLeaseService(path)
    const kernel = new WorldKernel({ store: faultingStore, inbox, leases, runtimeLane: runtime.lease.slot, ownerId: 'kernel:fault' })
    const request = {
      idempotencyKey: 'recover:1',
      principalId: 'principal:player',
      action: { actionType: 'speak', parameters: { text: 'durable' } },
      correlationId: 'recover',
    } as const
    await expect(kernel.submitPlayerInput(request)).rejects.toThrow('after commit')
    const committedHead = faultingStore.head(world.manifest.address)
    kernel.close()
    inbox.close()
    leases.close()
    faultingStore.close()
    await runtime.lease.dispose()

    const recoveredRuntime = await runtimeFor(world.manifestHash)
    const recoveredStore = new WorldStore(path)
    const recoveredInbox = new RoundInbox(path)
    const recoveredLeases = new WriterLeaseService(path)
    const recovered = new WorldKernel({
      store: recoveredStore,
      inbox: recoveredInbox,
      leases: recoveredLeases,
      runtimeLane: recoveredRuntime.lease.slot,
      ownerId: 'kernel:recovered',
    })
    const result = await recovered.submitPlayerInput(request)
    expect(result.headSeq).toBe(committedHead.headSeq)
    expect(recoveredStore.head(world.manifest.address)).toEqual(committedHead)
    recovered.close()
    recoveredInbox.close()
    recoveredLeases.close()
    recoveredStore.close()
    await recoveredRuntime.lease.dispose()
  })

  it('fails closed for missing manifests, slot mismatch, lost Inbox items, and corrupted principals', async () => {
    const world = compiled()
    const missingPath = database('missing-manifest.sqlite')
    const missingStore = new WorldStore(missingPath)
    missingStore.createBranch(world.manifest.address)
    const missingRuntime = await runtimeFor(world.manifestHash)
    const missingInbox = new RoundInbox(missingPath)
    const missingLeases = new WriterLeaseService(missingPath)
    expect(() => new WorldKernel({
      store: missingStore,
      inbox: missingInbox,
      leases: missingLeases,
      runtimeLane: missingRuntime.lease.slot,
      ownerId: 'kernel:missing',
    })).toThrow('not active')
    missingInbox.close()
    missingLeases.close()
    missingStore.close()
    await missingRuntime.lease.dispose()

    const mismatchPath = database('mismatch.sqlite')
    const mismatchStore = new WorldStore(mismatchPath)
    new WorldBootstrap(mismatchStore).activate(world)
    const mismatchRuntime = await runtimeFor(hashWorldJson('wrong-manifest', 1))
    const mismatchInbox = new RoundInbox(mismatchPath)
    const mismatchLeases = new WriterLeaseService(mismatchPath)
    expect(() => new WorldKernel({
      store: mismatchStore,
      inbox: mismatchInbox,
      leases: mismatchLeases,
      runtimeLane: mismatchRuntime.lease.slot,
      ownerId: 'kernel:mismatch',
    })).toThrow('not active')
    mismatchInbox.close()
    mismatchLeases.close()
    mismatchStore.close()
    await mismatchRuntime.lease.dispose()

    const lostPath = database('lost.sqlite')
    const lostStore = new WorldStore(lostPath)
    new WorldBootstrap(lostStore).activate(world)
    const lostRuntime = await runtimeFor(world.manifestHash)
    const lostInbox = new RoundInbox(lostPath)
    const lostLeases = new WriterLeaseService(lostPath)
    const lostKernel = new WorldKernel({ store: lostStore, inbox: lostInbox, leases: lostLeases, runtimeLane: lostRuntime.lease.slot, ownerId: 'kernel:lost' })
    const lostPromise = lostKernel.submitPlayerInput({
      idempotencyKey: 'lost:1', principalId: 'principal:player',
      action: { actionType: 'speak', parameters: { text: 'lost' } }, correlationId: 'lost',
    })
    expect(() => lostInbox.claimNext(world.manifest.address, 'intruder', 999))
      .toThrow('current Writer Lease')
    const lostRaw = new DatabaseSync(lostPath)
    lostRaw.prepare(`DELETE FROM round_inbox WHERE idempotency_key = 'lost:1'`).run()
    lostRaw.close()
    await expect(lostPromise).rejects.toThrow('lost admitted item')
    lostKernel.close()
    lostInbox.close()
    lostLeases.close()
    lostStore.close()
    await lostRuntime.lease.dispose()

    const corruptPath = database('corrupt-principal.sqlite')
    const corruptStore = new WorldStore(corruptPath)
    new WorldBootstrap(corruptStore).activate(world)
    const corruptRuntime = await runtimeFor(world.manifestHash)
    const corruptInbox = new RoundInbox(corruptPath)
    const corruptLeases = new WriterLeaseService(corruptPath)
    const corruptKernel = new WorldKernel({ store: corruptStore, inbox: corruptInbox, leases: corruptLeases, runtimeLane: corruptRuntime.lease.slot, ownerId: 'kernel:corrupt' })
    corruptInbox.enqueue({
      address: world.manifest.address,
      idempotencyKey: 'corrupt:1',
      principalId: 'principal:deleted',
      input: { actionType: 'speak', parameters: { text: 'corrupt' } },
      correlationId: 'corrupt',
    }, 8)
    await expect(corruptKernel.submitPlayerInput({
      idempotencyKey: 'target:1', principalId: 'principal:player',
      action: { actionType: 'speak', parameters: { text: 'target' } }, correlationId: 'target',
    })).rejects.toThrow('lost its PlayerBinding')
    corruptKernel.close()
    corruptInbox.close()
    corruptLeases.close()
    corruptStore.close()
    await corruptRuntime.lease.dispose()
  })
})
