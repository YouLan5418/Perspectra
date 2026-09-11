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

export interface ActionGroupBinding extends WorldJsonObject {
  readonly version: 'bounded-action-group/v1'
  /** Aligned with original proposalOrdinal; null means no performance for this step. */
  readonly manifestations: readonly (StepManifestation | null)[]
}

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
