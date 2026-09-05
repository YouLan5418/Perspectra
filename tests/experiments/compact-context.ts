import { createHash } from 'node:crypto'
import type { SubmitActionsV2, CharacterId, WorldJsonObject } from '@harness-world/contracts'

export interface ExperimentMessage {
  readonly role: 'system' | 'developer' | 'user'
  readonly content: string
}

export type PromptMode = 'full' | 'compact'
export type ExperimentOutputMode = 'speech_only' | 'external_actions'
export const EXPERIMENT_RENDERER = 'ollama-experience-renderer/v3'

const segmentKinds = [
  'world_public_anchor', 'character_anchor', 'continuity_checkpoint', 'recent_interaction_tail',
  'current_self_state', 'current_scene', 'verified_recall', 'current_stimulus', 'affordances', 'output_reminder',
] as const

// Only protocol scaffolding is omitted. Narrative payloads are opaque, even if an
// author happens to use a key named sourceHash or address inside a proposition.
const technical = new Set([
  'schemaVersion', 'sourceRef', 'sourceRefs', 'basisRefs', 'summaryRefs',
  'address', 'checkpointId', 'checkpointHash', 'memoryEpoch', 'asOfWorldSeq',
  'sourceStartSeq', 'sourceEndSeq', 'startSeq', 'endSeq', 'afterSeq', 'asOfSeq',
  'roundId', 'transactionId', 'authorityHash', 'blockHash', 'tailHash', 'stateHash',
  'decisionHash', 'stimulusHash', 'sourceEventSeq', 'sourceEventHash', 'cycleId',
  'actionId', 'controllerClass', 'runtimeAvailability', 'directorEligible',
  'schedulableCharacterIds',
])
const opaque = new Set(['text', 'content', 'parameters', 'proposition', 'objective', 'cause', 'summary', 'description', 'impulseText'])
const referenceKeys = new Set(['id', 'key', 'observationId', 'projectionId', 'targetKey', 'targetKeys', 'blockerKeys'])

export function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('expected object')
  return value as Record<string, unknown>
}

export function byteHash(text: string): string {
  return `sha256:${createHash('sha256').update(text).digest('hex')}`
}

export function renderExperiment(
  messages: readonly ExperimentMessage[],
  mode: PromptMode,
  outputMode: ExperimentOutputMode = 'speech_only',
) {
  if (messages.length !== 12 || messages[0]?.role !== 'system' || messages[1]?.role !== 'developer') {
    throw new TypeError('experiment requires the known 12-segment Character Context')
  }
  const references = new Map<string, string>()
  const alias = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(alias)
    if (typeof value !== 'string') throw new TypeError('context reference must be a string')
    // Character/location/entity labels remain readable and retain their referents.
    if (/^(character|location|entity|scene):/.test(value)) return value
    if (!references.has(value)) references.set(value, `R${references.size + 1}`)
    return references.get(value)!
  }
  const compact = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(compact)
    if (value === null || typeof value !== 'object') return value
    return Object.fromEntries(Object.entries(object(value)).filter(([key]) => !technical.has(key))
      .map(([key, child]) => [key, opaque.has(key) ? child
        : referenceKeys.has(key) ? alias(child) : compact(child)]))
  }
  const sizes: { segment: string; beforeBytes: number; afterBytes: number }[] = []
  const rendered: ExperimentMessage[] = messages.map((message, index) => {
    let content: string
    let segment: string
    if (index < 2) {
      content = message.content
      segment = index === 0 ? 'host_protocol' : 'controller_contract'
    } else {
      const data = object(JSON.parse(message.content))
      segment = segmentKinds[index - 2]!
      if (message.role !== 'user' || data.segmentKind !== segment || !('content' in data)) {
        throw new TypeError('unknown or reordered experiment segment')
      }
      content = JSON.stringify(mode === 'full' ? data : {
        segmentKind: segment, content: compact(data.content),
      })
      if (segment === 'output_reminder') {
        // The host always supplies action identity. Only player-triggered calls may propose physical actions.
        content = JSON.stringify(outputMode === 'speech_only' ? {
          segmentKind: segment,
          content: { decision: 'act or abstain', text: '中文角色对白；abstain 时为空字符串',
            maximumSpeechActions: 1, reflectionAllowed: false },
        } : {
          segmentKind: segment,
          content: { decision: 'act or abstain', actions: ['speak', 'move', 'take'],
            maximumExternalActions: 2, hostSuppliesIdentity: true, reflectionAllowed: false },
        })
      }
    }
    sizes.push({ segment, beforeBytes: Buffer.byteLength(message.content), afterBytes: Buffer.byteLength(content) })
    return { role: message.role, content }
  })
  return {
    renderer: EXPERIMENT_RENDERER, mode, messages: rendered, sizes,
    // This stays in the experiment sidecar, never in the model-visible messages.
    references: [...references].map(([source, short]) => ({ short, source })),
    sourceMessagesHash: byteHash(JSON.stringify(messages)),
    renderedMessagesHash: byteHash(JSON.stringify(rendered)),
  }
}

export const speechSchema = {
  type: 'object', additionalProperties: false, required: ['decision', 'text'],
  properties: {
    decision: { type: 'string', enum: ['act', 'abstain'] },
    text: { type: 'string', maxLength: 500 },
  },
} as const

export const externalActionSchema = {
  type: 'object', additionalProperties: false, required: ['decision', 'actions'],
  properties: {
    decision: { type: 'string', enum: ['act', 'abstain'] },
    actions: {
      type: 'array', maxItems: 2, items: {
        type: 'object', additionalProperties: false, required: ['actionType', 'parameters'],
        properties: {
          actionType: { type: 'string', enum: ['speak', 'move', 'take'] },
          parameters: { type: 'object' },
        },
      },
    },
  },
} as const

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort()
  const sorted = [...expected].sort()
  return keys.length === sorted.length && keys.every((key, index) => key === sorted[index])
}

function requiredText(value: unknown, name: string, maximum = Number.MAX_SAFE_INTEGER): string {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0 || value.length > maximum) {
    throw new TypeError(`${name} is invalid`)
  }
  return value
}

export function externalActionProposal(
  raw: unknown,
  actorId: CharacterId,
  roundId: string,
): SubmitActionsV2 {
  const result = object(raw)
  if (!exactKeys(result, ['decision', 'actions']) || !Array.isArray(result.actions) || result.actions.length > 2) {
    throw new TypeError('invalid experimental action response')
  }
  const actions = result.actions.map((value, index) => {
    const action = object(value)
    if (!exactKeys(action, ['actionType', 'parameters'])) throw new TypeError('invalid experimental action')
    const parameters = object(action.parameters)
    let normalized: WorldJsonObject
    if (action.actionType === 'speak' && exactKeys(parameters, ['text'])) {
      normalized = { text: requiredText(parameters.text, 'speak.text', 500) }
    } else if (action.actionType === 'move' && exactKeys(parameters, ['locationId'])) {
      normalized = { locationId: requiredText(parameters.locationId, 'move.locationId') }
    } else if (action.actionType === 'take' && exactKeys(parameters, ['entityId'])) {
      normalized = { entityId: requiredText(parameters.entityId, 'take.entityId') }
    } else {
      throw new TypeError('unsupported or malformed experimental action')
    }
    return {
      actionId: `action:playtest:${actorId}:${roundId}:${index + 1}`,
      actorId, actionType: action.actionType, actionVersion: 1 as const, parameters: normalized,
    }
  })
  if (result.decision === 'abstain' && actions.length === 0) {
    return { schemaVersion: 2, decision: 'abstain', actions: [] }
  }
  if (result.decision !== 'act' || actions.length === 0) throw new TypeError('invalid action decision/actions')
  return { schemaVersion: 2, decision: 'act', actions }
}

export function speechProposal(raw: unknown, actorId: CharacterId, actionId: string): SubmitActionsV2 {
  const result = object(raw)
  if (Object.keys(result).sort().join(',') !== 'decision,text' || typeof result.text !== 'string'
    || result.text.length > 500) throw new TypeError('invalid experimental speech response')
  if (result.decision === 'abstain' && result.text === '') return { schemaVersion: 2, decision: 'abstain', actions: [] }
  if (result.decision !== 'act' || result.text.trim() === '') throw new TypeError('invalid speech decision/text')
  return { schemaVersion: 2, decision: 'act', actions: [{
    actorId, actionId, actionType: 'speak', actionVersion: 1, parameters: { text: result.text },
  }] }
}
