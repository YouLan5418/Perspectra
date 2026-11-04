import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { hashWorldJson } from '@harness-world/contracts'
import { WorldApplication } from '@harness-world/application'
import { WorldStore } from '@harness-world/store-sqlite'
import { WorldBootstrap } from '@harness-world/kernel'
import { frozenInteractionWorld, basicInteractionPackage } from '../fixtures/frozen-interaction-world.ts'

it('opens, reads and reopens an empty interaction selection without models, memory or gameplay packages', async () => {
  const root = mkdtempSync(join(tmpdir(), 'minimal-core-probe-'))
  const worldPath = join(root, 'world.sqlite')
  const original = frozenInteractionWorld()
  const manifest = {
    ...original.manifest,
    plugins: [],
    interactionCatalog: { version: 'interaction-catalog/v3' as const, packages: [], definitions: [], bindings: [] },
  }
  const manifestHash = hashWorldJson('compiled-world-manifest', manifest)
  const genesisEvents = original.genesisEvents.map(event =>
    event.eventType === 'world.manifest-locked'
      ? { ...event, data: { ...(event.data as object), manifestHash } }
      : event,
  )
  const compiled = {
    ...original,
    manifest,
    manifestHash,
    genesisEvents,
    genesisHash: hashWorldJson('world-genesis-plan', genesisEvents),
  }
  const options = { worldPath, sessionPath: join(root, 'session.sqlite') }
  let app = new WorldApplication(options)
  try {
    app.activate(compiled)
    const store = new WorldStore(worldPath)
    try {
      expect(store.readManifest(manifest.address)).toBeDefined()
      expect(store.head(manifest.address).headSeq).toBeGreaterThan(0)
    } finally {
      store.close()
    }
    const before = await app.head(manifest.address)
    const result = await app.submit(manifest.address, {
      principalId: 'principal:player',
      idempotencyKey: 'minimal:speak',
      correlationId: 'minimal:speak',
      action: { actionType: 'speak', parameters: { text: '最小运行时的公开发言。' } },
    })
    expect(result.status).toBe('accepted')
    const head = await app.head(manifest.address)
    expect(head.tick).toBe(before.tick + 1)
    expect(
      (
        await app.characterViewForPrincipal(
          manifest.address,
          'principal:player',
          manifest.playerBindings[0]!.characterId,
        )
      ).locationId,
    ).toBe('location:room')
    await expect(
      app.characterViewForPrincipal(manifest.address, 'principal:intruder', manifest.playerBindings[0]!.characterId),
    ).rejects.toThrow('principal is not bound')
    await app.close()
    app = new WorldApplication(options)
    expect(await app.head(manifest.address)).toEqual(head)
    expect(existsSync(join(root, 'sources.sqlite'))).toBe(false)
  } finally {
    await app.close()
    rmSync(root, { recursive: true, force: true })
  }
})

it('still refuses a world selecting uninstalled interactions before genesis', async () => {
  const root = mkdtempSync(join(tmpdir(), 'minimal-core-refusal-'))
  const worldPath = join(root, 'world.sqlite')
  const app = new WorldApplication({
    worldPath,
    sessionPath: join(root, 'session.sqlite'),
    memoryPath: join(root, 'sources.sqlite'),
  })
  const world = frozenInteractionWorld()
  try {
    expect(() => app.activate(world)).toThrow('cannot resolve the interaction selection')
    const store = new WorldStore(worldPath)
    try {
      expect(store.readManifest(world.manifest.address)).toBeUndefined()
      expect(() => new WorldBootstrap(store).activate(world)).toThrow('requires the frozen interaction runtime')
    } finally {
      store.close()
    }
  } finally {
    await app.close()
    rmSync(root, { recursive: true, force: true })
  }
})

it('opens and reopens a declared fixture world without a model or Python, with explicit interaction and source stores', async () => {
  const root = mkdtempSync(join(tmpdir(), 'core-no-model-'))
  const options = {
    worldPath: join(root, 'world.sqlite'),
    sessionPath: join(root, 'session.sqlite'),
    memoryPath: join(root, 'sources.sqlite'),
    interactionPackages: [basicInteractionPackage],
  }
  const world = frozenInteractionWorld()
  let app = new WorldApplication(options)
  try {
    app.activate(world)
    const head = await app.head(world.manifest.address)
    const view = await app.characterViewForPrincipal(
      world.manifest.address,
      'principal:player',
      world.manifest.playerBindings[0]!.characterId,
    )
    expect(view.locationId).toBe('location:room')
    await app.close()
    app = new WorldApplication(options)
    expect(await app.head(world.manifest.address)).toEqual(head)
  } finally {
    await app.close()
    rmSync(root, { recursive: true, force: true })
  }
})

it('requires the authorized source store when the manifest selects agent context', async () => {
  const root = mkdtempSync(join(tmpdir(), 'core-source-requirement-'))
  const app = new WorldApplication({
    worldPath: join(root, 'world.sqlite'),
    sessionPath: join(root, 'session.sqlite'),
    interactionPackages: [basicInteractionPackage],
  })
  try {
    expect(() => app.activate(frozenInteractionWorld())).toThrow('memoryPath must be configured for Agent Context v2')
  } finally {
    await app.close()
    rmSync(root, { recursive: true, force: true })
  }
})
