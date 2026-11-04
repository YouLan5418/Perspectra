import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { hashWorldJson } from '@harness-world/contracts'
import { WorldApplication } from '@harness-world/application'
import { WorldStore } from '@harness-world/store-sqlite'
import { WorldBootstrap } from '@harness-world/kernel'
import { frozenInteractionWorld, basicInteractionPackage } from '../fixtures/frozen-interaction-world.ts'

// Temporary diagnostic for M2: replace this assertion when activation and read validation agree.
it('reports the empty-catalog activation and mount inconsistency without bypassing validation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'minimal-core-probe-'))
  const worldPath = join(root, 'world.sqlite')
  const original = frozenInteractionWorld()
  const manifest = {
    ...original.manifest,
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
  const app = new WorldApplication({
    worldPath,
    sessionPath: join(root, 'session.sqlite'),
    memoryPath: join(root, 'sources.sqlite'),
    interactionPackages: [],
  })
  try {
    app.activate(compiled)
    const store = new WorldStore(worldPath)
    try {
      expect(store.readManifest(manifest.address)).toBeDefined()
      expect(store.head(manifest.address).headSeq).toBeGreaterThan(0)
    } finally {
      store.close()
    }
    await expect(app.head(manifest.address)).rejects.toThrow(
      'interactionCatalog.packages is outside the frozen selection budget',
    )
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
    interactionPackages: [],
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
