import { compareWorldText, type ManifestationProposal, type WorldEventDraft, type WorldJsonObject, type WorldJsonValue } from '@harness-world/contracts'
import type { ManifestationResolution } from './manifestation.ts'
import { manifestUsesFrozenInteractions, type CompiledWorldManifest } from './world-spec.ts'

export interface PlayerActionInput extends WorldJsonObject {
  readonly actionType: string
  readonly parameters: WorldJsonValue
}

/** Revalidate a durable Inbox payload before it reaches any deterministic Rulebook. */
export function parsePlayerActionInput(value: WorldJsonValue): PlayerActionInput {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('claimed player action must be an object')
  const action = value as Record<string, WorldJsonValue>
  const keys = Object.keys(action).sort(compareWorldText)
  if (keys.join(',') !== 'actionType,parameters' || typeof action.actionType !== 'string') {
    throw new TypeError('claimed player action has an invalid shape')
  }
  return { actionType: action.actionType, parameters: action.parameters! }
}

export interface RulebookResolution {
  readonly status: 'accepted' | 'rejected'
  readonly events: readonly WorldEventDraft[]
  readonly reason?: string
  /** A performance adjudicated inside a frozen definition, returned so the Host records its Authority. */
  readonly manifestation?: {
    readonly proposal: ManifestationProposal
    readonly resolution: ManifestationResolution
  }
  /**
   * The frozen path's rule trace: the definition set, the resolved role bindings and the trace hash
   * that binds them to the World, the Manifest, the candidate prefix and the authority. It is absent on
   * every path that has no frozen rule plan, which is every Manifest before v10, and it is what a Host
   * binds into durable Round Authority.
   */
  readonly interactionTrace?: WorldJsonObject
  /**
   * The definition that adjudicated this action, when one did. Speech and movement are not resolved by
   * a registered definition, so a reaction evidence entry falls back to the action's own identity.
   */
  readonly definitionRef?: { readonly id: string; readonly version: number }
  /**
   * The characters the frozen plan's declared affected slots resolved to, empty when the action did not
   * happen. A reaction role class reads `direct` from this rather than from scanning an event.
   */
  readonly affectedCharacterIds?: readonly string[]
  /**
   * The frozen plan's resolved role bindings by role name, when the action has a frozen plan. A Host
   * needs the names - not only their hash - to state which character an effect landed on, which is what
   * a reaction role class is read from.
   */
  readonly resolvedRoles?: { readonly [name: string]: { readonly kind: string; readonly id: string } }
  /** Maximum audience granted by the Rulebook; Scene policy may only narrow it. */
  readonly observationScope?: {
    readonly scope: 'scene_public' | 'direct' | 'private' | 'self'
    readonly recipientIds?: readonly string[]
  }
}

export function worldJsonObject(value: WorldJsonValue): Record<string, WorldJsonValue> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, WorldJsonValue>
    : undefined
}

export interface RulebookEvent {
  readonly eventType: string
  readonly eventVersion?: number
  readonly data: WorldJsonValue
}

export function currentLocation(events: readonly RulebookEvent[], characterId: string): string | undefined {
  let locationId: string | undefined
  for (const event of events) {
    const data = worldJsonObject(event.data)
    if (data?.characterId !== characterId) continue
    if ((event.eventType === 'character.upsert' || event.eventType === 'character.created') && typeof data.locationId === 'string') locationId = data.locationId
    if (event.eventType === 'character.moved' && typeof data.toLocationId === 'string') locationId = data.toLocationId
  }
  return locationId
}

export interface EntityState extends WorldJsonObject {
  readonly entityId: string
  readonly locationId: string | null
  /** Current custody/carrying assignment, not hand contact or legal ownership. */
  readonly holderId: string | null
  readonly kind: string
}

/** Rebuild one entity's authoritative location/holder state from the exact Event prefix. */
export function currentEntityState(events: readonly RulebookEvent[], entityId: string): EntityState | undefined {
  let state: EntityState | undefined
  for (const event of events) {
    const data = worldJsonObject(event.data)
    if (data?.entityId !== entityId) continue
    if (event.eventType === 'entity.upsert') {
      if (typeof data.locationId !== 'string' || typeof data.kind !== 'string') {
        throw new TypeError(`entity.upsert for ${entityId} is malformed`)
      }
      state = { entityId, locationId: data.locationId, holderId: null, kind: data.kind }
    }
    if (event.eventType === 'entity.transferred') {
      if (state === undefined || state.locationId !== data.fromLocationId || state.holderId !== data.fromHolderId
        || typeof data.characterId !== 'string' || typeof data.interactionId !== 'string'
        || !((typeof data.toLocationId === 'string' && data.toHolderId === null)
          || (data.toLocationId === null && typeof data.toHolderId === 'string'))) {
        throw new TypeError(`entity.transferred for ${entityId} violates the entity event prefix`)
      }
      state = { ...state, locationId: data.toLocationId as string | null, holderId: data.toHolderId as string | null }
    }
    if (event.eventType === 'entity.taken') {
      if (state === undefined || typeof data.characterId !== 'string' || typeof data.fromLocationId !== 'string'
        || state.holderId !== null || state.locationId !== data.fromLocationId) {
        throw new TypeError(`entity.taken for ${entityId} violates the entity event prefix`)
      }
      state = { ...state, locationId: null, holderId: data.characterId }
    }
  }
  return state
}

export function currentCharacterLifecycle(events: readonly RulebookEvent[], characterId: string): 'active' | 'incapacitated' | 'dead' | 'departed' | undefined {
  let state: 'active' | 'incapacitated' | 'dead' | 'departed' | undefined
  for (const event of events) {
    const data = worldJsonObject(event.data)
    if (data?.characterId !== characterId) continue
    if (event.eventType === 'character.upsert' || event.eventType === 'character.created') state ??= 'active'
    if (event.eventType === 'character.lifecycle-changed'
      && (data.lifecycleState === 'active' || data.lifecycleState === 'incapacitated'
        || data.lifecycleState === 'dead' || data.lifecycleState === 'departed')) state = data.lifecycleState
  }
  return state
}

export function rejectRulebookResolution(characterId: string, actionType: string, reason: string): RulebookResolution {
  return {
    status: 'rejected',
    reason,
    events: [{ eventType: 'action.rejected', eventVersion: 1, data: { characterId, actionType, reason } }],
  }
}

function phase8Speech(
  manifest: CompiledWorldManifest,
  characterId: string,
  parameters: Record<string, WorldJsonValue> | undefined,
): RulebookResolution {
  const text = parameters?.text
  const narration = parameters?.narration
  const scope = parameters?.scope ?? 'scene_public'
  const addresseeIds = parameters?.addresseeIds ?? []
  const recipients = Array.isArray(addresseeIds) ? addresseeIds : []
  const replyTo = parameters?.replyTo ?? null
  const declaredSpeechAct = parameters?.declaredSpeechAct ?? null
  // Publishing expression proves only that this character communicated it. Narrative
  // content is never interpreted as a state patch or a successful interaction.
  // Only the named publication fields below are emitted; extra model annotations
  // have no effect and need not discard an otherwise valid expression.
  const validNarration = narration === undefined || typeof narration === 'string'
  const validText = typeof text === 'string'
    && (text.trim().length > 0 || (typeof narration === 'string' && narration.trim().length > 0))
  const validScope = scope === 'scene_public' || scope === 'direct' || scope === 'private' || scope === 'self'
  const validAddressees = Array.isArray(addresseeIds)
    && addresseeIds.every(value => typeof value === 'string'
      && value !== characterId
      && manifest.characters.some(character => character.characterId === value))
    && new Set(addresseeIds).size === addresseeIds.length
  const validAddressing = (scope === 'direct' || scope === 'private')
    ? recipients.length > 0
    : recipients.length === 0
  const validOptionalText = (value: WorldJsonValue): boolean => value === null
    || (typeof value === 'string' && value.length > 0 && value.trim() === value)
  if (!validText || !validNarration || !validScope || !validAddressees || !validAddressing
    || !validOptionalText(replyTo) || !validOptionalText(declaredSpeechAct)) {
    return rejectRulebookResolution(characterId, 'speak', 'speak parameters are invalid for Manifest v4')
  }
  return {
    status: 'accepted',
    events: [{
      eventType: 'character.speak', eventVersion: 1,
      data: { characterId, text, ...(narration === undefined ? {} : { narration }),
        addresseeIds: recipients, scope, replyTo, declaredSpeechAct },
    }],
    observationScope: {
      scope,
      ...(scope === 'direct' || scope === 'private' ? { recipientIds: recipients as readonly string[] } : {}),
    },
  }
}

/** Shared deterministic speech and movement rules for Manifest v10. */
export class SpeakMoveRulebook {
  resolveSupported(
    manifest: CompiledWorldManifest,
    events: readonly RulebookEvent[],
    characterId: string,
    action: PlayerActionInput,
  ): RulebookResolution | undefined {
    if (!manifestUsesFrozenInteractions(manifest)) {
      return rejectRulebookResolution(characterId, action.actionType, 'the shared Rulebook only serves Manifest v10')
    }
    const lifecycle = currentCharacterLifecycle(events, characterId)
    if (lifecycle !== 'active') return rejectRulebookResolution(characterId, action.actionType, `character lifecycle ${lifecycle ?? 'missing'} cannot act`)
    if (action.actionType === 'interact' || action.actionType === 'take') {
      return rejectRulebookResolution(characterId, action.actionType, 'Manifest v10 resolves interact and take through the frozen interaction path')
    }
    const parameters = worldJsonObject(action.parameters)
    if (action.actionType === 'speak') {
      return phase8Speech(manifest, characterId, parameters)
    }
    if (action.actionType === 'move') {
      const target = parameters?.locationId
      if (typeof target !== 'string' || !manifest.locations.some(location => location.locationId === target)) {
        return rejectRulebookResolution(characterId, action.actionType, 'move target is not a manifest location')
      }
      const from = currentLocation(events, characterId)
      if (from === target) return rejectRulebookResolution(characterId, action.actionType, 'character is already at the target location')
      const moveEvent: WorldEventDraft = {
        eventType: 'character.moved',
        eventVersion: 1,
        data: { characterId, fromLocationId: from ?? null, toLocationId: target },
      }
      return {
        status: 'accepted',
        events: [moveEvent],
      }
    }
    return undefined
  }

  resolve(
    manifest: CompiledWorldManifest,
    events: readonly RulebookEvent[],
    characterId: string,
    action: PlayerActionInput,
  ): RulebookResolution {
    return this.resolveSupported(manifest, events, characterId, action)
      ?? rejectRulebookResolution(characterId, action.actionType, 'action type is not afforded by the V0 Rulebook')
  }
}
