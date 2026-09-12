/**
 * A lean render of the twelve-segment Character Context: only what a character can act on.
 *
 * The Context is an audit-grade structure — identity, source ranges, hashes and machine ids on every leaf —
 * and a model needs almost none of it. The default experiment renderer removes a fixed list of machine
 * keys, but treats `content` as an opaque narrative payload, so everything nested one level down (an
 * observation's action id, its status, its null fields) survives into the prompt.
 *
 * This renderer projects each segment deliberately instead. Every field it keeps is one a character could
 * be asked about; everything else stays in the Context, the receipt and the explain surface, where it is
 * still auditable. The two fixed contracts pass through untouched — they are already written for a model.
 */
import {
  byteHash,
  object,
  segmentKinds,
  type ExperimentActionReference,
  type ExperimentMessage,
} from './compact-context.ts'

export const LEAN_RENDERER = 'lean-context-renderer/v1'

/** Machine keys that never explain a situation to a character, wherever they appear. */
const MACHINE_KEYS = new Set([
  'schemaVersion', 'sourceRef', 'sourceRefs', 'basisRefs', 'summaryRefs', 'address',
  'checkpointId', 'checkpointHash', 'memoryEpoch', 'asOfWorldSeq', 'sourceStartSeq', 'sourceEndSeq',
  'startSeq', 'endSeq', 'afterSeq', 'asOfSeq', 'roundId', 'transactionId', 'authorityHash',
  'blockHash', 'tailHash', 'stateHash', 'decisionHash', 'stimulusHash', 'sourceEventSeq',
  'sourceEventHash', 'captureHash', 'observationId', 'actionId', 'memoryId', 'summaryId',
  'cycleId', 'receiptId', 'planId', 'controllerClass', 'directorEligible', 'schedulableCharacterIds',
  'visibleResultCharacterIds', 'tenantId', 'worldId', 'branchId', 'actionVersion', 'memoryKind',
  'epistemicKind', 'status', 'source',
])

/** Read a string field, or undefined when it is absent or not a string. */
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** `character:alice` reads better as `alice`; a hashed machine id is dropped instead of shown. */
function shortName(value: unknown): string | undefined {
  const id = text(value)
  if (id === undefined) return undefined
  if (/^[a-z_]+:[0-9a-f]{8,}$/u.test(id)) return undefined
  return id.replace(/^(character|location|entity|scene|train|item):/u, '')
}

/** Drop machine keys and empty values, keeping every leaf a character could be told about. */
function lean(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(lean)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(object(value))
    .filter(([key, child]) => !MACHINE_KEYS.has(key) && child !== null
      && !(Array.isArray(child) && child.length === 0))
    .map(([key, child]) => [key, lean(child)]))
}

/** One observation as a line a character could repeat: who did what, in words. */
function leanObservation(observation: unknown): unknown {
  const outer = object(observation)
  const payload = outer.content
  if (payload === null || typeof payload !== 'object') return outer
  const wrapper = object(payload)
  // An observation wraps the committed action one level down; a plain notice is already that action.
  const action = wrapper.content !== null && typeof wrapper.content === 'object'
    ? object(wrapper.content)
    : wrapper
  const speaker = shortName(action.actorId)
  const speech = action.speech !== null && typeof action.speech === 'object' ? object(action.speech) : undefined
  const spoken = text(speech?.text)
  if (spoken !== undefined) {
    const scope = text(speech?.scope)
    return {
      ...(speaker === undefined ? {} : { speaker }),
      text: spoken,
      ...(scope === undefined || scope === 'scene_public' ? {} : { scope }),
    }
  }
  const act = text(action.actionType)
  const parameters = action.parameters !== null && typeof action.parameters === 'object'
    ? lean(action.parameters) as Record<string, unknown>
    : action.result !== null && typeof action.result === 'object'
    ? lean(action.result) as Record<string, unknown>
    : {}
  if (act === undefined) return { ...parameters }
  return { ...(speaker === undefined ? {} : { speaker }), act, ...parameters }
}

/** The cognitive records a character holds, split the way the Context already splits them. */
function leanCognition(entries: unknown): unknown[] {
  if (!Array.isArray(entries)) return []
  return entries.map(entry => {
    const record = object(entry)
    const value = record.value !== null && typeof record.value === 'object' ? object(record.value) : {}
    return { kind: record.kind, ...lean(value) as Record<string, unknown> }
  })
}

/**
 * One projector per segment. A projector sees the segment's own content and returns what a character is
 * told; anything it does not name stays out of the prompt.
 */
const PROJECTORS: Readonly<Record<string, (content: unknown) => unknown>> = {
  world_public_anchor: content => lean(content),
  character_anchor: content => {
    const anchor = object(content)
    const id = shortName(anchor.characterId)
    const at = shortName(anchor.locationId)
    return {
      ...(text(anchor.name) === undefined ? {} : { name: anchor.name }),
      ...(id === undefined ? {} : { id }),
      ...(text(anchor.pronouns) === undefined ? {} : { pronouns: anchor.pronouns }),
      ...(at === undefined ? {} : { at }),
      ...(anchor.portrayal === null || anchor.portrayal === undefined ? {} : { portrayal: lean(anchor.portrayal) }),
    }
  },
  continuity_checkpoint: content => {
    const segment = object(content)
    const digest = Array.isArray(segment.digest) ? segment.digest : []
    const checkpoint = segment.checkpoint !== null && typeof segment.checkpoint === 'object'
      ? object(segment.checkpoint)
      : {}
    return {
      // The digest is already prose: one line per Round the recent Tail no longer carries.
      earlierRounds: digest.map(entry => text(object(entry).text)).filter((line): line is string => line !== undefined),
      holds: leanCognition(checkpoint.activeCognition),
    }
  },
  recent_interaction_tail: content => {
    const tail = object(content)
    const blocks = Array.isArray(tail.blocks) ? tail.blocks : []
    return blocks.map(block => {
      const value = object(block)
      // One entry per observation, in order: the models reads the scene, not the ledger.
      const observations = Array.isArray(value.observations) ? value.observations : []
      return {
        ...(typeof value.tick === 'number' ? { round: value.tick } : {}),
        lines: observations.map(leanObservation),
      }
    })
  },
  current_self_state: content => {
    const state = object(content)
    return {
      ...(text(state.lifecycleState) === undefined ? {} : { lifecycleState: state.lifecycleState }),
      ...(shortName(state.locationId) === undefined ? {} : { at: shortName(state.locationId) }),
      ...(text(state.runtimeAvailability) === undefined ? {} : { availability: state.runtimeAvailability }),
      // Awareness splits the same records the Context already splits: known, and felt but unacknowledged.
      knows: leanCognition(state.consciousState),
      ...(Array.isArray(state.latentGuidance) && state.latentGuidance.length > 0
        ? { unacknowledged: leanCognition(state.latentGuidance) }
        : {}),
    }
  },
  current_scene: content => {
    const scene = object(content)
    const members = (value: unknown) => (Array.isArray(value) ? value : [])
      .map(shortName).filter((name): name is string => name !== undefined)
    return {
      scene: text(scene.sceneId),
      present: members(scene.memberIds),
      observing: members(scene.observerIds),
    }
  },
  verified_recall: content => {
    if (!Array.isArray(content)) return []
    return content.map(entry => {
      const memory = object(entry)
      return { kind: memory.memoryKind, text: memory.text }
    })
  },
  current_stimulus: content => {
    const stimulus = object(content)
    const parameters = stimulus.parameters !== null && typeof stimulus.parameters === 'object'
      ? object(stimulus.parameters)
      : {}
    return {
      from: shortName(stimulus.actorId),
      act: stimulus.actionType,
      ...lean(parameters) as Record<string, unknown>,
    }
  },
  affordances: content => {
    if (!Array.isArray(content)) return []
    return content.map(entry => object(entry).actionType)
  },
  output_reminder: content => lean(content),
}

export interface LeanRenderResult {
  readonly renderer: string
  readonly messages: readonly ExperimentMessage[]
  readonly sizes: readonly { readonly segment: string; readonly beforeBytes: number; readonly afterBytes: number }[]
  readonly sourceMessagesHash: string
  readonly renderedMessagesHash: string
  readonly actionReferences: readonly ExperimentActionReference[]
  /**
   * Empty on purpose: this projection names things in words rather than aliasing their identifiers, so
   * there is no short-name table for a caller to resolve.
   */
  readonly references: readonly { readonly short: string; readonly source: string }[]
}

/** Render the twelve-segment Context as the lean prompt: same structure, only the parts a character needs. */
export function renderLeanContext(
  messages: readonly ExperimentMessage[],
  actionReferences: readonly ExperimentActionReference[] = [],
): LeanRenderResult {
  if (messages.length !== 12 || messages[0]?.role !== 'system' || messages[1]?.role !== 'developer') {
    throw new TypeError('lean rendering requires the known 12-segment Character Context')
  }
  const sizes: { segment: string; beforeBytes: number; afterBytes: number }[] = []
  const seen = new Set<string>()
  const rendered = messages.map((message, index) => {
    let content: string
    let segment: string
    if (index < 2) {
      content = message.content
      segment = index === 0 ? 'host_protocol' : 'controller_contract'
    } else {
      const data = object(JSON.parse(message.content))
      segment = typeof data.segmentKind === 'string' ? data.segmentKind : ''
      if (message.role !== 'user' || !(segmentKinds as readonly string[]).includes(segment) || !('content' in data)) {
        throw new TypeError('unknown or reordered segment')
      }
      const projector = PROJECTORS[segment]
      if (projector === undefined) throw new TypeError(`no lean projection for ${segment}`)
      content = JSON.stringify({ segmentKind: segment, content: projector(data.content) })
    }
    // Only the data segments are counted: the two contracts are fixed and are not in `segmentKinds`.
    if (index >= 2) seen.add(segment)
    sizes.push({ segment, beforeBytes: Buffer.byteLength(message.content), afterBytes: Buffer.byteLength(content) })
    return { role: message.role, content }
  })
  // Order is free, but the set is not: every known segment exactly once, no substitutes, no duplicates.
  if (seen.size !== segmentKinds.length) {
    throw new TypeError('experiment Context does not carry every segment exactly once')
  }
  return {
    renderer: LEAN_RENDERER,
    messages: rendered,
    sizes,
    sourceMessagesHash: byteHash(JSON.stringify(messages)),
    renderedMessagesHash: byteHash(JSON.stringify(rendered)),
    actionReferences,
    references: [],
  }
}
