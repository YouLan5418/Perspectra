import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { brandId, type WorldAddress } from '@harness-world/contracts'
import { ProviderQualityStore } from './provider-quality.ts'

const directories: string[] = []

function database(name = 'context.sqlite'): string {
  const directory = mkdtempSync(join(tmpdir(), 'hcw-provider-quality-'))
  directories.push(directory)
  return join(directory, name)
}

function address(branch = 'main'): WorldAddress {
  return {
    tenantId: brandId('tenant:quality', 'TenantId'),
    worldId: brandId('world:quality', 'WorldId'),
    branchId: brandId(`branch:${branch}`, 'BranchId'),
  }
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('ProviderQualityStore', () => {
  it('persists the 1/2/4/8 invalid-response backoff and deterministic probe recovery', () => {
    const path = database()
    const store = new ProviderQualityStore(path, () => 42)
    const participantId = 'agent:quality'
    expect(store.state(address(), participantId)).toMatchObject({
      eligibleTicks: 0, responseInvalidStreak: 0, responseBackoffLevel: 0, responseBackoffRemaining: 0,
    })
    expect(store.beginEligibleTick(address(), participantId)).toMatchObject({ responseMode: 'normal' })
    expect(store.recordResponse(address(), participantId, 'response:1', 'invalid')).toMatchObject({
      responseInvalidStreak: 1, responseBackoffRemaining: 0,
    })
    store.recordResponse(address(), participantId, 'response:2', 'invalid')
    expect(store.recordResponse(address(), participantId, 'response:3', 'invalid')).toMatchObject({
      responseInvalidStreak: 3, responseBackoffLevel: 1, responseBackoffRemaining: 1,
    })
    expect(store.beginEligibleTick(address(), participantId)).toMatchObject({
      responseMode: 'skip', state: { responseBackoffRemaining: 0 },
    })
    expect(store.beginEligibleTick(address(), participantId)).toMatchObject({ responseMode: 'probe' })
    expect(store.recordResponse(address(), participantId, 'response:4', 'invalid')).toMatchObject({
      responseBackoffLevel: 2, responseBackoffRemaining: 2,
    })
    expect(store.beginEligibleTick(address(), participantId).responseMode).toBe('skip')
    expect(store.beginEligibleTick(address(), participantId).responseMode).toBe('skip')
    expect(store.beginEligibleTick(address(), participantId).responseMode).toBe('probe')

    for (const [index, expected] of [4, 8, 8].entries()) {
      expect(store.recordResponse(address(), participantId, `response:${index + 5}`, 'invalid').responseBackoffRemaining).toBe(expected)
      for (let index = 0; index < expected; index += 1) {
        expect(store.beginEligibleTick(address(), participantId).responseMode).toBe('skip')
      }
      expect(store.beginEligibleTick(address(), participantId).responseMode).toBe('probe')
    }
    const beforeReplay = store.state(address(), participantId)
    expect(store.recordResponse(address(), participantId, 'response:7', 'invalid')).toEqual(beforeReplay)
    expect(() => store.recordResponse(address(), participantId, 'response:7', 'valid')).toThrowError(expect.objectContaining({
      envelope: expect.objectContaining({ errorCode: 'BUNDLE_HASH_MISMATCH' }),
    }))
    expect(store.recordResponse(address(), participantId, 'response:valid', 'valid')).toMatchObject({
      responseInvalidStreak: 0, responseBackoffLevel: 0, responseBackoffRemaining: 0,
    })
    expect(store.beginEligibleTick(address(), participantId).responseMode).toBe('normal')
    store.close()

    const reopened = new ProviderQualityStore(path)
    expect(reopened.state(address(), participantId)).toMatchObject({
      responseInvalidStreak: 0, responseBackoffLevel: 0,
    })
    expect(reopened.readAudit(address(), participantId).at(-1)).toMatchObject({
      operation: 'provider-quality.eligible-tick', recordHash: expect.stringMatching(/^sha256:/),
    })
    reopened.close()
  })

  it('suspends only Reflection for four eligible Ticks and probes until a valid Batch', () => {
    const store = new ProviderQualityStore(database(), () => 7)
    const participantId = 'agent:reflection-quality'
    store.recordReflection(address(), participantId, 'reflection:1', 'invalid')
    store.recordReflection(address(), participantId, 'reflection:2', 'invalid')
    expect(store.recordReflection(address(), participantId, 'reflection:3', 'invalid')).toMatchObject({
      reflectionInvalidStreak: 3, reflectionSuspensionRemaining: 4,
    })
    for (let index = 0; index < 4; index += 1) {
      expect(store.beginEligibleTick(address(), participantId)).toMatchObject({
        responseMode: 'normal', reflectionMode: 'suspended',
      })
    }
    expect(store.beginEligibleTick(address(), participantId).reflectionMode).toBe('probe')
    expect(store.recordReflection(address(), participantId, 'reflection:4', 'invalid').reflectionSuspensionRemaining).toBe(4)
    for (let index = 0; index < 4; index += 1) store.beginEligibleTick(address(), participantId)
    expect(store.beginEligibleTick(address(), participantId).reflectionMode).toBe('probe')
    expect(store.recordReflection(address(), participantId, 'reflection:5', 'valid')).toMatchObject({
      reflectionInvalidStreak: 0, reflectionSuspensionRemaining: 0,
    })
    expect(store.beginEligibleTick(address(), participantId).reflectionMode).toBe('normal')
    const audit = store.readAudit(address(), participantId)
    store.close()
    expect(audit).toHaveLength(16)
  })

  it('isolates participants, validates schema and clock input, and fails closed on tampering', () => {
    const path = database()
    const store = new ProviderQualityStore(path, () => 1)
    store.recordResponse(address(), 'agent:a', 'response:a', 'invalid')
    expect(store.state(address(), 'agent:b').responseInvalidStreak).toBe(0)
    expect(() => store.state(address(), ' padded ')).toThrow(TypeError)
    expect(() => store.recordResponse(address(), 'agent:a', ' padded ', 'valid')).toThrow(TypeError)
    expect(() => store.recordReflection(address(), 'agent:a', ' padded ', 'valid')).toThrow(TypeError)
    store.close()

    const tamper = new DatabaseSync(path)
    tamper.prepare(`UPDATE provider_quality_state SET response_invalid_streak = 99 WHERE participant_id = 'agent:a'`).run()
    tamper.close()
    const divergent = new ProviderQualityStore(path)
    expect(() => divergent.state(address(), 'agent:a')).toThrowError(expect.objectContaining({
      envelope: expect.objectContaining({ errorCode: 'BUNDLE_HASH_MISMATCH' }),
    }))
    divergent.close()

    const auditPath = database('audit.sqlite')
    const audited = new ProviderQualityStore(auditPath, () => 2)
    audited.beginEligibleTick(address(), 'agent:a')
    audited.close()
    const auditTamper = new DatabaseSync(auditPath)
    auditTamper.prepare(`UPDATE provider_quality_audit SET details_json = '{"changed":true}'`).run()
    auditTamper.close()
    const badAudit = new ProviderQualityStore(auditPath)
    expect(() => badAudit.readAudit(address(), 'agent:a')).toThrowError(expect.objectContaining({
      envelope: expect.objectContaining({ errorCode: 'BUNDLE_HASH_MISMATCH' }),
    }))
    badAudit.close()

    const clockPath = database('clock.sqlite')
    const badClock = new ProviderQualityStore(clockPath, () => -1)
    expect(() => badClock.beginEligibleTick(address(), 'agent:a')).toThrow(RangeError)
    expect(badClock.state(address(), 'agent:a').eligibleTicks).toBe(0)
    badClock.close()

    const futurePath = database('future.sqlite')
    const future = new DatabaseSync(futurePath)
    future.exec('PRAGMA user_version=5')
    future.close()
    expect(() => new ProviderQualityStore(futurePath)).toThrow('unsupported Context derivation schema version 5')
  })
})
