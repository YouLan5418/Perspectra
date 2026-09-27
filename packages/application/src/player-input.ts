import { assertProtocolString, canonicalizeWorldJson, compareWorldText, type WorldJsonObject, type WorldJsonValue } from '@harness-world/contracts'
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
    const narration = /^\/narrate(?:\s+(.+))?$/u.exec(text)
    if (narration !== null) return narration[1] === undefined
      ? clarification('narrate requires text', ['speak'])
      : this.#action('speak', { text: '', narration: narration[1] }, allowed)
    const custody = /^\/(take|give|drop)(?:\s+(.*))?$/u.exec(text)
    if (custody !== null) {
      const verb = custody[1]!
      const args = custody[2]?.split(/\s+/u) ?? []
      if (args.length !== (verb === 'give' ? 2 : 1) || args.some(arg => !arg)) {
        return clarification(`${verb} requires exactly ${verb === 'give' ? 'one entityId and one recipientId' : 'one entityId'}`, [verb])
      }
      const choices = affordances.filter(a => a.actionType === 'interact').flatMap(a => a.interactions ?? [])
        .filter(p => (p.targetRef as WorldJsonObject | undefined)?.kind === 'entity'
          && (p.targetRef as WorldJsonObject).id === args[0]
          && (p.definitionRef as WorldJsonObject | undefined)?.id === `base:${verb}`
          && (verb !== 'give' || (p.arguments as WorldJsonObject | undefined)?.recipientId === args[1]))
      if (choices.length === 1) {
        const { label: _, ...parameters } = choices[0]!
        return this.#action('interact', parameters, allowed)
      }
      // Older rulebooks can expose a direct take action. It still needs an explicit command.
      if (verb === 'take' && choices.length === 0 && allowed.has('take')) return this.#action('take', { entityId: args[0]! }, allowed)
      return clarification(choices.length > 1 ? 'command matches multiple interactions; use /act' : 'interaction is not currently afforded', ['interact'])
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
