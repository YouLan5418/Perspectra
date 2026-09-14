import type { ActionRequest, WorldJsonObject } from './index.ts'

/** Closed initial vocabulary: no free narration can become a manifestation fact. */
export const ACTION_GROUP_CUES = {
  smile: { channel: 'facial', description: '微微一笑', actionType: null },
  frown: { channel: 'facial', description: '微微皱眉', actionType: null },
  nod: { channel: 'gesture', description: '点了点头', actionType: null },
  shake_head: { channel: 'gesture', description: '摇了摇头', actionType: null },
  avert_gaze: { channel: 'gaze', description: '移开视线', actionType: null },
  quiet_voice: { channel: 'voice', description: '说话声音很轻', actionType: 'speak' },
  trembling_voice: { channel: 'voice', description: '说话声音微微发颤', actionType: 'speak' },
  slow_walk: { channel: 'gesture', description: '移动时步伐缓慢', actionType: 'move' },
} as const

export type ActionGroupCue = keyof typeof ACTION_GROUP_CUES

/** Model-facing schema derived from the same closed vocabulary as the validator. */
export function createStepManifestationSchema(actionType: 'speak' | 'move' | 'take' | 'interact') {
  const entries = Object.entries(ACTION_GROUP_CUES)
  const independent = entries.filter(([, cue]) => cue.actionType === null).map(([code]) => code)
  const onSuccess = entries.filter(([, cue]) => cue.actionType === null || cue.actionType === actionType).map(([code]) => code)
  return {
    type: 'object', additionalProperties: false, required: ['independent', 'onSuccess'],
    properties: {
      independent: { type: 'array', maxItems: 8, uniqueItems: true, items: { type: 'string', enum: independent } },
      onSuccess: { type: 'array', maxItems: 8, uniqueItems: true, items: { type: 'string', enum: onSuccess } },
    },
  }
}

export interface StepManifestation extends WorldJsonObject {
  readonly independent: readonly ActionGroupCue[]
  readonly onSuccess: readonly ActionGroupCue[]
}

export interface ActionGroupBindingV1 extends WorldJsonObject {
  readonly version: 'bounded-action-group/v1'
  /** Aligned with original proposalOrdinal; null means no performance for this step. */
  readonly manifestations: readonly (StepManifestation | null)[]
}

/**
 * V2 exists because the frozen interaction path addresses a definition lock and a binding identity
 * the closed catalog could not name, so its step arguments are a different shape. The manifestation
 * vocabulary is unchanged; a v2 group is accepted only where the Manifest declares the v2 policy, so
 * a v1 world never sees the new action version and a v2 world never silently accepts the old one.
 */
export interface ActionGroupBindingV2 extends WorldJsonObject {
  readonly version: 'bounded-action-group/v2'
  readonly manifestations: readonly (StepManifestation | null)[]
}

export type ActionGroupBinding = ActionGroupBindingV1 | ActionGroupBindingV2

export interface ActionGroupProposal extends WorldJsonObject {
  readonly participantId: string
  readonly actions: readonly ActionRequest[]
  readonly actionGroup?: ActionGroupBinding
}

export interface SubmitActionsV4 extends WorldJsonObject {
  readonly schemaVersion: 4
  readonly decision: 'act' | 'abstain'
  readonly actions: readonly WorldJsonObject[]
  readonly reflection?: import('./cognition-projection.ts').ReflectionBatch
}

export interface SubmitActionsV5 extends WorldJsonObject {
  readonly schemaVersion: 5
  readonly decision: 'act' | 'abstain'
  readonly actions: readonly WorldJsonObject[]
  readonly reflection?: import('./cognition-projection.ts').ReflectionBatch
}

/**
 * V6 carries the frozen interaction protocol: the same group shape, whose interaction step names a
 * binding and a definition lock and is therefore versioned above one.
 */
export interface SubmitActionsV6 extends WorldJsonObject {
  readonly schemaVersion: 6
  readonly decision: 'act' | 'abstain'
  readonly actions: readonly WorldJsonObject[]
  readonly reflection?: import('./cognition-projection.ts').ReflectionBatch
}
