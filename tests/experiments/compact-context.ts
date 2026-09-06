import { createHash } from 'node:crypto'
import {
  CLAIM_STANCES,
  type CharacterId,
  type CognitionProjectionKind,
  type ContextSourceRef,
  compareWorldText,
  type SubmitActionsV2,
  type WorldHash,
  type WorldJsonObject,
} from '@harness-world/contracts'

export interface ExperimentMessage {
  readonly role: 'system' | 'developer' | 'user'
  readonly content: string
}

export type PromptMode = 'full' | 'compact'
export type ExperimentOutputMode = 'speech_only' | 'external_actions'
export const EXPERIMENT_RENDERER = 'ollama-experience-renderer/v4'

export interface ExperimentActionReference {
  readonly kind: 'location' | 'entity'
  readonly short: string
  readonly source: string
  readonly label: string
  readonly locationSource?: string
}

export function createExperimentActionReferences(input: {
  readonly locations: readonly { readonly locationId: string; readonly name: string }[]
  readonly entities: readonly { readonly entityId: string; readonly kind: string; readonly locationId: string }[]
}): readonly ExperimentActionReference[] {
  const locations: ExperimentActionReference[] = [...input.locations]
    .sort((left, right) => compareWorldText(left.locationId, right.locationId))
    .map((location, index) => ({
      kind: 'location', short: `L${index + 1}`, source: location.locationId, label: location.name,
    }))
  const entities: ExperimentActionReference[] = [...input.entities]
    .sort((left, right) => compareWorldText(left.entityId, right.entityId))
    .map((entity, index) => ({
      kind: 'entity', short: `E${index + 1}`, source: entity.entityId,
      label: entity.kind, locationSource: entity.locationId,
    }))
  return [...locations, ...entities]
}

export function availableExperimentActionReferences(
  references: readonly ExperimentActionReference[],
  currentLocationId: unknown,
): readonly ExperimentActionReference[] {
  let locationOrdinal = 0
  let entityOrdinal = 0
  return references.filter(reference => reference.kind === 'location'
    ? reference.source !== currentLocationId
    : reference.locationSource === currentLocationId).map(reference => ({
      ...reference,
      short: reference.kind === 'location' ? `L${++locationOrdinal}` : `E${++entityOrdinal}`,
    }))
}

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
  actionReferences: readonly ExperimentActionReference[] = [],
) {
  if (messages.length !== 12 || messages[0]?.role !== 'system' || messages[1]?.role !== 'developer') {
    throw new TypeError('experiment requires the known 12-segment Character Context')
  }
  const currentSelfState = object(object(JSON.parse(messages[6]!.content)).content)
  const currentLocationId = currentSelfState.locationId
  const availableActionReferences = availableExperimentActionReferences(actionReferences, currentLocationId)
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
      if (segment === 'affordances' && outputMode === 'external_actions' && actionReferences.length > 0) {
        const locations = availableActionReferences.filter(reference => reference.kind === 'location')
        const entities = availableActionReferences.filter(reference => reference.kind === 'entity')
        const actions = (Array.isArray(data.content) ? data.content : []).filter(value => {
          const actionType = object(value).actionType
          if (actionType === 'move') return locations.length > 0
          if (actionType === 'take') return entities.length > 0
          return true
        }).map(compact)
        content = JSON.stringify({
          segmentKind: segment,
          content: {
            actions,
            parameterDomains: {
              move: locations.map(reference => ({ locationRef: reference.short, name: reference.label })),
              take: entities.map(reference => ({ entityRef: reference.short, kind: reference.label })),
            },
          },
        })
      }
      if (segment === 'output_reminder') {
        // The host always supplies action identity. Only player-triggered calls may propose physical actions.
        content = JSON.stringify(outputMode === 'speech_only' ? {
          segmentKind: segment,
          content: { decision: 'act or abstain', text: '中文角色对白；abstain 时为空字符串',
            maximumSpeechActions: 1, reflectionAllowed: false },
        } : {
          segmentKind: segment,
          content: { decision: 'act or abstain', actions: ['speak', 'move', 'take'],
            maximumExternalActions: 2, hostSuppliesIdentity: true,
            reflection: { mode: 'update_existing_self_state', maximumOperations: 1, hostSuppliesProvenance: true } },
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
    actionReferences: availableActionReferences,
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
    reflection: {
      type: 'array', maxItems: 1, items: {
        type: 'object', additionalProperties: false, required: ['recordRef', 'changes'],
        properties: {
          recordRef: { type: 'string', pattern: '^R[1-9][0-9]*$' },
          changes: { type: 'object' },
        },
      },
    },
  },
} as const

export function externalActionSchemaFor(actionReferences: readonly ExperimentActionReference[]) {
  const locations = actionReferences.filter(reference => reference.kind === 'location').map(reference => reference.short)
  const entities = actionReferences.filter(reference => reference.kind === 'entity').map(reference => reference.short)
  const actionVariants: Record<string, unknown>[] = [{
    type: 'object', additionalProperties: false, required: ['actionType', 'parameters'],
    properties: {
      actionType: { type: 'string', const: 'speak' },
      parameters: { type: 'object', additionalProperties: false, required: ['text'],
        properties: { text: { type: 'string', maxLength: 500 } } },
    },
  }]
  if (locations.length > 0) actionVariants.push({
    type: 'object', additionalProperties: false, required: ['actionType', 'parameters'],
    properties: {
      actionType: { type: 'string', const: 'move' },
      parameters: { type: 'object', additionalProperties: false, required: ['locationRef'],
        properties: { locationRef: { type: 'string', enum: locations } } },
    },
  })
  if (entities.length > 0) actionVariants.push({
    type: 'object', additionalProperties: false, required: ['actionType', 'parameters'],
    properties: {
      actionType: { type: 'string', const: 'take' },
      parameters: { type: 'object', additionalProperties: false, required: ['entityRef'],
        properties: { entityRef: { type: 'string', enum: entities } } },
    },
  })
  return {
    ...externalActionSchema,
    properties: {
      ...externalActionSchema.properties,
      actions: { type: 'array', maxItems: 2, items: { oneOf: actionVariants } },
    },
  } as const
}

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

function hash(value: unknown, name: string): WorldHash {
  if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(value)) throw new TypeError(`${name} is invalid`)
  return value as WorldHash
}

function permille(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 1000) {
    throw new TypeError(`${name} is invalid`)
  }
  return value as number
}

function sourceRef(value: unknown): ContextSourceRef {
  const source = object(value)
  if (!exactKeys(source, ['sourceKind', 'sourceId', 'sourceSeq', 'sourceHash'])
    || typeof source.sourceKind !== 'string' || typeof source.sourceId !== 'string'
    || !Number.isSafeInteger(source.sourceSeq) || (source.sourceSeq as number) < 0) {
    throw new TypeError('reflection source reference is invalid')
  }
  return {
    sourceKind: requiredText(source.sourceKind, 'sourceKind'),
    sourceId: requiredText(source.sourceId, 'sourceId'),
    sourceSeq: source.sourceSeq as number,
    sourceHash: hash(source.sourceHash, 'sourceHash'),
  }
}

export interface ExperimentReflectionContext {
  readonly exactMessages: readonly ExperimentMessage[]
  readonly references: readonly { readonly short: string; readonly source: string }[]
  readonly actionReferences?: readonly ExperimentActionReference[]
}

function segment(messages: readonly ExperimentMessage[], kind: string): Record<string, unknown> {
  for (const message of messages.slice(2)) {
    const parsed = object(JSON.parse(message.content))
    if (parsed.segmentKind === kind) return parsed
  }
  throw new TypeError(`missing ${kind} segment`)
}

function changedPermille(
  changes: Record<string, unknown>,
  field: string,
  previous: WorldJsonObject,
): number | undefined {
  if (!(field in changes)) return undefined
  const next = permille(changes[field], field)
  const before = previous[field]
  if (typeof before !== 'number' || Math.abs(next - before) > 200) throw new TypeError(`${field} change is too large`)
  return next
}

function reflectionValue(kind: CognitionProjectionKind, raw: unknown, previous: WorldJsonObject): WorldJsonObject {
  const changes = object(raw)
  if (Object.keys(changes).length === 0) throw new TypeError('reflection changes are empty')
  if (kind === 'subjective-claim') {
    if (Object.keys(changes).some(key => !['stance', 'confidencePermille'].includes(key))) {
      throw new TypeError('unsupported subjective-claim change')
    }
    const stance = 'stance' in changes
      ? requiredText(changes.stance, 'stance')
      : undefined
    if (stance !== undefined && !CLAIM_STANCES.includes(stance as typeof CLAIM_STANCES[number])) {
      throw new TypeError('unsupported claim stance')
    }
    const confidencePermille = changedPermille(changes, 'confidencePermille', previous)
    return { ...previous, ...(stance === undefined ? {} : { stance }),
      ...(confidencePermille === undefined ? {} : { confidencePermille }) }
  }
  if (kind === 'relationship-attitude') {
    if (Object.keys(changes).some(key => !['intensityPermille', 'confidencePermille'].includes(key))) {
      throw new TypeError('unsupported relationship change')
    }
    const intensityPermille = changedPermille(changes, 'intensityPermille', previous)
    const confidencePermille = changedPermille(changes, 'confidencePermille', previous)
    return { ...previous, ...(intensityPermille === undefined ? {} : { intensityPermille }),
      ...(confidencePermille === undefined ? {} : { confidencePermille }) }
  }
  if (kind === 'character-goal') {
    if (Object.keys(changes).some(key => !['priorityPermille', 'status'].includes(key))) {
      throw new TypeError('unsupported character-goal change')
    }
    const priorityPermille = changedPermille(changes, 'priorityPermille', previous)
    const status = 'status' in changes ? requiredText(changes.status, 'status') : undefined
    if (status !== undefined && status !== 'active' && status !== 'blocked') {
      throw new TypeError('playtest cannot make a goal terminal')
    }
    return { ...previous, ...(priorityPermille === undefined ? {} : { priorityPermille }),
      ...(status === undefined ? {} : { status }) }
  }
  throw new TypeError('reflection record kind is not enabled in playtest')
}

function reflectionOperations(
  raw: unknown,
  actorId: CharacterId,
  roundId: string,
  context: ExperimentReflectionContext | undefined,
): NonNullable<SubmitActionsV2['reflection']> | undefined {
  if (raw === undefined) return undefined
  if (context === undefined || !Array.isArray(raw) || raw.length > 1) throw new TypeError('invalid experimental reflection')
  if (raw.length === 0) return { operations: [] }
  const self = object(segment(context.exactMessages, 'current_self_state').content)
  const records = [...(Array.isArray(self.consciousState) ? self.consciousState : []),
    ...(Array.isArray(self.latentGuidance) ? self.latentGuidance : [])].map(value => object(value))
  const stimulus = segment(context.exactMessages, 'current_stimulus')
  if (!Array.isArray(stimulus.sourceRefs) || stimulus.sourceRefs.length === 0) {
    throw new TypeError('reflection has no current stimulus provenance')
  }
  const proposal = object(raw[0])
  if (!exactKeys(proposal, ['recordRef', 'changes'])) throw new TypeError('invalid experimental reflection operation')
  const recordRef = requiredText(proposal.recordRef, 'recordRef')
  const recordId = context.references.find(value => value.short === recordRef)?.source
  if (recordId === undefined) throw new TypeError('reflection record reference is unknown')
  const record = records.find(value => value.id === recordId)
  if (record === undefined || typeof record.kind !== 'string') throw new TypeError('reflection record is not current self state')
  const kind = record.kind as CognitionProjectionKind
  const previous = object(record.value) as WorldJsonObject
  return { operations: [{
    operationId: `operation:playtest:${actorId}:${roundId}:1`,
    kind,
    recordId,
    expectedStateHash: hash(record.stateHash, 'stateHash'),
    basisRefs: stimulus.sourceRefs.map(sourceRef),
    value: reflectionValue(kind, proposal.changes, previous),
  }] }
}

export function externalActionProposal(
  raw: unknown,
  actorId: CharacterId,
  roundId: string,
  reflectionContext?: ExperimentReflectionContext,
): SubmitActionsV2 {
  const result = object(raw)
  const keys = Object.keys(result)
  if (!['decision', 'actions'].every(key => key in result)
    || keys.some(key => !['decision', 'actions', 'reflection'].includes(key))
    || !Array.isArray(result.actions) || result.actions.length > 2) {
    throw new TypeError('invalid experimental action response')
  }
  const actions = result.actions.map((value, index) => {
    const action = object(value)
    if (!exactKeys(action, ['actionType', 'parameters'])) throw new TypeError('invalid experimental action')
    const parameters = object(action.parameters)
    let normalized: WorldJsonObject
    if (action.actionType === 'speak' && exactKeys(parameters, ['text'])) {
      normalized = { text: requiredText(parameters.text, 'speak.text', 500) }
    } else if (action.actionType === 'move' && reflectionContext?.actionReferences !== undefined
      && exactKeys(parameters, ['locationRef'])) {
      const locationRef = requiredText(parameters.locationRef, 'move.locationRef')
      const location = reflectionContext.actionReferences.find(reference => reference.kind === 'location'
        && reference.short === locationRef)
      if (location === undefined) throw new TypeError('move.locationRef is unknown')
      normalized = { locationId: location.source }
    } else if (action.actionType === 'take' && reflectionContext?.actionReferences !== undefined
      && exactKeys(parameters, ['entityRef'])) {
      const entityRef = requiredText(parameters.entityRef, 'take.entityRef')
      const entity = reflectionContext.actionReferences.find(reference => reference.kind === 'entity'
        && reference.short === entityRef)
      if (entity === undefined) throw new TypeError('take.entityRef is unknown')
      normalized = { entityId: entity.source }
    } else if (action.actionType === 'move' && reflectionContext?.actionReferences === undefined
      && exactKeys(parameters, ['locationId'])) {
      normalized = { locationId: requiredText(parameters.locationId, 'move.locationId') }
    } else if (action.actionType === 'take' && reflectionContext?.actionReferences === undefined
      && exactKeys(parameters, ['entityId'])) {
      normalized = { entityId: requiredText(parameters.entityId, 'take.entityId') }
    } else {
      throw new TypeError('unsupported or malformed experimental action')
    }
    return {
      actionId: `action:playtest:${actorId}:${roundId}:${index + 1}`,
      actorId, actionType: action.actionType, actionVersion: 1 as const, parameters: normalized,
    }
  })
  const reflection = reflectionOperations(result.reflection, actorId, roundId, reflectionContext)
  if (result.decision === 'abstain' && actions.length === 0) {
    return { schemaVersion: 2, decision: 'abstain', actions: [], ...(reflection === undefined ? {} : { reflection }) }
  }
  if (result.decision !== 'act' || actions.length === 0) throw new TypeError('invalid action decision/actions')
  return { schemaVersion: 2, decision: 'act', actions, ...(reflection === undefined ? {} : { reflection }) }
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
