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
  type ContextProfileId,
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

/** Render every untrusted semantic segment as a JSON data leaf; only the first two fixed contracts get control roles. */
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
    const [host, controller, ...dataSegments] = request.context.segments
    const messages: ProviderMessage[] = [
      { role: 'system', content: jsonString(host!.content) },
      { role: 'developer', content: jsonString(controller!.content) },
      ...dataSegments.map(segment => ({
        role: 'user' as const,
        content: jsonString({
          segmentKind: segment.segmentKind,
          content: segment.content,
          sourceRefs: segment.sourceRefs,
        }),
      })),
    ]
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
