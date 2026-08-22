import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { brandId, type RuntimeAvailabilityState } from '@harness-world/contracts'
import { CharacterRuntimeAvailabilityService } from './character-runtime.ts'
import { WorldStore } from './world-store.ts'

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
  it('stores all seven operational states without changing world authority', () => {
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
      'provisioning', 'ready', 'session_lag', 'model_unavailable', 'budget_unavailable', 'offline', 'disabled',
    ]
    for (const state of states) expect(service.set(address, characterA, state, state === 'ready' ? null : `reason:${state}`)).toMatchObject({ state, changedAtMs: 42 })
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
})
