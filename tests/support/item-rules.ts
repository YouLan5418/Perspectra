import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/** The prototype-g1 items under the author template: the key can be taken, put down and handed over; the
 * thermos only taken. Packs copied from prototype-g1 carry these rules in their own scripts/status.js. */
export const PROTOTYPE_ITEM_RULES = {
  take: ['entity:brass-key', 'entity:thermos'],
  drop: ['entity:brass-key'],
  give: ['entity:brass-key'],
}

/**
 * A test status script with the pack's item rules added. Tests that replace a prototype-g1 copy's
 * scripts/status.js with their own status script would otherwise lose take, drop and give: this appends the
 * author template and folds its three operations into the script's operations, policy and resolve.
 */
export function withItemRules(script: string, rules = PROTOTYPE_ITEM_RULES): string {
  const template = readFileSync(resolve('examples/templates/item-rules.js'), 'utf8').replace(
    'const ITEM_RULES = { take: [], drop: [], give: [] }',
    'const ITEM_RULES = ' + JSON.stringify(rules),
  )
  return `${template}
${script}
;(() => {
  const script = globalThis.statusScript, policy = script.policy, resolve = script.resolve
  const own = script.definition.operations.map(op => op.id)
  script.definition.operations = [...script.definition.operations, ...itemOperations]
  script.policy = (known, actorId, place) => {
    const decided = policy ? policy(known, actorId, place) : null
    return {
      operations: [...(decided ? decided.operations : own), ...itemOperations.map(op => op.id)],
      targets: { ...(decided?.targets ?? {}), ...itemTargets(actorId, place) },
    }
  }
  script.resolve = (truth, actorId, operationId, parameters, world, targetId) =>
    ['take', 'drop', 'give'].includes(operationId)
      ? resolveItem(actorId, operationId, parameters, world, targetId)
      : resolve(truth, actorId, operationId, parameters, world, targetId)
})()
`
}

/** An NPC decision to perform one of the pack's item operations on an item. */
export function itemDecision(operation: 'take' | 'drop' | 'give', entityId: string, args: Record<string, string> = {}) {
  return {
    decision: 'perform',
    actionType: 'interact',
    parameters: {
      targetRef: { kind: 'entity', id: entityId },
      bindingId: 'status',
      definitionRef: { id: 'status:' + operation, version: 1 },
      arguments: args,
    },
  }
}

/** A status script holding only the given item rules, for a test pack that has no status of its own. */
export function itemRulesScript(rules: { take: string[]; drop: string[]; give: string[] }): string {
  return withItemRules(
    `globalThis.statusScript = {
  definition: { statuses: [], operations: [] },
  initialize(characterIds) {
    return { public: {}, characters: Object.fromEntries(characterIds.map(id => [id, {}])) }
  },
  resolve() {
    return { rejectReason: '没有这个操作' }
  },
}`,
    rules,
  )
}
