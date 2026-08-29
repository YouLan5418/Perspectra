import {
  failWorld,
  hashWorldJson,
  type AgentProvider,
  type Proposal,
  type ProposalContext,
  type WorldHash,
  type WorldJsonObject,
  type WorldJsonValue,
} from '@harness-world/contracts'
import { SubmitActionsValidator, type SubmitActionsAuthorization } from './submit-actions.ts'

export interface ModelProfile extends WorldJsonObject {
  readonly profileId: string
  readonly version: number
  readonly privacyClass: 'local' | 'approved-remote'
  readonly maxInputTokens: number
  readonly maxOutputTokens: number
}

export interface HarnessAgentPortRequest {
  readonly profile: ModelProfile
  readonly context: ProposalContext
}

export interface HarnessAgentPort {
  submitActions(request: HarnessAgentPortRequest): Promise<WorldJsonValue>
}

/** Default bridge used until a source-compatible, licensed Harness adapter is installed. */
export class DisabledHarnessBridge implements HarnessAgentPort {
  async submitActions(request: HarnessAgentPortRequest): Promise<WorldJsonValue> {
    failWorld({
      errorCode: 'MODEL_PROVIDER_FAILED',
      category: 'provider',
      message: 'Harness model bridge is disabled',
      retryable: true,
      correlationId: `harness-disabled:${request.profile.profileId}`,
      address: request.context.address,
      roundId: request.context.roundId,
    })
  }
}

/** Contract adapter that never exposes the local Harness source tree to production imports. */
export class HarnessAgentProvider implements AgentProvider {
  constructor(
    private readonly port: HarnessAgentPort,
    private readonly profile: ModelProfile,
    private readonly validator: SubmitActionsValidator,
    private readonly authorization: SubmitActionsAuthorization,
  ) {}

  async propose(context: ProposalContext): Promise<Proposal> {
    const payload = await this.port.submitActions({ profile: this.profile, context })
    return this.validator.validate(payload, this.authorization)
  }
}

export interface BudgetReservation extends WorldJsonObject {
  readonly callId: string
  readonly reservedTokens: number
  readonly reservationHash: WorldHash
}

/** Stable in-process token reservation ledger; callers reserve before provider invocation. */
export class ModelBudgetLedger {
  readonly #reservations = new Map<string, BudgetReservation>()
  #remaining: number

  constructor(totalTokens: number) {
    if (!Number.isSafeInteger(totalTokens) || totalTokens < 0) throw new RangeError('totalTokens must be a non-negative safe integer')
    this.#remaining = totalTokens
  }

  reserve(callId: string, tokens: number): BudgetReservation | undefined {
    if (callId.length === 0 || callId.trim() !== callId) throw new TypeError('callId must be a non-empty string')
    if (!Number.isSafeInteger(tokens) || tokens <= 0) throw new RangeError('tokens must be a positive safe integer')
    const existing = this.#reservations.get(callId)
    if (existing !== undefined) {
      if (existing.reservedTokens !== tokens) throw new Error('callId is already bound to another budget reservation')
      return existing
    }
    if (tokens > this.#remaining) return undefined
    const reservationHash = hashWorldJson('model-budget-reservation', { callId, tokens })
    const reservation = { callId, reservedTokens: tokens, reservationHash }
    this.#reservations.set(callId, reservation)
    this.#remaining -= tokens
    return reservation
  }

  settle(callId: string, usedTokens: number): void {
    const reservation = this.#reservations.get(callId)
    if (reservation === undefined) throw new Error('unknown model budget reservation')
    if (!Number.isSafeInteger(usedTokens) || usedTokens < 0 || usedTokens > reservation.reservedTokens) {
      throw new RangeError('usedTokens must fit inside the reservation')
    }
    this.#remaining += reservation.reservedTokens - usedTokens
    this.#reservations.delete(callId)
  }

  get remainingTokens(): number {
    return this.#remaining
  }
}

export interface SafeProposalResult {
  readonly status: 'proposed' | 'fallback'
  readonly proposal: Proposal
  readonly failure?: 'budget_exhausted' | 'provider_failed' | 'provider_timeout'
}

export type SafeProviderResult<Output extends WorldJsonObject> =
  | { readonly status: 'proposed'; readonly output: Output }
  | { readonly status: 'fallback'; readonly failure: 'budget_exhausted' | 'provider_failed' | 'provider_timeout' }

class ProviderTimeout extends Error {}

/** Failure-contained provider runner; it always yields a proposal envelope. */
export class SafeAgentRunner {
  constructor(private readonly budget: ModelBudgetLedger) {}

  async propose(
    callId: string,
    estimatedTokens: number,
    timeoutMs: number,
    participantId: string,
    provider: AgentProvider,
    context: ProposalContext,
  ): Promise<SafeProposalResult> {
    const result = await this.invoke(callId, estimatedTokens, timeoutMs, provider, context)
    return result.status === 'proposed'
      ? { status: 'proposed', proposal: result.output }
      : { status: 'fallback', proposal: { participantId, actions: [] }, failure: result.failure }
  }

  async invoke<Output extends WorldJsonObject>(
    callId: string,
    estimatedTokens: number,
    timeoutMs: number,
    provider: { propose(context: ProposalContext): Promise<Output> },
    context: ProposalContext,
    beforeDispatch?: () => void,
    afterDispatch?: () => void,
  ): Promise<SafeProviderResult<Output>> {
    const reservation = this.budget.reserve(callId, estimatedTokens)
    if (reservation === undefined) return { status: 'fallback', failure: 'budget_exhausted' }
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new RangeError('timeoutMs must be a positive safe integer')
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ProviderTimeout('provider timeout')), timeoutMs)
      })
      beforeDispatch?.()
      const providerResult = provider.propose(context)
      afterDispatch?.()
      const output = await Promise.race([providerResult, timeout])
      this.budget.settle(callId, estimatedTokens)
      return { status: 'proposed', output }
    } catch (error: unknown) {
      this.budget.settle(callId, 0)
      return {
        status: 'fallback',
        failure: error instanceof ProviderTimeout ? 'provider_timeout' : 'provider_failed',
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }
}
