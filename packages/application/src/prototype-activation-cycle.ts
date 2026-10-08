import { publicationSegments } from '@harness-world/contracts'
import { brandId, type CharacterId, type WorldAddress, type WorldJsonObject } from '@harness-world/contracts'
import type { WorldStore } from '@harness-world/store-sqlite'
import type { PrototypeCharacterTurn, PrototypeTurnResult } from './prototype-character-turn.ts'

/** Ephemeral, bounded scheduling; committed observations survive, unfinished activations need not. */
export async function runPrototypeActivations(input: {
  store: WorldStore; address: WorldAddress; turn: PrototypeCharacterTurn; afterSeq: number;
  characterIds: readonly CharacterId[]; signal: AbortSignal;
  limits?: { readonly maximumWaves: number; readonly maximumNpcCalls: number; readonly maximumCallsPerCharacter: number; readonly reactionDeadlineSeconds?: number };
}) {
  const limits = input.limits ?? { maximumWaves: 3, maximumNpcCalls: 8, maximumCallsPerCharacter: 2 }
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout((limits.reactionDeadlineSeconds ?? 30) * 1_000)])
  const activations: { characterId: CharacterId; result: PrototypeTurnResult }[] = []
  const counts = new Map<CharacterId, number>()
  let calls = 0, wave = 0, hitCharacterLimit = false
  const candidates = (afterSeq: number, rootStimulus = false) => {
    const result = new Map<CharacterId, WorldJsonObject[]>()
    for (const event of input.store.readEvents(input.address)) {
      if (event.seq <= afterSeq || event.eventType !== 'observation.upsert') continue
      const value = (event.data as WorldJsonObject).value as WorldJsonObject
      const content = value.content as WorldJsonObject | undefined
      if (content === undefined || content.status !== 'accepted' || content.actorId === value.observerId) continue
      const id = brandId(String(value.observerId), 'CharacterId')
      if (!input.characterIds.includes(id)) continue
      const speech = content.speech as WorldJsonObject | undefined
      if (!rootStimulus && speech !== undefined && !publicationSegments(speech).some(segment => segment.type === 'speech' && segment.text.trim())
        && !(speech.addresseeIds as string[] | undefined)?.includes(id)) continue
      const entries = result.get(id) ?? []
      entries.push(value); result.set(id, entries)
    }
    return result
  }
  let pending = candidates(input.afterSeq, true)
  for (wave = 1; wave <= limits.maximumWaves && pending.size > 0; wave++) {
    const before = input.store.head(input.address).headSeq
    for (const characterId of input.characterIds) {
      if (!pending.has(characterId) || (counts.get(characterId) ?? 0) >= limits.maximumCallsPerCharacter) continue
      if (signal.aborted) return { calls, wave, terminalReason: 'interrupted', activations }
      // Reserve the result-aware reply slot; a second operation is offered only with a third slot reserved.
      if (calls + 2 > limits.maximumNpcCalls) return { calls, wave, terminalReason: 'call_limit', activations }
      const result = await input.turn.run(characterId, { signal, stimulus: pending.get(characterId)!,
        maxCalls: calls + 3 <= limits.maximumNpcCalls ? 3 : 2 })
      calls += result.calls
      counts.set(characterId, (counts.get(characterId) ?? 0) + 1)
      activations.push({ characterId, result })
      if (result.status === 'failed' || result.status === 'interrupted') {
        return { calls, wave, terminalReason: result.status, activations }
      }
    }
    pending = candidates(before)
    for (const id of pending.keys()) if ((counts.get(id) ?? 0) >= limits.maximumCallsPerCharacter) {
      pending.delete(id); hitCharacterLimit = true
    }
  }
  return { calls, wave: Math.min(wave - 1, limits.maximumWaves), terminalReason: pending.size ? 'wave_limit' : hitCharacterLimit ? 'character_limit' : 'quiescent', activations }
}
