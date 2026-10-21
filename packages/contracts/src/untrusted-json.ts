import { protocolStringProblem } from './ids.ts'
import type { WorldHash } from './world-json.ts'

/**
 * Checks for JSON read from storage, files or a model before it is trusted. Each check reports through
 * the caller's `fail`, so a Manifest reader can throw a TypeError while a world-pack reader raises a
 * diagnostic with a code and JSON pointer, and both still apply the same rules.
 */
export type UntrustedJsonFailure = 'invalid' | 'unknown_field' | 'missing_field' | 'duplicate'
export type UntrustedJsonFail = (failure: UntrustedJsonFailure, path: string, message: string) => never

export const failWithTypeError: UntrustedJsonFail = (_failure, path, message) => {
  throw new TypeError(`${path} ${message}`)
}

const WORLD_HASH = /^sha256:[0-9a-f]{64}$/u

/** A plain JSON object: not null and not an array. */
export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Whether the object has exactly these keys, in any order. */
export function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const names = Object.keys(value)
  return names.length === keys.length && keys.every(key => Object.hasOwn(value, key))
}

export function jsonObjectAt(value: unknown, path: string, fail: UntrustedJsonFail = failWithTypeError): Record<string, unknown> {
  if (!isJsonObject(value)) fail('invalid', path, 'must be an object')
  return value
}

export function jsonArrayAt(value: unknown, path: string, fail: UntrustedJsonFail = failWithTypeError): readonly unknown[] {
  if (!Array.isArray(value)) fail('invalid', path, 'must be an array')
  return value
}

/** A non-empty, unpadded string without control characters. */
export function jsonTextAt(value: unknown, path: string, fail: UntrustedJsonFail = failWithTypeError): string {
  if (typeof value !== 'string') fail('invalid', path, 'must be a string')
  const problem = protocolStringProblem(value)
  if (problem !== undefined) fail('invalid', path, problem)
  return value
}

export function jsonHashAt(value: unknown, path: string, fail: UntrustedJsonFail = failWithTypeError): WorldHash {
  const hash = jsonTextAt(value, path, fail)
  if (!WORLD_HASH.test(hash)) fail('invalid', path, 'must be a lowercase sha256 hash')
  return hash as WorldHash
}

export interface JsonKeysOptions {
  readonly optional?: readonly string[]
  readonly fail?: UntrustedJsonFail
  /** How a field's path is written; a world-pack reader passes an escaped JSON pointer. */
  readonly child?: (path: string, key: string) => string
}

/** Reject unknown keys, then require every `required` key; `optional` keys may be absent. */
export function jsonKeysAt(
  value: Record<string, unknown>,
  path: string,
  required: readonly string[],
  options: JsonKeysOptions = {},
): void {
  const fail = options.fail ?? failWithTypeError
  const child = options.child ?? ((parent: string, key: string) => `${parent}.${key}`)
  const allowed = new Set([...required, ...(options.optional ?? [])])
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail('unknown_field', child(path, key), 'is not allowed')
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) fail('missing_field', child(path, key), 'is required')
  }
}

export function jsonUniqueAt(values: readonly string[], path: string, fail: UntrustedJsonFail = failWithTypeError): void {
  if (new Set(values).size !== values.length) fail('duplicate', path, 'contains duplicate values')
}
