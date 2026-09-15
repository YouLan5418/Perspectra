import type { WorldJsonObject } from '@harness-world/contracts'

/**
 * A non-empty string, or nothing. Both the Host's assembled context and a vendor's response are untrusted
 * as far as this adapter is concerned: every value it reads is read through one of these two helpers, so
 * a shape it did not expect becomes an absent value rather than an exception from inside a renderer.
 */
export function textValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** A plain JSON object, or nothing. Arrays and nulls are not objects here. */
export function objectValue(value: unknown): WorldJsonObject | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as WorldJsonObject : undefined
}
