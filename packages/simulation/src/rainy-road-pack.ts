import { fileURLToPath } from 'node:url'
import type { RoundParticipant } from '@harness-world/application'
import {
  brandId,
  type ContextSourceRef,
  type ProposalContext,
  type SubmitActionsV2,
  type WorldAddress,
  type WorldJsonObject,
} from '@harness-world/contracts'
import type { CompiledWorldSpec } from '@harness-world/kernel'
import {
  WorldPackCompilerV2,
  type CompiledWorldPackV2,
} from '@harness-world/world-pack'

export const RAINY_ROAD_IDS = Object.freeze({
  player: brandId('character:player', 'CharacterId'),
  alice: brandId('character:alice', 'CharacterId'),
  bob: brandId('character:bob', 'CharacterId'),
  principal: 'principal:rainy-road-player',
  session: brandId('session:rainy-road-player', 'SessionId'),
  shelter: 'location:road-shelter',
  station: 'location:station-platform',
  tickets: 'entity:ticket-bundle',
})

/** Repository-owned Phase 8 acceptance content. It contains no executable scenario code. */
export function rainyRoadSourceDirectory(): string {
  return fileURLToPath(new URL('../../../examples/world-packs/rainy-road-companions/', import.meta.url))
}

/** Compile the reference content through the public creator-facing v2 compiler. */
export function compileRainyRoadPack(sourceDirectory = rainyRoadSourceDirectory()): Promise<CompiledWorldPackV2> {
  return new WorldPackCompilerV2().compile(sourceDirectory)
}

/** Bind the immutable artifact to a runtime address without adding fixture-only Events. */
export function adaptRainyRoadPack(pack: CompiledWorldPackV2, address: WorldAddress): CompiledWorldSpec {
  return new WorldPackCompilerV2().adaptToWorldSpec(pack, {
    address,
    principalId: RAINY_ROAD_IDS.principal,
    sessionId: RAINY_ROAD_IDS.session,
  })
}

export interface RainyRoadFixtureEvidence {
  readonly calls: Map<string, number>
  readonly contexts: Map<string, ProposalContext[]>
}

interface RenderedSegment {
  readonly segmentKind: string
  readonly content: WorldJsonObject
  readonly sourceRefs: readonly ContextSourceRef[]
}

function renderedSegments(context: ProposalContext): RenderedSegment[] {
  const request = (context as unknown as { exactProviderRequest: { messages: readonly { content: string }[] } }).exactProviderRequest
  return request.messages.slice(2).map(message => JSON.parse(message.content) as RenderedSegment)
}

function action(
  context: ProposalContext,
  participantId: string,
  actorId: typeof RAINY_ROAD_IDS.alice | typeof RAINY_ROAD_IDS.bob,
  ordinal: number,
  actionType: string,
  parameters: WorldJsonObject,
) {
  return {
    actionId: `action:${participantId}:${context.tick}:${ordinal}`,
    actorId,
    actionType,
    actionVersion: 1 as const,
    parameters,
  }
}

function aliceResponse(context: ProposalContext): SubmitActionsV2 {
  if (context.tick === 1 || context.tick === 4 || context.tick === 5) {
    const text = context.tick === 1
      ? '我们在雨里等了很久。Bob，你为什么迟到？'
      : context.tick === 4
        ? '先把情况说清楚，我们仍要一起赶车。'
        : '如果他确实停下来救了人，我愿意重新考虑。'
    return {
      schemaVersion: 2, decision: 'act',
      actions: [action(context, 'agent:alice', RAINY_ROAD_IDS.alice, 0, 'speak', { text })],
    }
  }
  if (context.tick !== 6) return { schemaVersion: 2, decision: 'abstain', actions: [] }
  const segments = renderedSegments(context)
  const self = segments.find(segment => segment.segmentKind === 'current_self_state')!.content
  const trust = (self.consciousState as readonly WorldJsonObject[]).find(record => {
    const value = record.value as WorldJsonObject
    return record.kind === 'relationship-attitude' && value.type === 'trust' && value.facet === 'competence'
  })!
  const tail = segments.find(segment => segment.segmentKind === 'recent_interaction_tail')!
  const previous = trust.value as WorldJsonObject
  return {
    schemaVersion: 2,
    decision: 'act',
    actions: [
      action(context, 'agent:alice', RAINY_ROAD_IDS.alice, 0, 'take', { entityId: RAINY_ROAD_IDS.tickets }),
      action(context, 'agent:alice', RAINY_ROAD_IDS.alice, 1, 'move', { locationId: RAINY_ROAD_IDS.station }),
    ],
    reflection: {
      operations: [{
        operationId: `operation:alice:trust:${context.tick}`,
        kind: 'relationship-attitude',
        recordId: trust.id as string,
        expectedStateHash: trust.stateHash as `sha256:${string}`,
        basisRefs: [tail.sourceRefs.at(-1)!],
        value: { ...previous, intensityPermille: (previous.intensityPermille as number) + 100 },
      }],
    },
  }
}

function bobResponse(context: ProposalContext): SubmitActionsV2 {
  if (context.tick === 1) {
    return {
      schemaVersion: 2, decision: 'act',
      actions: [action(context, 'agent:bob', RAINY_ROAD_IDS.bob, 0, 'speak', { text: '抱歉让你们久等了。' })],
    }
  }
  if (context.tick === 2) {
    return {
      schemaVersion: 2, decision: 'act',
      actions: [action(context, 'agent:bob', RAINY_ROAD_IDS.bob, 0, 'speak', {
        text: '我在路边停下来帮助了一名受伤的陌生人，但请不要追问他的身份。',
        addresseeIds: [RAINY_ROAD_IDS.player], scope: 'private',
        replyTo: null, declaredSpeechAct: 'answer',
      })],
    }
  }
  if (context.tick === 3) {
    return {
      schemaVersion: 2, decision: 'act',
      actions: [action(context, 'agent:bob', RAINY_ROAD_IDS.bob, 0, 'move', { locationId: RAINY_ROAD_IDS.station })],
    }
  }
  return { schemaVersion: 2, decision: 'abstain', actions: [] }
}

/** Deterministic no-network Provider fixture; its responses are not part of Pack content or Manifest Hash. */
export function createRainyRoadParticipants(evidence?: RainyRoadFixtureEvidence): readonly RoundParticipant[] {
  const participant = (
    participantId: string,
    actorId: typeof RAINY_ROAD_IDS.alice | typeof RAINY_ROAD_IDS.bob,
    priority: number,
    respond: (context: ProposalContext) => SubmitActionsV2,
  ): RoundParticipant => ({
    participantId, role: 'agent', actorId,
    allowedActionTypes: ['move', 'speak', 'take'], priority, estimatedTokens: 1, timeoutMs: 100,
    provider: {
      async propose(context) {
        evidence?.calls.set(participantId, (evidence.calls.get(participantId) ?? 0) + 1)
        evidence?.contexts.set(participantId, [...evidence.contexts.get(participantId) ?? [], context])
        return respond(context)
      },
    },
  })
  return [
    participant('agent:alice', RAINY_ROAD_IDS.alice, 2, aliceResponse),
    participant('agent:bob', RAINY_ROAD_IDS.bob, 1, bobResponse),
  ]
}
