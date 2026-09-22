import { brandId, type CharacterId, type WorldAddress, type WorldJsonObject } from '@harness-world/contracts'
import type { WorldStore } from '@harness-world/store-sqlite'
import type { PrototypeCharacterTurn, PrototypeTurnResult } from './prototype-character-turn.ts'

/** Ephemeral, bounded scheduling; committed observations survive, unfinished activations need not. */
export async function runPrototypeActivations(input: {
  store: WorldStore; address: WorldAddress; turn: PrototypeCharacterTurn; afterSeq: number;
  characterIds: readonly CharacterId[]; signal: AbortSignal;
}) {
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(30_000)])
  const activations: { characterId: CharacterId; result: PrototypeTurnResult }[] = []
  const counts = new Map<CharacterId, number>()
  let calls = 0, wave = 0
  const candidates = (afterSeq: number) => {
    const result = new Map<CharacterId, WorldJsonObject[]>()
    for (const event of input.store.readEvents(input.address)) {
      if (event.seq <= afterSeq || event.eventType !== 'observation.upsert') continue
      const value = (event.data as WorldJsonObject).value as WorldJsonObject
      const content = value.content as WorldJsonObject | undefined
      if (content === undefined || content.status !== 'accepted' || content.actorId === value.observerId) continue
      const id = brandId(String(value.observerId), 'CharacterId')
      if (!input.characterIds.includes(id)) continue
      const speech = content.speech as WorldJsonObject | undefined
      if (speech !== undefined && typeof speech.text === 'string' && speech.text.trim() === ''
        && !(speech.addresseeIds as string[] | undefined)?.includes(id)) continue
      const entries = result.get(id) ?? []
      entries.push(value); result.set(id, entries)
    }
    return result
  }
  let pending = candidates(input.afterSeq)
  for (wave = 1; wave <= 3 && pending.size > 0; wave++) {
    const before = input.store.head(input.address).headSeq
    for (const characterId of input.characterIds) {
      if (!pending.has(characterId) || (counts.get(characterId) ?? 0) >= 2) continue
      if (signal.aborted) return { calls, wave, terminalReason: 'interrupted', activations }
      // Reserve both calls so a committed perform never loses its reply slot to another character.
      if (calls + 2 > 8) return { calls, wave, terminalReason: 'call_limit', activations }
      const result = await input.turn.run(characterId, { signal, stimulus: pending.get(characterId)! })
      calls += result.calls
      counts.set(characterId, (counts.get(characterId) ?? 0) + 1)
      activations.push({ characterId, result })
      if (result.status === 'failed' || result.status === 'interrupted') {
        return { calls, wave, terminalReason: result.status, activations }
      }
    }
    pending = candidates(before)
    for (const id of pending.keys()) if ((counts.get(id) ?? 0) >= 2) pending.delete(id)
  }
  return { calls, wave: Math.min(wave - 1, 3), terminalReason: pending.size ? 'wave_limit' : 'quiescent', activations }
}
