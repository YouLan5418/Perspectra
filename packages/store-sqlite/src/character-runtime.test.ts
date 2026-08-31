import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { brandId, type RuntimeAvailabilityState } from '@harness-world/contracts'
import { CharacterRuntimeAvailabilityService } from './character-runtime.ts'
import { WORLD_SCHEMA_VERSION, WorldStore } from './world-store.ts'

const directories: string[] = []
const address = {
  tenantId: brandId('tenant:runtime', 'TenantId'),
  worldId: brandId('world:runtime', 'WorldId'),
  branchId: brandId('branch:main', 'BranchId'),
}
const characterA = brandId('character:a', 'CharacterId')
const characterB = brandId('character:b', 'CharacterId')

function database(): string {
  const directory = mkdtempSync(join(tmpdir(), 'hcw-runtime-availability-'))
  directories.push(directory)
  return join(directory, 'world.sqlite')
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('CharacterRuntimeAvailabilityService', () => {
  it('stores all eight operational states without changing world authority', () => {
    const path = database()
    const world = new WorldStore(path)
    world.createBranch(address)
    const before = world.head(address)
    const service = new CharacterRuntimeAvailabilityService(path, () => 42)
    service.initialize(address, [
      { characterId: characterB, state: 'provisioning' },
      { characterId: characterA, state: 'ready' },
    ])
    service.initialize(address, [{ characterId: characterA, state: 'disabled' }])
    expect(service.list(address).map(value => [value.characterId, value.state])).toEqual([
      [characterA, 'ready'], [characterB, 'provisioning'],
    ])
    const states: readonly RuntimeAvailabilityState[] = [
      'provisioning', 'ready', 'session_lag', 'model_unavailable', 'provider_output_invalid',
      'budget_unavailable', 'offline', 'disabled',
    ]
    for (const state of states) expect(service.set(address, characterA, state, state === 'ready' ? null : `reason:${state}`)).toMatchObject({ state, changedAtMs: 42 })
    expect(service.set(address, characterA, 'disabled', 'reason:disabled')).toMatchObject({ state: 'disabled', changedAtMs: 42 })
    expect(service.get(address, characterA)).toMatchObject({ state: 'disabled', reason: 'reason:disabled' })
    expect(service.get(address, brandId('character:missing', 'CharacterId'))).toBeUndefined()
    expect(world.head(address)).toEqual(before)
    expect(world.readEvents(address)).toEqual([])
    service.close()
    world.close()
  })

  it('rejects invalid state, reason, missing initialization, and rolls back a failed batch', () => {
    const path = database()
    const world = new WorldStore(path)
    world.createBranch(address)
    const service = new CharacterRuntimeAvailabilityService(path)
    expect(() => service.initialize(address, [{ characterId: characterA, state: 'invalid' as RuntimeAvailabilityState }])).toThrow(TypeError)
    expect(service.list(address)).toEqual([])
    service.initialize(address, [{ characterId: characterA, state: 'ready' }])
    expect(() => service.set(address, characterA, 'invalid' as RuntimeAvailabilityState, null)).toThrow(TypeError)
    expect(() => service.set(address, characterA, 'ready', '')).toThrow(TypeError)
    expect(() => service.set(address, characterA, 'ready', ' padded ')).toThrow(TypeError)
    expect(() => service.set(address, characterB, 'ready', null)).toThrow('not initialized')
    service.close()
    world.close()
  })

  it('migrates v14 availability rows before accepting provider_output_invalid', () => {
    const path = database()
    const world = new WorldStore(path)
    world.createBranch(address)
    const service = new CharacterRuntimeAvailabilityService(path, () => 9)
    service.initialize(address, [{ characterId: characterA, state: 'ready' }])
    service.close()
    world.close()

    const legacy = new DatabaseSync(path)
    legacy.exec(`
      PRAGMA foreign_keys=OFF;
      DROP TABLE world_reaction_job_stimuli;
      DROP TABLE world_reaction_jobs;
      DROP TABLE world_reaction_waves;
      DROP TABLE world_reaction_cycles;
      DROP INDEX events_type_range;
      ALTER TABLE character_runtime_availability RENAME TO character_runtime_availability_v15;
      CREATE TABLE character_runtime_availability (
        address_key TEXT NOT NULL, character_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN (
          'provisioning', 'ready', 'session_lag', 'model_unavailable', 'budget_unavailable', 'offline', 'disabled'
        )),
        reason TEXT, changed_at_ms INTEGER NOT NULL CHECK(changed_at_ms >= 0),
        revision INTEGER NOT NULL CHECK(revision >= 0),
        PRIMARY KEY(address_key, character_id),
        FOREIGN KEY(address_key) REFERENCES branches(address_key)
      ) STRICT;
      INSERT INTO character_runtime_availability
      SELECT * FROM character_runtime_availability_v15;
      DROP TABLE character_runtime_availability_v15;
      PRAGMA user_version=14;
    `)
    legacy.close()

    const migrated = new CharacterRuntimeAvailabilityService(path, () => 10)
    expect(migrated.get(address, characterA)).toMatchObject({ state: 'ready', changedAtMs: 9 })
    expect(migrated.set(address, characterA, 'provider_output_invalid', 'invalid output'))
      .toMatchObject({ state: 'provider_output_invalid', changedAtMs: 10 })
    migrated.close()
    const check = new DatabaseSync(path, { readOnly: true })
    expect((check.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)
      .toBe(WORLD_SCHEMA_VERSION)
    check.close()
  })
})
