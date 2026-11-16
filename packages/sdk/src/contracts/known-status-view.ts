import type { WorldJsonValue } from './world-json.ts'

export interface KnownStatusEntry {
  readonly key: string
  readonly holderId: string | null
  readonly value: WorldJsonValue
}
interface KnownStatusValues {
  public: Record<string, WorldJsonValue>
  characters: Record<string, Record<string, WorldJsonValue>>
}

/** Both author policy and knowledge conditions read this observer's known values, never global truth.
 * A reveal covers a whole status key: split data with different audiences into different keys. */
export function knownStatusView(
  entries: readonly KnownStatusEntry[],
  actorId: string,
): KnownStatusValues & { self: Record<string, WorldJsonValue> } {
  const view: KnownStatusValues = { public: {}, characters: {} }
  for (const entry of entries) {
    const values = entry.holderId === null ? view.public : (view.characters[entry.holderId] ??= {})
    values[entry.key] = structuredClone(entry.value)
  }
  return { ...view, self: view.characters[actorId] ?? {} }
}
