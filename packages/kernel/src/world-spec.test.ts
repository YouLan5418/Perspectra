import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { brandId, deterministicId, hashWorldJson, type WorldJsonValue } from '@harness-world/contracts'
import { WorldStore } from '@harness-world/store-sqlite'
import { WorldBootstrap } from './world-bootstrap.ts'
import { WorldSpecCompiler, type CompiledWorldSpec } from './world-spec.ts'

const directories: string[] = []

function database(name: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'hcw-kernel-'))
  directories.push(directory)
  return join(directory, name)
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function spec() {
  return {
    schemaVersion: 1,
    address: { tenantId: 'tenant:spec', worldId: 'world:spec', branchId: 'branch:main' },
    timeMode: 'TURN_DRIVEN',
    roundQueueLimit: 8,
    rulebook: { rulebookId: 'builtin:speak-move', version: 1 },
    locations: [
      { locationId: 'location:z', name: 'Zed' },
      { locationId: 'location:a', name: 'Alpha' },
    ],
    characters: [
      { characterId: 'character:b', name: 'Beta', locationId: 'location:z' },
      { characterId: 'character:a', name: 'Alpha', locationId: 'location:a' },
    ],
    playerBindings: [
      { principalId: 'principal:b', characterId: 'character:b', sessionId: 'session:b' },
      { principalId: 'principal:a', characterId: 'character:a', sessionId: 'session:a' },
    ],
    plugins: [
      { pluginId: 'plugin:z', version: '2.0.0-rc.1' },
      { pluginId: 'plugin:a', version: '1.0.0' },
    ],
  }
}

function activation(compiled: CompiledWorldSpec) {
  const identity = { address: compiled.manifest.address, manifestHash: compiled.manifestHash, genesisHash: compiled.genesisHash }
  return {
    address: compiled.manifest.address,
    manifest: compiled.manifest,
    manifestHash: compiled.manifestHash,
    genesisEvents: compiled.genesisEvents,
    genesisHash: compiled.genesisHash,
    transactionId: brandId(deterministicId('transaction:genesis', identity), 'TransactionId'),
    roundId: brandId(deterministicId('round:genesis', identity), 'InteractionRoundId'),
    correlationId: 'test-genesis',
  }
}

describe('WorldSpecCompiler and WorldBootstrap', () => {
  it('compiles stable sorted inputs and atomically replays Tick 0 Genesis', () => {
    const compiler = new WorldSpecCompiler()
    const compiled = compiler.compile(spec())
    expect(compiled.manifest.locations.map(value => value.locationId)).toEqual(['location:a', 'location:z'])
    expect(compiled.manifest.characters.map(value => value.characterId)).toEqual(['character:a', 'character:b'])
    expect(compiled.manifest.playerBindings.map(value => value.principalId)).toEqual(['principal:a', 'principal:b'])
    expect(compiled.manifest.plugins.map(value => value.pluginId)).toEqual(['plugin:a', 'plugin:z'])
    expect(compiled.genesisEvents[0]).toMatchObject({ eventType: 'world.activated' })

    const path = database('bootstrap.sqlite')
    const store = new WorldStore(path)
    expect(store.readManifest(compiled.manifest.address)).toBeUndefined()
    const bootstrap = new WorldBootstrap(store)
    const activated = bootstrap.activate(compiled)
    expect(activated).toMatchObject({ status: 'activated', tick: 0, headSeq: compiled.genesisEvents.length })
    expect(bootstrap.activate(compiled, 'retry')).toEqual({ ...activated, status: 'already_active' })
    expect(store.head(compiled.manifest.address).tick).toBe(0)
    expect(store.readEvents(compiled.manifest.address).every(event => event.tick === 0)).toBe(true)
    expect(store.readManifest(compiled.manifest.address)).toEqual({ manifest: compiled.manifest, manifestHash: compiled.manifestHash })
    store.close()

    const restarted = new WorldStore(path)
    expect(new WorldBootstrap(restarted).activate(compiled).bundleHash).toBe(activated.bundleHash)
    expect(restarted.readManifest(compiled.manifest.address)?.manifestHash).toBe(compiled.manifestHash)
    restarted.close()
  })

  it('rejects malformed specs at every strict boundary', () => {
    const compiler = new WorldSpecCompiler()
    const invalid: unknown[] = [
      null,
      { ...spec(), extra: true },
      { ...spec(), schemaVersion: 2 },
      { ...spec(), timeMode: 'REALTIME' },
      { ...spec(), roundQueueLimit: 0 },
      { ...spec(), roundQueueLimit: 1.5 },
      { ...spec(), address: [] },
      { ...spec(), address: { ...spec().address, extra: true } },
      { ...spec(), address: { ...spec().address, tenantId: ' padded ' } },
      { ...spec(), address: { ...spec().address, worldId: 1 } },
      { ...spec(), rulebook: null },
      { ...spec(), rulebook: { ...spec().rulebook, extra: true } },
      { ...spec(), rulebook: { rulebookId: 'other', version: 1 } },
      { ...spec(), rulebook: { rulebookId: 'builtin:speak-move', version: 2 } },
      { ...spec(), locations: {} },
      { ...spec(), locations: [] },
      { ...spec(), locations: [null] },
      { ...spec(), locations: [{ locationId: 'location:a', name: 'Alpha', extra: true }] },
      { ...spec(), locations: [{ locationId: '', name: 'Alpha' }] },
      { ...spec(), locations: [{ locationId: 'location:a', name: 1 }] },
      { ...spec(), locations: [{ locationId: 'location:a', name: 'A' }, { locationId: 'location:a', name: 'B' }] },
      { ...spec(), characters: {} },
      { ...spec(), characters: [] },
      { ...spec(), characters: [null] },
      { ...spec(), characters: [{ characterId: 'character:a', name: 'A', locationId: 'location:a', extra: true }] },
      { ...spec(), characters: [{ characterId: '', name: 'A', locationId: 'location:a' }] },
      { ...spec(), characters: [{ characterId: 'character:a', name: 1, locationId: 'location:a' }] },
      { ...spec(), characters: [{ characterId: 'character:a', name: 'A', locationId: 'missing' }] },
      { ...spec(), characters: [spec().characters[0]!, spec().characters[0]!] },
      { ...spec(), playerBindings: {} },
      { ...spec(), playerBindings: [] },
      { ...spec(), playerBindings: [null] },
      { ...spec(), playerBindings: [{ principalId: 'p', characterId: 'character:a', sessionId: 's', extra: true }] },
      { ...spec(), playerBindings: [{ principalId: '', characterId: 'character:a', sessionId: 's' }] },
      { ...spec(), playerBindings: [{ principalId: 'p', characterId: 'missing', sessionId: 's' }] },
      { ...spec(), playerBindings: [{ principalId: 'p', characterId: 'character:a', sessionId: 1 }] },
      { ...spec(), playerBindings: [spec().playerBindings[0]!, { ...spec().playerBindings[1]!, principalId: spec().playerBindings[0]!.principalId }] },
      { ...spec(), playerBindings: [spec().playerBindings[0]!, { ...spec().playerBindings[1]!, characterId: spec().playerBindings[0]!.characterId }] },
      { ...spec(), plugins: {} },
      { ...spec(), plugins: [null] },
      { ...spec(), plugins: [{ pluginId: 'plugin:a', version: '1.0.0', extra: true }] },
      { ...spec(), plugins: [{ pluginId: '', version: '1.0.0' }] },
      { ...spec(), plugins: [{ pluginId: 'plugin:a', version: 'latest' }] },
      { ...spec(), plugins: [{ pluginId: 'plugin:a', version: '1.0.0' }, { pluginId: 'plugin:a', version: '2.0.0' }] },
    ]
    for (const value of invalid) expect(() => compiler.compile(value)).toThrow(TypeError)
  })

  it('fails closed on conflicting or corrupted activation inputs', () => {
    const compiler = new WorldSpecCompiler()
    const compiled = compiler.compile(spec())
    const path = database('activation-errors.sqlite')
    const store = new WorldStore(path)
    expect(() => store.activateBranch({ ...activation(compiled), genesisEvents: [] })).toThrow('at least one')
    expect(() => store.activateBranch({ ...activation(compiled), manifestHash: hashWorldJson('wrong', 1) })).toThrow('manifestHash')
    expect(() => store.activateBranch({ ...activation(compiled), genesisHash: hashWorldJson('wrong', 1) })).toThrow('genesisHash')
    new WorldBootstrap(store).activate(compiled)
    const changed = compiler.compile({ ...spec(), roundQueueLimit: 9 })
    expect(() => new WorldBootstrap(store).activate(changed)).toThrow('already active')
    store.close()

    const occupiedPath = database('occupied.sqlite')
    const occupied = new WorldStore(occupiedPath)
    occupied.createBranch(compiled.manifest.address)
    expect(() => new WorldBootstrap(occupied).activate(compiled)).toThrow('unactivated branch')
    occupied.close()

    const collisionPath = database('manifest-collision.sqlite')
    const initialized = new WorldStore(collisionPath)
    initialized.close()
    const raw = new DatabaseSync(collisionPath)
    raw.prepare(`INSERT INTO world_manifests(manifest_hash, manifest_json) VALUES (?, ?)`)
      .run(compiled.manifestHash, '{}')
    raw.close()
    const collision = new WorldStore(collisionPath)
    expect(() => collision.activateBranch(activation(compiled))).toThrow('different bytes')
    collision.close()
  })

  it('rejects values outside World JSON before interpreting fields', () => {
    const value = spec() as Record<string, WorldJsonValue | undefined>
    value.plugins = undefined
    expect(() => new WorldSpecCompiler().compile(value)).toThrow('does not support undefined')
  })
})
