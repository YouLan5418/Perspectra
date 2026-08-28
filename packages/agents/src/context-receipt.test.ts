import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import {
  brandId,
  hashWorldJson,
  type WorldAddress,
} from '@harness-world/contracts'
import {
  ContextExplainService,
  ContextReceiptStore,
  createContextReceipt,
  type CreateContextReceiptRequest,
} from './context-receipt.ts'

const alice = brandId('character:alice', 'CharacterId')
const address: WorldAddress = {
  tenantId: brandId('tenant:receipt', 'TenantId'),
  worldId: brandId('world:receipt', 'WorldId'),
  branchId: brandId('branch:main', 'BranchId'),
}

function path(name = 'context.sqlite'): string {
  return join(mkdtempSync(join(tmpdir(), 'context-receipt-')), name)
}

function request(overrides: Partial<CreateContextReceiptRequest> = {}): CreateContextReceiptRequest {
  return {
    address, roundId: brandId('round:receipt', 'InteractionRoundId'), participantKind: 'character',
    participantId: 'agent:alice', subjectCharacterId: alice, controllerId: 'scripted:v2', controllerEpoch: 1,
    baseHeadSeq: 10, asOfWorldSeq: 10, tick: 2, manifestHash: hashWorldJson('manifest', { version: 4 }),
    contextProfileId: 'compact', contextProfileHash: hashWorldJson('profile', { id: 'compact' }),
    versionLocks: {
      contextSchema: 'character-controller/v2', contextReceiptSchema: 'context-receipt/v1',
      sceneDecisionSchema: 'scene-decision/v2', memorySchema: 'cognitive-memory/v2',
      checkpointSchema: 'continuity-checkpoint/v1', rendererSchema: 'structured-prompt-renderer/v1',
    },
    componentHashes: {
      characterViewHash: hashWorldJson('view', {}), sceneDecisionHash: hashWorldJson('scene', {}),
      checkpointHash: null, tailHash: hashWorldJson('tail', {}), recallHash: hashWorldJson('recall', {}),
      affordanceHash: hashWorldJson('affordance', {}),
    },
    includedSourceRefs: [
      { sourceKind: 'world_event', sourceId: 'event:2', sourceSeq: 2, sourceHash: hashWorldJson('event', { seq: 2 }) },
      { sourceKind: 'world_event', sourceId: 'event:1', sourceSeq: 1, sourceHash: hashWorldJson('event', { seq: 1 }) },
      { sourceKind: 'world_event', sourceId: 'event:2', sourceSeq: 2, sourceHash: hashWorldJson('event', { seq: 2 }) },
      { sourceKind: 'director_visible', sourceId: 'event:z', sourceSeq: 2, sourceHash: hashWorldJson('event', { id: 'z' }) },
      { sourceKind: 'director_visible', sourceId: 'event:a', sourceSeq: 2, sourceHash: hashWorldJson('event', { id: 'a' }) },
    ],
    exclusions: [
      { reason: 'profile_capacity', sourceRefHash: hashWorldJson('excluded', { id: 2 }) },
      { reason: 'audience_forbidden', sourceRefHash: null },
      { reason: 'profile_capacity', sourceRefHash: null },
      { reason: 'profile_capacity', sourceRefHash: null },
    ],
    contextHash: hashWorldJson('context', { value: 1 }),
    providerRequestHash: hashWorldJson('provider', { value: 1 }),
    ...overrides,
  }
}

describe('ContextReceiptStore and ContextExplainService', () => {
  it('normalizes, appends once, reopens and lists durable receipts', () => {
    const databasePath = path()
    const store = new ContextReceiptStore(databasePath)
    const receipt = store.append(request())
    expect(receipt.includedSourceRefs.map(source => source.sourceId))
      .toEqual(['event:1', 'event:a', 'event:z', 'event:2'])
    expect(receipt.exclusions.map(exclusion => exclusion.reason))
      .toEqual(['audience_forbidden', 'profile_capacity', 'profile_capacity', 'profile_capacity'])
    expect(store.append(request())).toEqual(receipt)
    expect(store.listRound(address, receipt.roundId)).toEqual([receipt])
    expect(store.listRound(address, brandId('round:absent', 'InteractionRoundId'))).toEqual([])
    expect(store.read('receipt:absent')).toBeUndefined()
    store.close()

    const reopened = new ContextReceiptStore(databasePath)
    expect(reopened.read(receipt.receiptId)).toEqual(receipt)
    reopened.reset(address)
    expect(reopened.read(receipt.receiptId)).toBeUndefined()
    reopened.close()
  })

  it('fails closed when the same Round participant rebuilds differently', () => {
    const store = new ContextReceiptStore(path())
    store.append(request())
    expect(() => store.append(request({ contextHash: hashWorldJson('context', { value: 2 }) })))
      .toThrow('diverged')
    store.close()
  })

  it('rejects invalid scope, watermarks and future sources', () => {
    expect(() => createContextReceipt(request({ baseHeadSeq: 11 }))).toThrow('later')
    expect(() => createContextReceipt(request({ tick: -1 }))).toThrow('non-negative')
    expect(() => createContextReceipt(request({ tick: 0.5 }))).toThrow('non-negative')
    expect(() => createContextReceipt(request({ participantKind: 'character', subjectCharacterId: null })))
      .toThrow('requires')
    expect(() => createContextReceipt(request({ participantKind: 'director', subjectCharacterId: alice })))
      .toThrow('cannot')
    expect(() => createContextReceipt(request({
      includedSourceRefs: [{
        sourceKind: 'world_event', sourceId: 'event:future', sourceSeq: 11,
        sourceHash: hashWorldJson('event', { seq: 11 }),
      }],
    }))).toThrow('future')
    expect(createContextReceipt(request({ participantKind: 'director', subjectCharacterId: null })).participantKind)
      .toBe('director')
  })

  it('uses schema v2, upgrades v1 and rejects future Context database versions', () => {
    const upgradePath = path()
    const old = new DatabaseSync(upgradePath)
    old.exec('PRAGMA user_version=1')
    old.close()
    const upgraded = new ContextReceiptStore(upgradePath)
    upgraded.close()
    const check = new DatabaseSync(upgradePath)
    expect((check.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(2)
    check.close()

    const futurePath = path()
    const future = new DatabaseSync(futurePath)
    future.exec('PRAGMA user_version=3')
    future.close()
    expect(() => new ContextReceiptStore(futurePath)).toThrow('unsupported')
  })

  it('detects altered durable JSON, column Hash and namespace', () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['receipt_json', '{"bad":true}'],
      ['receipt_hash', hashWorldJson('wrong', {})],
      ['namespace_key', 'wrong\u001fnamespace\u001fkey'],
    ]
    for (const [column, value] of cases) {
      const databasePath = path()
      const store = new ContextReceiptStore(databasePath)
      const receipt = store.append(request())
      store.close()
      const database = new DatabaseSync(databasePath)
      database.prepare(`UPDATE context_receipts SET ${column} = ? WHERE receipt_id = ?`).run(value as string, receipt.receiptId)
      database.close()
      const damaged = new ContextReceiptStore(databasePath)
      expect(() => damaged.read(receipt.receiptId)).toThrow()
      damaged.close()
    }

    const appendPath = path()
    const original = new ContextReceiptStore(appendPath)
    const receipt = original.append(request())
    original.close()
    const altered = new DatabaseSync(appendPath)
    altered.prepare('UPDATE context_receipts SET receipt_hash = ? WHERE receipt_id = ?')
      .run(hashWorldJson('wrong-column', {}), receipt.receiptId)
    altered.close()
    const divergent = new ContextReceiptStore(appendPath)
    expect(() => divergent.append(request())).toThrow('diverged')
    divergent.close()
  })

  it('exposes provenance to Admin/Author but no secret existence or counts to Player', () => {
    const store = new ContextReceiptStore(path())
    const service = new ContextExplainService(store)
    const receipt = service.rebuild(request({
      exclusions: [{ reason: 'audience_forbidden', sourceRefHash: hashWorldJson('secret', {}) }],
    }))
    expect(service.verify(receipt.receiptId)).toEqual({
      receiptId: receipt.receiptId, verified: true, receiptHash: receipt.receiptHash,
    })
    expect(service.explain(receipt.receiptId, 'admin')).toMatchObject({
      audience: 'admin', includedSourceRefs: receipt.includedSourceRefs, exclusions: receipt.exclusions,
    })
    expect(service.explain(receipt.receiptId, 'author')).toMatchObject({ audience: 'author' })
    const player = service.explain(receipt.receiptId, 'player', alice)
    expect(JSON.stringify(player)).not.toMatch(/source|exclusion|participant|character|secret/i)
    expect(() => service.explain(
      receipt.receiptId, 'player', brandId('character:bob', 'CharacterId'),
    )).toThrow('another participant')
    expect(() => service.explain('receipt:absent', 'admin')).toThrow('does not exist')
    expect(() => service.verify('receipt:absent')).toThrow('does not exist')
    store.close()
  })
})
