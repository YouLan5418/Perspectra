import type { DecisionTarget, InstanceModels, ModelTarget, ThinkingLevel } from './core-types.ts'

/** Some Gemini models cannot turn thinking fully off. */
export const geminiRequired = (model: string) => /gemini-(?:[3-9]|2\.5-pro)/i.test(model)

/** Editable form of one layer: a decision model plus a memory model that may follow it. */
export interface LayerDraft {
  decision?: ModelTarget
  thinkingLevel: ThinkingLevel
  memoryFollows: boolean
  memory?: ModelTarget
}
export interface RoleDraft extends LayerDraft {
  override: boolean
}
export interface ModelsDraft extends LayerDraft {
  characters: Record<string, RoleDraft>
}

function layer(decision: DecisionTarget | undefined, memory: ModelTarget | undefined): LayerDraft {
  return {
    ...(decision ? { decision: { connectionId: decision.connectionId, model: decision.model } } : {}),
    thinkingLevel: decision?.thinkingLevel ?? (geminiRequired(decision?.model ?? '') ? 'low' : 'off'),
    memoryFollows: memory === undefined,
    ...(memory ? { memory: { ...memory } } : {}),
  }
}

/** Every callable character gets a row; overrides for characters no longer in the pack are dropped. */
export function modelsDraft(models: InstanceModels | undefined, characterIds: readonly string[]): ModelsDraft {
  return {
    ...layer(models?.decision, models?.memory),
    characters: Object.fromEntries(
      characterIds.map(id => {
        const own = models?.characters?.[id]
        return [
          id,
          own?.decision
            ? { override: true, ...layer(own.decision, own.memory) }
            : { override: false, thinkingLevel: 'off', memoryFollows: true },
        ]
      }),
    ),
  }
}

function target(value: ModelTarget | undefined): ModelTarget | undefined {
  const model = value?.model.trim()
  return value && model ? { connectionId: value.connectionId, model } : undefined
}

/** `undefined` while any chosen layer still lacks a model. */
export function draftModels(draft: ModelsDraft): InstanceModels | undefined {
  const save = (value: LayerDraft): { decision: DecisionTarget; memory?: ModelTarget } | undefined => {
    const decision = target(value.decision),
      memory = value.memoryFollows ? undefined : target(value.memory)
    if (!decision || (!value.memoryFollows && !memory)) return undefined
    return { decision: { ...decision, thinkingLevel: value.thinkingLevel }, ...(memory ? { memory } : {}) }
  }
  const base = save(draft)
  if (!base) return undefined
  const characters: NonNullable<InstanceModels['characters']> = {}
  for (const [id, role] of Object.entries(draft.characters)) {
    if (!role.override) continue
    const own = save(role)
    if (!own) return undefined
    characters[id] = own
  }
  return { ...base, ...(Object.keys(characters).length ? { characters } : {}) }
}
