import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import {
  brandId,
  hashWorldJson,
  type ContextReceipt,
  type WorldAddress,
  type WorldJsonObject,
} from '@harness-world/contracts'
import { createContextReceipt, type CreateContextReceiptRequest } from './context-receipt.ts'
import { ProviderCallStore, type ProviderCallTerminalState } from './provider-call.ts'

const address: WorldAddress = {
  tenantId: brandId('tenant:provider-call', 'TenantId'),
  worldId: brandId('world:provider-call', 'WorldId'),
  branchId: brandId('branch:main', 'BranchId'),
}

function path(name = 'context.sqlite'): string {
  return join(mkdtempSync(join(tmpdir(), 'provider-call-')), name)
}

function receipt(participantId = 'agent:alice', overrides: Partial<CreateContextReceiptRequest> = {}): ContextReceipt {
  return createContextReceipt({
    address,
    roundId: brandId(`round:${participantId}`, 'InteractionRoundId'),
    participantKind: 'character',
    participantId,
    subjectCharacterId: brandId('character:alice', 'CharacterId'),
    controllerId: 'scripted:v1',
    controllerEpoch: 1,
    baseHeadSeq: 4,
    asOfWorldSeq: 4,
    tick: 1,
    manifestHash: hashWorldJson('manifest', { version: 4 }),
    contextProfileId: 'standard',
    contextProfileHash: hashWorldJson('profile', { id: 'standard' }),
    versionLocks: {
      contextSchema: 'character-controller/v2', contextReceiptSchema: 'context-receipt/v1',
      sceneDecisionSchema: 'scene-decision/v2', memorySchema: 'cognitive-memory/v2',
      checkpointSchema: 'continuity-checkpoint/v1', rendererSchema: 'structured-prompt-renderer/v1',
    },
    componentHashes: {
      characterViewHash: hashWorldJson('character-view', {}),
      sceneDecisionHash: hashWorldJson('scene', {}), checkpointHash: null,
      tailHash: hashWorldJson('tail', {}), recallHash: hashWorldJson('recall', {}),
      affordanceHash: hashWorldJson('affordance', {}),
    },
    includedSourceRefs: [], exclusions: [],
    contextHash: hashWorldJson('context', { participantId }),
    providerRequestHash: hashWorldJson('provider-request', { participantId }),
    ...overrides,
  })
}

function response(value = 1): WorldJsonObject {
  return { schemaVersion: 2, decision: 'abstain', actions: [], value }
}

describe('ProviderCallStore', () => {
  it('persists the prepared through committed lifecycle append-once and reopens it', () => {
    const databasePath = path()
    const store = new ProviderCallStore(databasePath)
    const contextReceipt = receipt()
    const prepared = store.prepare(contextReceipt)
    expect(prepared).toMatchObject({ state: 'prepared', receiptHash: contextReceipt.receiptHash })
    expect(store.prepare(contextReceipt)).toEqual(prepared)
    expect(store.recovery(prepared.modelCallId)).toBe('dispatch_safe')

    const dispatched = store.markDispatchStarted(prepared.modelCallId)
    expect(store.markDispatchStarted(prepared.modelCallId)).toEqual(dispatched)
    expect(store.recovery(prepared.modelCallId)).toBe('ambiguous')

    const received = store.recordResponse(prepared.modelCallId, response(), { requestId: 'scripted:1', usage: { tokens: 4 } })
    expect(store.recordResponse(prepared.modelCallId, response(), { requestId: 'scripted:1', usage: { tokens: 4 } })).toEqual(received)
    expect(store.recovery(prepared.modelCallId)).toBe('result_available')

    const proposal = { schemaVersion: 2, decision: 'abstain', actions: [] }
    const validated = store.markValidated(prepared.modelCallId, proposal)
    expect(store.markValidated(prepared.modelCallId, proposal)).toEqual(validated)
    const authorityHash = hashWorldJson('authority', { round: 1 })
    const committed = store.markCommitted(prepared.modelCallId, 'transaction:one', authorityHash)
    expect(store.markCommitted(prepared.modelCallId, 'transaction:one', authorityHash)).toEqual(committed)
    expect(store.recovery(prepared.modelCallId)).toBe('result_available')
    store.close()

    const reopened = new ProviderCallStore(databasePath)
    expect(reopened.read(prepared.modelCallId)).toEqual(committed)
    expect(reopened.read('call:absent')).toBeUndefined()
    reopened.close()
  })

  it.each([
    ['failed_before_dispatch', 'prepared'],
    ['budget_exhausted', 'prepared'],
    ['provider_rejected', 'dispatch_started'],
    ['timed_out_ambiguous', 'dispatch_started'],
    ['invalid_response', 'response_received'],
    ['discarded_after_quarantine', 'prepared'],
  ] as const)('records terminal state %s only from its allowed boundary', (terminal, from) => {
    const store = new ProviderCallStore(path())
    const prepared = store.prepare(receipt(`agent:${terminal}`))
    if (from === 'dispatch_started' || from === 'response_received') store.markDispatchStarted(prepared.modelCallId)
    if (from === 'response_received') store.recordResponse(prepared.modelCallId, response(), { requestId: 'scripted' })
    const metadata = { reason: terminal }
    const result = store.markTerminal(prepared.modelCallId, terminal, metadata)
    expect(result).toMatchObject({ state: terminal, terminalMetadata: metadata })
    expect(store.markTerminal(prepared.modelCallId, terminal, metadata)).toEqual(result)
    expect(store.recovery(prepared.modelCallId)).toBe('terminal')
    store.close()
  })

  it('rejects divergent append-once content, identity, transitions, and receipts', () => {
    const store = new ProviderCallStore(path())
    const contextReceipt = receipt('agent:conflict')
    const prepared = store.prepare(contextReceipt)
    expect(() => store.recovery('call:absent')).toThrow('does not exist')
    expect(() => store.recordResponse(prepared.modelCallId, response(), {})).toThrow('prepared to response_received')
    expect(() => store.markValidated(prepared.modelCallId, response())).toThrow('prepared to validated')
    expect(() => store.markCommitted(prepared.modelCallId, 'tx', hashWorldJson('authority', {}))).toThrow('prepared to committed')
    expect(() => store.markTerminal(prepared.modelCallId, 'provider_rejected', {})).toThrow('prepared to provider_rejected')

    store.markDispatchStarted(prepared.modelCallId)
    store.recordResponse(prepared.modelCallId, response(), { requestId: 'one' })
    expect(() => store.recordResponse(prepared.modelCallId, response(2), { requestId: 'one' })).toThrow('diverged')
    expect(() => store.recordResponse(prepared.modelCallId, response(), { requestId: 'two' })).toThrow('diverged')
    store.markValidated(prepared.modelCallId, response())
    expect(() => store.markValidated(prepared.modelCallId, response(2))).toThrow('diverged')
    const authorityHash = hashWorldJson('authority', { value: 1 })
    store.markCommitted(prepared.modelCallId, 'tx:one', authorityHash)
    expect(() => store.markCommitted(prepared.modelCallId, 'tx:two', authorityHash)).toThrow('diverged')
    expect(() => store.markCommitted(prepared.modelCallId, 'tx:one', hashWorldJson('authority', { value: 2 }))).toThrow('diverged')
    expect(() => store.markTerminal(prepared.modelCallId, 'discarded_after_quarantine', {})).toThrow('committed to discarded_after_quarantine')

    const terminal = store.prepare(receipt('agent:terminal-conflict'))
    store.markTerminal(terminal.modelCallId, 'budget_exhausted', { reason: 'one' })
    expect(() => store.markTerminal(terminal.modelCallId, 'budget_exhausted', { reason: 'two' })).toThrow('diverged')

    const alternateReceipt = receipt('agent:conflict', { manifestHash: hashWorldJson('manifest', { version: 99 }) })
    expect(() => store.prepare(alternateReceipt)).toThrow('diverged')
    expect(() => store.prepare({ ...contextReceipt, receiptHash: hashWorldJson('bad-receipt', {}) })).toThrow('valid Context receipt')
    store.close()
  })

  it('serializes deterministic prepare across two open connections', () => {
    const databasePath = path()
    const first = new ProviderCallStore(databasePath)
    const second = new ProviderCallStore(databasePath)
    const contextReceipt = receipt('agent:dual-connection')
    const prepared = first.prepare(contextReceipt)
    expect(second.prepare(contextReceipt)).toEqual(prepared)
    expect(() => second.prepare(receipt('agent:dual-connection', {
      manifestHash: hashWorldJson('manifest', { version: 99 }),
    }))).toThrow('diverged')
    expect(first.read(prepared.modelCallId)).toEqual(prepared)
    first.close()
    second.close()
  })

  it('fails closed on corrupted hashes, namespaces, and future schemas', () => {
    const databasePath = path()
    const store = new ProviderCallStore(databasePath)
    const one = store.prepare(receipt('agent:corrupt-hash'))
    store.markDispatchStarted(one.modelCallId)
    store.recordResponse(one.modelCallId, response(), {})
    store.close()
    const raw = new DatabaseSync(databasePath)
    raw.prepare('UPDATE provider_calls SET response_hash = ? WHERE model_call_id = ?')
      .run(hashWorldJson('corrupt', {}), one.modelCallId)
    raw.close()
    const corrupted = new ProviderCallStore(databasePath)
    expect(() => corrupted.read(one.modelCallId)).toThrow('diverged')
    corrupted.close()

    const namespacePath = path()
    const namespace = new ProviderCallStore(namespacePath)
    const two = namespace.prepare(receipt('agent:corrupt-namespace'))
    namespace.close()
    const rawNamespace = new DatabaseSync(namespacePath)
    rawNamespace.prepare('UPDATE provider_calls SET namespace_key = ? WHERE model_call_id = ?').run('bad', two.modelCallId)
    rawNamespace.close()
    const malformed = new ProviderCallStore(namespacePath)
    expect(() => malformed.read(two.modelCallId)).toThrow('namespace is malformed')
    malformed.close()

    const futurePath = path()
    const future = new DatabaseSync(futurePath)
    future.exec('PRAGMA user_version=5')
    future.close()
    expect(() => new ProviderCallStore(futurePath)).toThrow('unsupported Context derivation schema version 5')
  })

  it('rejects every terminal state from an incompatible lifecycle point', () => {
    const store = new ProviderCallStore(path())
    const terminalStates: readonly ProviderCallTerminalState[] = [
      'failed_before_dispatch', 'budget_exhausted', 'provider_rejected', 'timed_out_ambiguous',
      'invalid_response',
    ]
    for (const [index, state] of terminalStates.entries()) {
      const prepared = store.prepare(receipt(`agent:wrong-terminal:${index}`))
      if (state === 'failed_before_dispatch' || state === 'budget_exhausted') store.markDispatchStarted(prepared.modelCallId)
      expect(() => store.markTerminal(prepared.modelCallId, state, {})).toThrow('cannot transition')
    }
    store.close()
  })
})
