import { assertProtocolString, canonicalizeWorldJson, compareWorldText, type WorldJsonValue } from '@harness-world/contracts'
import type { ActionAffordance, PlayerActionInput } from '@harness-world/kernel'

export type PlayerInputInterpretation =
  | { readonly status: 'resolved'; readonly action: PlayerActionInput }
  | { readonly status: 'clarification_required'; readonly reason: string; readonly candidates: readonly string[] }

function clarification(reason: string, candidates: readonly string[]): PlayerInputInterpretation {
  return { status: 'clarification_required', reason, candidates: [...new Set(candidates)].sort(compareWorldText) }
}

/** Product-neutral deterministic text adapter. It creates candidate Actions, never world facts. */
export class PlayerInputInterpreter {
  interpret(text: string, affordances: readonly ActionAffordance[]): PlayerInputInterpretation {
    assertProtocolString(text, 'player text')
    const allowed = new Set<string>()
    for (const affordance of affordances) {
      assertProtocolString(affordance.actionType, 'Action Affordance type')
      if (!Number.isSafeInteger(affordance.actionVersion) || affordance.actionVersion < 1) {
        throw new TypeError('Action Affordance version must be a positive safe integer')
      }
      allowed.add(affordance.actionType)
    }
    if (!text.startsWith('/')) return this.#action('speak', { text }, allowed)

    const move = /^\/move(?:\s+(.+))?$/u.exec(text)
    if (move !== null) {
      return move[1] === undefined || /\s/u.test(move[1])
        ? clarification('move requires exactly one locationId', ['move'])
        : this.#action('move', { locationId: move[1] }, allowed)
    }
    const take = /^\/take(?:\s+(.+))?$/u.exec(text)
    if (take !== null) {
      return take[1] === undefined || /\s/u.test(take[1])
        ? clarification('take requires exactly one entityId', ['take'])
        : this.#action('take', { entityId: take[1] }, allowed)
    }
    if (text === '/act' || text.startsWith('/act ')) return this.#explicitAction(text, allowed)
    return clarification('unknown player command', [...allowed])
  }

  #explicitAction(text: string, allowed: ReadonlySet<string>): PlayerInputInterpretation {
    const match = /^\/act\s+(\S+)\s+(.+)$/u.exec(text)
    if (match === null) return clarification('act requires an actionType and canonical JSON parameters', [...allowed])
    let parameters: WorldJsonValue
    try {
      parameters = JSON.parse(match[2]!) as WorldJsonValue
      canonicalizeWorldJson(parameters)
    } catch {
      return clarification('act parameters must be valid World JSON', [match[1]!])
    }
    return this.#action(match[1]!, parameters, allowed)
  }

  #action(actionType: string, parameters: WorldJsonValue, allowed: ReadonlySet<string>): PlayerInputInterpretation {
    if (!allowed.has(actionType)) return clarification('action is not currently afforded', [...allowed])
    return { status: 'resolved', action: { actionType, parameters } }
  }
}
