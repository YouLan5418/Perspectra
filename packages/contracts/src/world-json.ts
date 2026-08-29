import { createHash } from 'node:crypto'

export type WorldJsonPrimitive = null | boolean | string | number
export type WorldJsonValue = WorldJsonPrimitive | readonly WorldJsonValue[] | WorldJsonObject
export interface WorldJsonObject {
  readonly [key: string]: WorldJsonValue
}

export type WorldHash = `sha256:${string}`

/** Compare strings by raw UTF-16 code units, matching `world-json/v1` object-key order. */
export function compareWorldText(left: string, right: string): number {
  return Number(left > right) - Number(left < right)
}

function assertLegalUnicode(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (index + 1 >= value.length || next < 0xdc00 || next > 0xdfff) {
        throw new TypeError('WorldJson string contains an unpaired high surrogate')
      }
      index += 1
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new TypeError('WorldJson string contains an unpaired low surrogate')
    }
  }
}

function serialize(value: unknown, ancestors: Set<object>): string {
  if (value === null) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'string') {
    assertLegalUnicode(value)
    return JSON.stringify(value)
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
      throw new TypeError('WorldJson numbers must be safe integers and cannot be negative zero')
    }
    return String(value)
  }
  if (typeof value !== 'object') {
    throw new TypeError(`WorldJson does not support ${typeof value}`)
  }
  if (ancestors.has(value)) throw new TypeError('WorldJson cannot contain cycles')
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      const entries: string[] = []
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) throw new TypeError('WorldJson arrays cannot contain holes')
        entries.push(serialize(value[index], ancestors))
      }
      return `[${entries.join(',')}]`
    }

    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('WorldJson objects must have Object.prototype or null prototype')
    }
    const keys = Reflect.ownKeys(value)
    if (keys.some(key => typeof key === 'symbol')) {
      throw new TypeError('WorldJson objects cannot contain symbol properties')
    }
    const stringKeys = keys as string[]
    for (const key of stringKeys) {
      assertLegalUnicode(key)
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor?.enumerable || !('value' in descriptor)) {
        throw new TypeError('WorldJson objects require enumerable data properties')
      }
    }
    stringKeys.sort(compareWorldText)
    const entries = stringKeys.map((key) => `${JSON.stringify(key)}:${serialize(Reflect.get(value, key), ancestors)}`)
    return `{${entries.join(',')}}`
  } finally {
    ancestors.delete(value)
  }
}

/** Encode a value using the locked `world-json/v1` canonical profile. */
export function canonicalizeWorldJson(value: WorldJsonValue): Uint8Array {
  return new TextEncoder().encode(serialize(value, new Set()))
}

/** Hash a complete, domain-separated World JSON envelope. */
export function hashWorldJson(kind: string, value: WorldJsonValue): WorldHash {
  assertLegalUnicode(kind)
  const bytes = canonicalizeWorldJson({ kind, hashVersion: 1, value })
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

/** Derive a stable opaque identifier without using clock or entropy state. */
export function deterministicId(prefix: string, value: WorldJsonValue): string {
  return `${prefix}:${hashWorldJson(`world-id/${prefix}`, value).slice('sha256:'.length, 'sha256:'.length + 24)}`
}
