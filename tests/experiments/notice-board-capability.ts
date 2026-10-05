/** Trusted experimental reading capability. No model-visible database or truth query. */
import { hashWorldJson, type InteractionDefinitionSpec, type InteractionExecutionContext,
  type InteractionImplementationLock, type InteractionPackageImplementation, type InteractionRef,
  type WorldEventDraft, type WorldJsonObject } from '@harness-world/contracts'
import { interactionPackageHash } from '@harness-world/interaction-runtime'
import { characterExecutionResult } from '../../packages/application/src/character-execution-result.ts'

export const inspectId = 'experiment:inspect-notice-board'
export const boardText = '登记处：二楼203'
export const privateText = '仅陆舟可读的内部名单：青杉'
const ref = (id: string): InteractionRef => ({ id, version: 1 })
const lock = (id: string): InteractionImplementationLock => ({ ref: ref(id), dependencies: [],
  implementationHash: hashWorldJson('notice-board-experiment', { id, revision: 1 }) })
const object = (v: unknown): WorldJsonObject =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? v as WorldJsonObject : {}
function state(c: InteractionExecutionContext, role: string) {
  const target = c.roles[role]!
  return c.host.targets.find(t => t.ref.id === target.id && t.ref.kind === target.kind)!.state
}
function reading(c: InteractionExecutionContext): WorldEventDraft[] {
  return [{ eventType: 'observation.upsert', eventVersion: 1, data: {
    id: c.host.actionId + ':inspection',
    value: { observerId: c.host.actorId, actionId: c.host.actionId, epistemicKind: 'direct_observation',
      content: { actorId: c.host.actorId, targetId: c.roles.board!.id, capabilityId: inspectId,
        sourceActionId: c.host.actionId, observedText: c.binding.config.text!,
        description: '你亲眼看到公告牌上写着：' + String(c.binding.config.text) } },
  } }]
}
export function createNoticeBoardPackage(): InteractionPackageImplementation {
  const spec: InteractionDefinitionSpec = {
    versionTag: 'interaction-definition/v1', id: inspectId, version: 1,
    participantRoles: [
      { name: 'actor', kind: 'character', source: { kind: 'hostActor' }, distinctFrom: [] },
      { name: 'board', kind: 'entity', source: { kind: 'primaryTarget' }, distinctFrom: [] },
    ], argumentSchema: { fields: [] }, bindingConfigSchema: { fields: [
      { name: 'text', type: 'string', maxBytes: 1024, values: [] },
      { name: 'publicRead', type: 'boolean' },
      { name: 'readerId', type: 'string', maxBytes: 1024, values: [] },
    ] },
    authorityPolicyRef: ref('inspect:actor-active'), preconditions: [ref('inspect:reader')],
    spatialRequirementRefs: [ref('inspect:co-location')],
    effectBuilderRef: ref('inspect:read-effect'), effectCapabilityRefs: [ref('inspect:read-effect')],
    dependencyRefs: [], lifecycleRefs: [], limits: { maximumEvents: 1 },
    observationPolicyRef: ref('inspect:self'), performancePolicyRef: ref('inspect:no-performance'),
    reactionEvidencePolicyRef: ref('inspect:no-direct'),
  }
  const contents: Omit<InteractionPackageImplementation, 'lock'> = {
    rules: [
      { lock: lock('inspect:actor-active'), check: c =>
        state(c, 'actor').lifecycle === 'active' && c.host.authority.sourceRole !== 'director' ? null : 'ACTOR_CANNOT_ACT' },
      { lock: lock('inspect:reader'), check: c =>
        c.binding.config.publicRead === true || c.binding.config.readerId === c.host.actorId ? null : 'READ_NOT_ALLOWED' },
      { lock: lock('inspect:co-location'), check: c =>
        state(c, 'board').kind === 'notice-board'
          && typeof state(c, 'actor').locationId === 'string'
          && state(c, 'board').locationId === state(c, 'actor').locationId
          && state(c, 'board').holderId === null ? null : 'BOARD_NOT_REACHABLE' },
    ],
    effects: [{ lock: lock('inspect:read-effect'), eventTypes: [ref('observation.upsert')],
      build: reading, validate: (c, events) => {
        if (hashWorldJson('inspect-effect', events) !== hashWorldJson('inspect-effect', reading(c))) {
          throw new TypeError('reading must equal bound text and host actor/action')
        }
      } }],
    resolvers: [], lifecycle: [],
    performances: [{ lock: lock('inspect:no-performance'),
      policy: { version: 'interaction-performance/v1', accepted: [] } }],
    reactionEvidence: [{ lock: lock('inspect:no-direct'),
      policy: { version: 'interaction-reaction-evidence/v1', directRoles: [] } }],
    observation: [{ lock: lock('inspect:self'),
      policy: { version: 'interaction-observation-policy/v1', onAccepted: 'self', onRejected: 'self' } }],
    definitions: [{ spec, implementationHash: lock(inspectId).implementationHash }],
  }
  return { ...contents, lock: { ...lock('package:notice-board-experiment'),
    implementationHash: interactionPackageHash(contents) } }
}

/** Only decorate already authorized native choices; never add an option or its hidden config. */
export function noticeBoardContext(context: WorldJsonObject): WorldJsonObject {
  const affordances = (context.affordances as WorldJsonObject[]).map(a => a.actionType !== 'interact' ? a : {
    ...a, interactions: (a.interactions as WorldJsonObject[]).map(choice =>
      object(choice.definitionRef).id !== inspectId ? choice : { ...choice,
        label: object(choice.targetRef).id === 'entity:hall-board' ? '查看大厅公告牌' : '查看公告牌' }),
  })
  return { ...context, affordances }
}

/** Render actual read evidence, never look up content to manufacture an accepted result. */
export function noticeBoardResult(input: Parameters<typeof characterExecutionResult>[0]): WorldJsonObject {
  const params = object(input.action.parameters)
  if (input.action.actionType !== 'interact' || object(params.definitionRef).id !== inspectId) return characterExecutionResult(input)
  if (input.status !== 'accepted') return { status: input.status, description: '本次未能查看公告牌；没有获得牌面内容。' }
  const target = object(params.targetRef).id
  const event = input.events.findLast(e => {
    const value = object(object(e.data).value), content = object(value.content)
    return e.eventType === 'observation.upsert' && value.observerId === input.actorId
      && value.epistemicKind === 'direct_observation' && content.capabilityId === inspectId
      && content.targetId === target && content.sourceActionId === value.actionId
  })
  if (!event) throw new Error('accepted inspection has no matching read evidence')
  const value = object(object(event.data).value), content = object(value.content)
  const lastResolution = input.events.findLast(e => e.eventType === 'action.resolved' && object(e.data).actorId === input.actorId)
  // Before commit the fresh effect precedes action.resolved; after commit bind feedback to that action.
  if (lastResolution && input.events.indexOf(lastResolution) > input.events.indexOf(event)
    && object(lastResolution.data).actionId !== value.actionId) throw new Error('stale reading feedback')
  return { status: input.status, description: String(content.description),
    evidence: { observationId: object(event.data).id!, actionId: value.actionId!,
      targetId: target!, epistemicKind: 'direct_observation' } }
}
