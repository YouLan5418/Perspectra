import type { InteractionRoundId } from './ids.ts'
import type { WorldAddress } from './protocol.ts'
import type { WorldJsonValue } from './world-json.ts'

export type ErrorCategory = 'admission' | 'domain' | 'runtime' | 'persistence' | 'integrity' | 'provider' | 'admin'

export type WorldErrorCode =
  | 'INVALID_REQUEST' | 'UNAUTHORIZED' | 'IDEMPOTENCY_KEY_CONFLICT' | 'ROUND_QUEUE_FULL' | 'ROUND_NOT_CANCELLABLE' | 'BRANCH_DRAINING'
  | 'ACTION_REJECTED' | 'CHARACTER_CANNOT_ACT' | 'ACTION_NOT_AFFORDED' | 'ITEM_NOT_AVAILABLE' | 'TARGET_OUT_OF_RANGE'
  | 'RUNTIME_NOT_READY' | 'WRITER_LEASE_LOST' | 'PARTICIPANT_TIMEOUT' | 'CONTEXT_WINDOW_EXCEEDED'
  | 'WORLDSTORE_BUSY' | 'WORLD_COMMIT_FAILED' | 'SESSION_DELIVERY_OUT_OF_ORDER' | 'DELIVERY_RETRY_EXHAUSTED'
  | 'EVENT_VERSION_UNSUPPORTED' | 'MANIFEST_RUNTIME_UNAVAILABLE' | 'BUNDLE_HASH_MISMATCH' | 'PROJECTION_INVARIANT_FAILED' | 'SESSION_DELIVERY_DIVERGED'
  | 'MODEL_BUDGET_EXHAUSTED' | 'MODEL_PROVIDER_FAILED' | 'MODEL_SCHEMA_INVALID' | 'MEMORY_SOURCE_UNVERIFIED'
  | 'BRANCH_DEPTH_LIMIT' | 'BACKUP_INVALID' | 'IMPORT_ID_CONFLICT' | 'RESTORE_VALIDATION_FAILED'
  | 'BRANCH_QUARANTINED' | 'RECOVERY_VALIDATION_FAILED'

export interface ErrorEnvelope {
  readonly schemaVersion: 1
  readonly errorId: string
  readonly errorCode: WorldErrorCode
  readonly category: ErrorCategory
  readonly message: string
  readonly retryable: boolean
  readonly correlationId: string
  readonly address?: WorldAddress
  readonly roundId?: InteractionRoundId
  readonly details?: WorldJsonValue
  readonly causedByErrorId?: string
}
export type ErrorEnvelopeInput = Omit<ErrorEnvelope, 'schemaVersion' | 'errorId'> & { readonly errorId?: string }

/** Create the stable error representation used across process and storage boundaries. */
export function createErrorEnvelope(input: ErrorEnvelopeInput): ErrorEnvelope {
  return {
    schemaVersion: 1,
    errorId: input.errorId ?? `error:${input.correlationId}:${input.errorCode}`,
    errorCode: input.errorCode,
    category: input.category,
    message: input.message,
    retryable: input.retryable,
    correlationId: input.correlationId,
    ...input.address === undefined ? {} : { address: input.address },
    ...input.roundId === undefined ? {} : { roundId: input.roundId },
    ...input.details === undefined ? {} : { details: input.details },
    ...input.causedByErrorId === undefined ? {} : { causedByErrorId: input.causedByErrorId },
  }
}

/** Error class that preserves an ErrorEnvelope without changing its fields. */
export class WorldError extends Error {
  constructor(readonly envelope: ErrorEnvelope) {
    super(envelope.message)
    this.name = 'WorldError'
  }
}

/** Throw a typed world error at a validated boundary. */
export function failWorld(input: ErrorEnvelopeInput): never {
  throw new WorldError(createErrorEnvelope(input))
}
