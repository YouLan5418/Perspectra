import {
  compareWorldText,
  hashWorldJson,
  type ActionRequest,
  type CharacterView,
  type InteractionRoundId,
  type WorldAddress,
  type WorldHash,
  type WorldJsonObject,
} from '@harness-world/contracts'

export interface AgentCapability extends WorldJsonObject {
  readonly actorId: string
  readonly allowedActionTypes: readonly string[]
}

export interface AgentContextEnvelope extends WorldJsonObject {
  readonly contractVersion: 1
  readonly address: WorldAddress
  readonly roundId: InteractionRoundId
  readonly participantId: string
  readonly characterView: CharacterView
  readonly playerAction: ActionRequest
  readonly capability: AgentCapability
  readonly contextHash: WorldHash
}

export interface AgentContextInput {
  readonly address: WorldAddress
  readonly roundId: InteractionRoundId
  readonly participantId: string
  readonly characterView: CharacterView
  readonly playerAction: ActionRequest
  readonly capability: AgentCapability
}

/** Builds one immutable, least-privilege input envelope for a character Agent. */
export class ContextAssembler {
  assemble(input: AgentContextInput): AgentContextEnvelope {
    if (input.characterView.address.tenantId !== input.address.tenantId
      || input.characterView.address.worldId !== input.address.worldId
      || input.characterView.address.branchId !== input.address.branchId) {
      throw new TypeError('CharacterView address does not match Agent context address')
    }
    if (input.characterView.characterId !== input.capability.actorId) {
      throw new TypeError('CharacterView character does not match Agent capability actor')
    }
    if (input.participantId.length === 0 || input.participantId.trim() !== input.participantId) {
      throw new TypeError('participantId must be a non-empty, unpadded string')
    }
    const allowedActionTypes = [...input.capability.allowedActionTypes].sort(compareWorldText)
    if (allowedActionTypes.length === 0 || new Set(allowedActionTypes).size !== allowedActionTypes.length) {
      throw new TypeError('Agent capability action types must be non-empty and unique')
    }
    const base = {
      contractVersion: 1 as const,
      address: input.address,
      roundId: input.roundId,
      participantId: input.participantId,
      characterView: input.characterView,
      playerAction: input.playerAction,
      capability: { actorId: input.capability.actorId, allowedActionTypes },
    }
    return { ...base, contextHash: hashWorldJson('agent-context-envelope', base) }
  }
}
