import { assertProtocolString, canonicalizeWorldJson, type InteractionParameterSchema, type InteractionRef, type InteractionTargetRef, type WorldJsonObject, type WorldJsonValue } from '@harness-world/contracts'

export function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('expected closed object')
  const names = Object.keys(value)
  if (names.length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) throw new TypeError('missing or extra fields')
  return value as Record<string, unknown>
}

export function text(value: unknown): string {
  if (typeof value !== 'string') throw new TypeError('expected identifier')
  return assertProtocolString(value, 'interaction identifier')
}

export function integer(value: unknown, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || Object.is(value, -0) || (value as number) < minimum || (value as number) > maximum) throw new TypeError('integer outside limits')
  return value as number
}

export function list(value: unknown, maximum: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length > maximum) throw new TypeError('array outside limits')
  return value
}

export function reference(value: unknown): InteractionRef {
  const row = object(value, ['id', 'version'])
  return { id: text(row.id), version: integer(row.version, 1, Number.MAX_SAFE_INTEGER) }
}

export function key(value: InteractionRef): string {
  const ref = reference(value)
  return `${ref.id}@${ref.version}`
}

export function target(value: unknown): InteractionTargetRef {
  const row = object(value, ['kind', 'id'])
  if (!['character', 'entity', 'relation'].includes(row.kind as string)) throw new TypeError('unknown target kind')
  return { kind: row.kind as InteractionTargetRef['kind'], id: text(row.id) }
}

export function targetKey(value: InteractionTargetRef): string { return `${value.kind}:${value.id}` }

export function immutable<T>(value: T): T {
  const copy = JSON.parse(Buffer.from(canonicalizeWorldJson(value as WorldJsonValue)).toString('utf8')) as T
  function freeze(entry: unknown): void {
    if (entry !== null && typeof entry === 'object') { Object.values(entry).forEach(freeze); Object.freeze(entry) }
  }
  freeze(copy)
  return copy
}

export function parameterSchema(value: unknown): InteractionParameterSchema {
  const root = object(value, ['fields'])
  const names = new Set<string>()
  for (const input of list(root.fields, 8)) {
    if (input === null || typeof input !== 'object') throw new TypeError('invalid parameter field')
    const field = input as Record<string, unknown>
    const name = text(field.name)
    if (names.has(name) || ['actorId', 'authority', 'resolutionAuthority', '__proto__', 'prototype', 'constructor'].includes(name)) throw new TypeError('duplicate or reserved parameter')
    names.add(name)
    if (field.type === 'boolean') object(field, ['name', 'type'])
    else if (field.type === 'integer') {
      object(field, ['name', 'type', 'minimum', 'maximum'])
      integer(field.minimum, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)
      integer(field.maximum, field.minimum as number, Number.MAX_SAFE_INTEGER)
    } else if (field.type === 'string') {
      object(field, ['name', 'type', 'maxBytes', 'values'])
      integer(field.maxBytes, 1, 1024)
      const values = list(field.values, 64)
      if (new Set(values).size !== values.length) throw new TypeError('duplicate enum')
      for (const item of values) {
        if (typeof item !== 'string' || Buffer.byteLength(item, 'utf8') > (field.maxBytes as number)) throw new TypeError('invalid string enum')
      }
    } else throw new TypeError('unsupported parameter field')
  }
  return immutable(value as InteractionParameterSchema)
}

export function parameters(schema: InteractionParameterSchema, value: unknown): WorldJsonObject {
  const row = object(value, schema.fields.map(field => field.name))
  canonicalizeWorldJson(row as WorldJsonObject)
  for (const field of schema.fields) {
    const item = row[field.name]
    if (field.type === 'integer') integer(item, field.minimum, field.maximum)
    else if (field.type === 'boolean') { if (typeof item !== 'boolean') throw new TypeError('expected boolean') }
    else if (typeof item !== 'string' || Buffer.byteLength(item, 'utf8') > field.maxBytes || (field.values.length > 0 && !field.values.includes(item))) throw new TypeError('string outside parameter domain')
  }
  return immutable(row as WorldJsonObject)
}
