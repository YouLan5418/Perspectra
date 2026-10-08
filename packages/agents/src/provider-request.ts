import { publicationSegments } from '@harness-world/contracts'
import {
  PHASE8_CONTEXT_PROFILES,
  assertProtocolString,
  canonicalizeWorldJson,
  failWorld,
  hashCharacterContext,
  hashDirectorContext,
  hashProviderRequest,
  hashWorldJson,
  type CharacterContextBundle,
  type CharacterContextSegmentKind,
  type ContextProfileId,
  type ContextSegment,
  type InteractionTail,
  type DirectorPlanningContext,
  type ProviderRequestHashInput,
  type WorldHash,
  type WorldJsonObject,
  type WorldJsonValue,
} from '@harness-world/contracts'

export type ProviderMessageRole = 'system' | 'developer' | 'user'

export interface ProviderMessage extends WorldJsonObject {
  readonly role: ProviderMessageRole
  readonly content: string
}

export interface PromptRendererLock extends WorldJsonObject {
  readonly rendererId: string
  readonly rendererVersion: string
  readonly rendererHash: WorldHash
}

export interface ProviderToolSchema extends WorldJsonObject {
  readonly toolSchemaId: string
  readonly schema: WorldJsonValue
  readonly toolSchemaHash: WorldHash
}

export interface ProviderModelProfile {
  readonly providerId: string
  readonly modelId: string
  readonly maximumInputBytes: number
  readonly contextWindowBytes: number
  readonly outputReserveBytes: number
  readonly safetyReserveBytes: number
  readonly minimumToolOutputBytes: number
  readonly sampling: WorldJsonObject
  readonly providerUserPartitionValue: string
  /** Transport-only fields are deliberately absent from both hashes and exact Provider bytes. */
  readonly credentialRef?: string
  readonly timeoutMs?: number
  readonly traceId?: string
  readonly cacheHit?: boolean
  readonly retryAttempt?: number
}

export interface ExactProviderRequest extends WorldJsonObject {
  readonly schemaVersion: 'structured-provider-request/v1'
  readonly model: string
  readonly messages: readonly ProviderMessage[]
  readonly tools: WorldJsonValue
  readonly sampling: WorldJsonObject
  readonly user: string
}

export interface RenderedProviderRequest {
  readonly contextHash: WorldHash
  readonly exactRequest: ExactProviderRequest
  readonly exactRequestBytes: Uint8Array
  readonly providerRequestHash: WorldHash
}

export interface RenderCharacterRequest {
  readonly context: CharacterContextBundle
  readonly contextProfileId: ContextProfileId
  readonly renderer: PromptRendererLock
  readonly toolSchema: ProviderToolSchema
  readonly modelProfile: ProviderModelProfile
  readonly correlationId: string
}

export interface RenderDirectorRequest {
  readonly context: DirectorPlanningContext
  readonly contextProfileId: ContextProfileId
  readonly renderer: PromptRendererLock
  readonly toolSchema: ProviderToolSchema
  readonly modelProfile: ProviderModelProfile
  readonly correlationId: string
}

export function createPromptRendererLock(
  rendererId = 'structured-prompt-renderer',
  rendererVersion = '1.0.0',
): PromptRendererLock {
  assertProtocolString(rendererId, 'rendererId')
  assertProtocolString(rendererVersion, 'rendererVersion')
  const base = { rendererId, rendererVersion }
  return { ...base, rendererHash: hashWorldJson('prompt-renderer-contract/v1', base) }
}

export function createProviderToolSchema(toolSchemaId: string, schema: WorldJsonValue): ProviderToolSchema {
  assertProtocolString(toolSchemaId, 'toolSchemaId')
  return { toolSchemaId, schema, toolSchemaHash: hashWorldJson('provider-tool-schema/v1', { toolSchemaId, schema }) }
}

function jsonString(value: WorldJsonValue): string {
  return Buffer.from(canonicalizeWorldJson(value)).toString('utf8')
}

function profile(profileId: ContextProfileId) {
  const selected = PHASE8_CONTEXT_PROFILES.find(value => value.profileId === profileId)
  if (selected === undefined) throw new TypeError(`unknown Context Profile ${profileId}`)
  return selected
}

function assertNonNegativeSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative safe integer`)
}

function assertLocks(renderer: PromptRendererLock, toolSchema: ProviderToolSchema): void {
  assertProtocolString(renderer.rendererId, 'rendererId')
  assertProtocolString(renderer.rendererVersion, 'rendererVersion')
  assertProtocolString(toolSchema.toolSchemaId, 'toolSchemaId')
  const rendererHash = hashWorldJson('prompt-renderer-contract/v1', {
    rendererId: renderer.rendererId, rendererVersion: renderer.rendererVersion,
  })
  const toolSchemaHash = hashWorldJson('provider-tool-schema/v1', {
    toolSchemaId: toolSchema.toolSchemaId, schema: toolSchema.schema,
  })
  if (renderer.rendererHash !== rendererHash || toolSchema.toolSchemaHash !== toolSchemaHash) {
    throw new TypeError('Renderer or Tool Schema Hash diverged')
  }
}

function assertModelProfile(
  model: ProviderModelProfile,
  contextProfileId: ContextProfileId,
  correlationId: string,
): void {
  assertProtocolString(model.providerId, 'providerId')
  assertProtocolString(model.modelId, 'modelId')
  assertProtocolString(model.providerUserPartitionValue, 'providerUserPartitionValue')
  for (const [name, value] of [
    ['maximumInputBytes', model.maximumInputBytes], ['contextWindowBytes', model.contextWindowBytes],
    ['outputReserveBytes', model.outputReserveBytes], ['safetyReserveBytes', model.safetyReserveBytes],
    ['minimumToolOutputBytes', model.minimumToolOutputBytes],
  ] as const) assertNonNegativeSafeInteger(value, name)
  if (model.outputReserveBytes < model.minimumToolOutputBytes) {
    failWorld({
      errorCode: 'OUTPUT_RESERVE_INSUFFICIENT', category: 'provider',
      message: 'Model Profile output reserve cannot contain the minimum valid Tool result', retryable: false,
      correlationId,
    })
  }
  if (model.maximumInputBytes < profile(contextProfileId).maximumRequestBytes
    || model.maximumInputBytes + model.outputReserveBytes + model.safetyReserveBytes > model.contextWindowBytes) {
    failWorld({
      errorCode: 'MODEL_PROFILE_INCOMPATIBLE', category: 'provider',
      message: `Model Profile cannot carry Context Profile ${contextProfileId}`, retryable: false,
      correlationId,
    })
  }
}

function render(
  contextHash: WorldHash,
  messages: readonly ProviderMessage[],
  contextProfileId: ContextProfileId,
  renderer: PromptRendererLock,
  toolSchema: ProviderToolSchema,
  model: ProviderModelProfile,
  correlationId: string,
): RenderedProviderRequest {
  assertLocks(renderer, toolSchema)
  assertModelProfile(model, contextProfileId, correlationId)
  const exactRequest: ExactProviderRequest = {
    schemaVersion: 'structured-provider-request/v1', model: model.modelId, messages,
    tools: toolSchema.schema, sampling: model.sampling, user: model.providerUserPartitionValue,
  }
  const exactRequestBytes = canonicalizeWorldJson(exactRequest)
  const maximumBytes = Math.min(profile(contextProfileId).maximumRequestBytes, model.maximumInputBytes)
  if (exactRequestBytes.byteLength > maximumBytes) {
    failWorld({
      errorCode: 'CONTEXT_WINDOW_EXCEEDED', category: 'provider',
      message: 'Exact Provider request exceeds the selected Context or Model Profile budget', retryable: false,
      correlationId, details: { exactRequestBytes: exactRequestBytes.byteLength, maximumBytes },
    })
  }
  const hashInput: ProviderRequestHashInput = {
    schemaVersion: 'provider-request-hash/v1', contextHash,
    rendererId: renderer.rendererId, rendererHash: renderer.rendererHash,
    toolSchemaId: toolSchema.toolSchemaId, toolSchemaHash: toolSchema.toolSchemaHash,
    providerId: model.providerId, modelId: model.modelId, sampling: model.sampling,
    providerUserPartitionValue: model.providerUserPartitionValue,
    exactRequestUtf8Hex: Buffer.from(exactRequestBytes).toString('hex'),
  }
  return { contextHash, exactRequest, exactRequestBytes, providerRequestHash: hashProviderRequest(hashInput) }
}

/**
 * The order a Provider sees the twelve segments in.
 *
 * The Context's own segment order is a semantic contract — `character-controller/v2` fixes it and
 * `contextHash` covers it — but the order messages are sent in is a rendering concern, and it decides how
 * much of a request a Provider can reuse from the same character's previous call. This order puts the
 * parts that never change first: the two fixed contracts, then the output contract, then the world and
 * character anchors. The Continuity baseline and the recent Tail follow, and everything that differs every
 * Round sits last. Nothing here needs to be cached.
 */
const RENDER_ORDER: readonly CharacterContextSegmentKind[] = Object.freeze([
  'host_protocol',
  'controller_contract',
  'output_reminder',
  'world_public_anchor',
  'character_anchor',
  'continuity_checkpoint',
  'recent_interaction_tail',
  'current_self_state',
  'current_scene',
  'verified_recall',
  'current_stimulus',
  'affordances',
])

/**
 * Reorder the Context's segments for the wire.
 *
 * Nothing is validated here: the caller has already recomputed `contextHash`, which fixes every segment's
 * presence, kind and contract order before a request is rendered.
 */
function renderOrder(bundle: CharacterContextBundle): readonly ContextSegment[] {
  const byKind = new Map(bundle.segments.map(segment => [segment.segmentKind, segment]))
  return RENDER_ORDER.map(kind => byKind.get(kind)!)
}

/**
 * Lay one Context segment out as messages.
 *
 * The second layer is the exception: it is sent one block per message. Were it one message, appending a
 * Round would change that whole message and invalidate a Provider's cache from its first byte — which is
 * the sliding window this layout exists to avoid. A block per message means a new Round only appends a
 * message, and everything before it stays byte-identical.
 */
function segmentMessages(segment: ContextSegment): ProviderMessage[] {
  if (segment.segmentKind === 'affordances' && Array.isArray(segment.content)) {
    // The prototype publishes expression independently of interaction performance policies.
    // Keep execution references verbatim, but do not advertise obsolete cue menus.
    const content = segment.content.map(value => {
      const { performances: _performances, ...option } = value as WorldJsonObject
      return option
    })
    return [{ role: 'user', content: jsonString({ segmentKind: segment.segmentKind, content }) }]
  }
  if (segment.segmentKind === 'current_scene') {
    const scene = segment.content as WorldJsonObject
    // Membership also includes absent/hidden characters. Only the authorized observer
    // set belongs in the model-facing scene; scheduling and integrity fields do not.
    const observers = Array.isArray(scene.observerIds) ? scene.observerIds : []
    return [{ role: 'user', content: [
      '【当前公开场景】',
      `场景参考：${jsonString(scene.sceneId ?? null)}`,
      observers.length === 0 ? '当前没有提供可见人物。'
        : `本场景中可观察到的人物：${observers.map(value => jsonString(value)).join('、')}。`,
      '这些是场景资料，不是对你的行为要求。人物在场不代表你知道其私有想法。',
      ...(scene.items === undefined ? [] : [
        `当前可见的受控物品状态与上次观察：${jsonString(scene.items)}`,
        'current 是此刻有权确认的状态；lastObserved 只说明你上次观察到什么，不证明现在仍然如此。',
        'holderId 表示当前保管和携带关系；触碰、翻页、短暂托起或暂放桌上不自动改变该关系。base:take / give / drop 分别取得、转交、解除保管，仍需正式裁定。',
        '历史执行结果说明过去实际发生过什么；对白与自由叙述只说明对方表达或相信什么，不自动覆盖可见状态或已观察的执行结果。',
      ]),
    ].join('\n') }]
  }
  if (segment.segmentKind === 'current_self_state') {
    const self = segment.content as WorldJsonObject
    const cognition = (value: WorldJsonValue | undefined): WorldJsonValue =>
      Array.isArray(value) ? value.map(entry => {
        const record = entry as WorldJsonObject
        return { kind: record.kind ?? null, value: record.value ?? null }
      }) : []
    return [{ role: 'user', content: [
      '【你此刻的状态】',
      `你当前所在的位置：${jsonString(self.locationId ?? null)}。`,
      `你的状态：${jsonString(self.lifecycleState ?? null)}。`,
      `你自己意识到的想法、关系和牵挂：${jsonString(cognition(self.consciousState))}`,
      `角色自身尚未自觉的倾向（不要当成你已经意识到的知识）：${jsonString(cognition(self.latentGuidance))}`,
      '以上心理内容属于你自己的视角，不是其他人的想法或已经成立的世界事实。',
      '位置以当前状态为准；想前往别处或改变物品归属，需要提交对应行动并等待裁定。',
    ].join('\n') }]
  }
  if (segment.segmentKind !== 'recent_interaction_tail') {
    return [{
      role: 'user',
      content: jsonString({ segmentKind: segment.segmentKind, content: segment.content, sourceRefs: segment.sourceRefs }),
    }]
  }
  const tail = segment.content as unknown as InteractionTail
  if (tail.blocks.length === 0) {
    // An empty second layer still has to appear, so "every segment is present" stays a property of the wire.
    return [{ role: 'user', content: jsonString({ segmentKind: 'recent_interaction_tail', content: [], sourceRefs: [] }) }]
  }
  return tail.blocks.map(block => ({
    role: 'user' as const,
    content: jsonString({
      segmentKind: 'recent_interaction_tail',
      content: block,
      sourceRefs: block.observations.map(observation => observation.sourceRef),
    }),
  }))
}

/** Re-present only this character's already authorized publications, without interpreting their intent. */
function ownPublishedHistory(context: CharacterContextBundle): ProviderMessage[] {
  const tail = context.segments.find(segment => segment.segmentKind === 'recent_interaction_tail')!.content as unknown as InteractionTail
  const entries = tail.blocks.flatMap(block => block.observations.flatMap(observation => {
    const observed = observation.content as WorldJsonObject
    const content = observed.content as WorldJsonObject | undefined
    const speech = content?.speech as WorldJsonObject | undefined
    if (observed.observerId !== context.characterId || content?.actorId !== context.characterId
      || content.status !== 'accepted' || speech?.characterId !== context.characterId) return []
    return [{ seq: observation.sourceRef.sourceSeq, roundId: block.roundId,
      segments: publicationSegments(speech) }]
  })).sort((a, b) => a.seq - b.seq)
  if (entries.length === 0) return []
  return [{ role: 'user', content: [
    '【你此前已经发布的表达】',
    '以下从你的近期可见历史中摘出，按时间排列，是已经发布的原文，不是新的刺激或待执行指令。',
    ...entries.map(entry => [
      `已提交回合 ${entry.roundId}，观察序号 ${entry.seq}：`,
      `你的有序表达原文：${jsonString(entry.segments)}`,
    ].join('\n')),
    '这里只记录你曾发布的表达；叙述中的受控状态变化仍以裁定结果为准。',
  ].join('\n') }]
}

/** Render authorized character data in user messages; only fixed Host contracts get control roles. */
export class StructuredPromptRenderer {
  renderCharacter(request: RenderCharacterRequest): RenderedProviderRequest {
    if (request.context.contextProfileId !== request.contextProfileId) {
      throw new TypeError('Character Context Profile does not match render request')
    }
    const { contextHash: _contextHash, ...contextInput } = request.context
    if (request.context.contextHash !== hashCharacterContext(contextInput)) {
      failWorld({
        errorCode: 'CONTEXT_REBUILD_DIVERGED', category: 'integrity',
        message: 'Character Context Hash diverged before rendering', retryable: false,
        correlationId: request.correlationId, address: request.context.address, roundId: request.context.roundId,
      })
    }
    const messages: ProviderMessage[] = []
    for (const [index, segment] of renderOrder(request.context).entries()) {
      if (index === 0) {
        messages.push({ role: 'system', content: jsonString(segment.content) })
        continue
      }
      if (index === 1) {
        messages.push({ role: 'developer', content: jsonString(segment.content) })
        continue
      }
      messages.push(...segmentMessages(segment))
      if (segment.segmentKind === 'current_stimulus') messages.push(...ownPublishedHistory(request.context))
    }
    return render(
      request.context.contextHash, messages, request.contextProfileId,
      request.renderer, request.toolSchema, request.modelProfile, request.correlationId,
    )
  }

  renderDirector(request: RenderDirectorRequest): RenderedProviderRequest {
    const { contextHash: _contextHash, ...contextInput } = request.context
    if (request.context.contextHash !== hashDirectorContext(contextInput)) {
      failWorld({
        errorCode: 'CONTEXT_REBUILD_DIVERGED', category: 'integrity',
        message: 'Director Context Hash diverged before rendering', retryable: false,
        correlationId: request.correlationId, address: request.context.address, roundId: request.context.roundId,
      })
    }
    const messages: ProviderMessage[] = [
      { role: 'system', content: jsonString({ protocol: 'world-host/v0', authority: 'proposal_only' }) },
      { role: 'developer', content: jsonString({ controller: 'director', tool: request.toolSchema.toolSchemaId }) },
      { role: 'user', content: jsonString(request.context) },
    ]
    return render(
      request.context.contextHash, messages, request.contextProfileId,
      request.renderer, request.toolSchema, request.modelProfile, request.correlationId,
    )
  }
}
