import { describe, expect, it } from 'vitest'
import {
  VersionedRegistry,
  WorldError,
  assertProtocolString,
  brandId,
  canonicalizeWorldJson,
  createErrorEnvelope,
  deterministicId,
  failWorld,
  hashWorldJson,
  worldAddressKey,
  type WorldJsonValue,
} from './index.ts'

describe('world-json/v1', () => {
  it('canonicalizes supported values without Unicode normalization', () => {
    const nullPrototype = Object.assign(Object.create(null) as Record<string, WorldJsonValue>, { z: 2, a: 1 })
    expect(Buffer.from(canonicalizeWorldJson({ é: 'é', arr: [true, false, null, 1, '😀'], a: 'e\u0301', object: nullPrototype })).toString())
      .toBe('{"a":"é","arr":[true,false,null,1,"😀"],"object":{"a":1,"z":2},"é":"é"}')
    expect(hashWorldJson('text', 'é')).not.toBe(hashWorldJson('text', 'e\u0301'))
    expect(hashWorldJson('left', 1)).not.toBe(hashWorldJson('right', 1))
    expect(deterministicId('thing', { a: 1 })).toMatch(/^thing:[0-9a-f]{24}$/)
  })

  it.each([
    -0,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
    undefined,
    1n,
    Symbol('value'),
    () => undefined,
    new Date(0),
  ])('rejects an unsupported value: %s', (value) => {
    expect(() => canonicalizeWorldJson(value as WorldJsonValue)).toThrow(TypeError)
  })

  it('rejects invalid object, array, cycle, and Unicode representations', () => {
    const cycle: Record<string, WorldJsonValue> = {}
    cycle.self = cycle
    expect(() => canonicalizeWorldJson(cycle)).toThrow('cycles')
    const sparse = Array.from({ length: 2 }) as WorldJsonValue[]
    delete sparse[0]
    expect(() => canonicalizeWorldJson(sparse)).toThrow('holes')
    const symbolObject = { value: 1 } as Record<PropertyKey, unknown>
    symbolObject[Symbol('hidden')] = 2
    expect(() => canonicalizeWorldJson(symbolObject as WorldJsonValue)).toThrow('symbol')
    const accessor = {}
    Object.defineProperty(accessor, 'value', { enumerable: true, get: () => 1 })
    expect(() => canonicalizeWorldJson(accessor as WorldJsonValue)).toThrow('data properties')
    const hidden = {}
    Object.defineProperty(hidden, 'value', { enumerable: false, value: 1 })
    expect(() => canonicalizeWorldJson(hidden as WorldJsonValue)).toThrow('data properties')
    expect(() => canonicalizeWorldJson('\ud800')).toThrow('high surrogate')
    expect(() => canonicalizeWorldJson('\udc00')).toThrow('low surrogate')
    expect(() => canonicalizeWorldJson({ ['\ud800']: 1 })).toThrow('high surrogate')
  })
})

describe('identifiers, errors, and registries', () => {
  it('validates opaque ids and addresses', () => {
    const address = {
      tenantId: brandId('tenant', 'TenantId'),
      worldId: brandId('world', 'WorldId'),
      branchId: brandId('main', 'BranchId'),
    }
    expect(worldAddressKey(address)).toBe('tenant\u001fworld\u001fmain')
    expect(() => brandId('', 'TenantId')).toThrow()
    expect(() => brandId(' padded ', 'TenantId')).toThrow()
    expect(() => brandId('tenant\u001fworld', 'TenantId')).toThrow('control characters')
    expect(() => brandId('line\nbreak', 'WorldId')).toThrow('control characters')
    expect(() => brandId('delete\u007f', 'BranchId')).toThrow('control characters')
    expect(assertProtocolString('关联:正常', 'correlationId')).toBe('关联:正常')
    expect(() => assertProtocolString('round\u0000hidden', 'idempotencyKey')).toThrow('control characters')
  })

  it('creates stable error envelopes and typed errors', () => {
    const minimal = createErrorEnvelope({
      errorCode: 'INVALID_REQUEST',
      category: 'admission',
      message: 'invalid',
      retryable: false,
      correlationId: 'correlation',
    })
    expect(minimal.errorId).toBe('error:correlation:INVALID_REQUEST')
    const address = {
      tenantId: brandId('tenant', 'TenantId'),
      worldId: brandId('world', 'WorldId'),
      branchId: brandId('main', 'BranchId'),
    }
    const complete = createErrorEnvelope({
      errorId: 'explicit',
      errorCode: 'WORLD_COMMIT_FAILED',
      category: 'persistence',
      message: 'failed',
      retryable: true,
      correlationId: 'correlation',
      address,
      roundId: brandId('round', 'InteractionRoundId'),
      details: { value: 1 },
      causedByErrorId: 'previous',
    })
    expect(new WorldError(complete)).toMatchObject({ name: 'WorldError', envelope: complete, message: 'failed' })
    expect(() => failWorld({
      errorCode: minimal.errorCode,
      category: minimal.category,
      message: minimal.message,
      retryable: minimal.retryable,
      correlationId: minimal.correlationId,
    })).toThrow(WorldError)
  })

  it('freezes sorted exact-version registries', () => {
    const registry = new VersionedRegistry('event')
    const hashA = hashWorldJson('schema', { a: 1 })
    const hashB = hashWorldJson('schema', { b: 1 })
    registry.register({ name: 'z', version: 1, schemaHash: hashB })
    registry.register({ name: 'a', version: 2, schemaHash: hashA })
    registry.register({ name: 'a', version: 1, schemaHash: hashA })
    expect(registry.get('a', 1)?.schemaHash).toBe(hashA)
    expect(registry.get('missing', 1)).toBeUndefined()
    const frozen = registry.freeze()
    expect(frozen.manifest.definitions.map(value => `${value.name}@${value.version}`)).toEqual(['a@1', 'a@2', 'z@1'])
    expect(frozen.hash).toMatch(/^sha256:/)
    expect(() => registry.register({ name: 'later', version: 1, schemaHash: hashA })).toThrow('frozen')

    const duplicate = new VersionedRegistry('action')
    duplicate.register({ name: 'same', version: 1, schemaHash: hashA })
    expect(() => duplicate.register({ name: 'same', version: 1, schemaHash: hashA })).toThrow('duplicate')
    expect(() => new VersionedRegistry('rule').register({ name: 'bad', version: 0, schemaHash: hashA })).toThrow(TypeError)
    expect(() => new VersionedRegistry('projection').register({ name: 'bad', version: 1.5, schemaHash: hashA })).toThrow(TypeError)
    const reverseComparison = new VersionedRegistry('event')
    reverseComparison.register({ name: 'a', version: 1, schemaHash: hashA })
    reverseComparison.register({ name: 'z', version: 1, schemaHash: hashB })
    expect(reverseComparison.freeze().manifest.definitions.map(value => value.name)).toEqual(['a', 'z'])
  })
})
