import { PlayerIntentCallStore } from '@harness-world/agents'
import { bindPlayerIntentCandidate, failWorld, hashWorldJson, type FaultInjector, type PlayerIntentBinding, type PlayerSubmissionV2,
  type WorldAddress, type WorldJsonObject, type WorldJsonValue } from '@harness-world/contracts'
import { PlayerInputJobs, type PlayerInputJob, type WriterLease } from '@harness-world/store-sqlite'

export interface PlayerIntentProfile extends WorldJsonObject {
  readonly version: 'player-intent-profile/v1'
  readonly providerId: string
  readonly modelId: string
  readonly maxOutputTokens: number
  readonly timeoutMs: number
}
export interface PreparedPlayerIntent {
  readonly binding: PlayerIntentBinding
  readonly request: WorldJsonValue
  readonly profile: PlayerIntentProfile
  readonly budgetAvailable: boolean
}
export interface PlayerIntentWorkerOptions {
  readonly worldPath: string
  readonly contextPath: string
  readonly address: WorldAddress
  readonly renewLease: () => WriterLease
  readonly prepare: (job: PlayerInputJob) => PreparedPlayerIntent | { directSubmission: PlayerSubmissionV2 } | { clarification: string }
  readonly dispatch: (request: WorldJsonValue, profile: PlayerIntentProfile, signal: AbortSignal) => Promise<WorldJsonValue>
  /** Idempotent by job.inputId; implementations must consume only its durable validated record. */
  readonly enqueue: (job: PlayerInputJob) => WorldJsonValue
  readonly complete: (job: PlayerInputJob) => Promise<WorldJsonValue>
  readonly faultInjector?: FaultInjector
}

/** Resumes a World-authoritative interpretation without repeating an ambiguous external dispatch. */
export class PlayerIntentWorker {
  constructor(private readonly options: PlayerIntentWorkerOptions) {}

  async processNext(): Promise<PlayerInputJob | undefined> {
    const jobs = new PlayerInputJobs(this.options.worldPath)
    const calls = new PlayerIntentCallStore(this.options.contextPath)
    try {
      let job = jobs.claim(this.options.address, this.options.renewLease())
      if (job === undefined) return undefined
      const advance = (status: PlayerInputJob['status'], evidence: WorldJsonValue) => {
        job = jobs.advance(job!, this.options.renewLease(), status, evidence)
      }
      if (job.status === 'received') {
        const prepared = this.options.prepare(job)
        if ('clarification' in prepared) {
          advance('clarification_required', { reason: prepared.clarification, candidates: [] })
          return job
        }
        if ('directSubmission' in prepared) {
          advance('validated', prepared.directSubmission)
          this.options.faultInjector?.hit('player-input.after-validated')
        } else {
        const profile = prepared.profile
        if (profile.version !== 'player-intent-profile/v1' || !profile.providerId || !profile.modelId
          || !Number.isSafeInteger(profile.timeoutMs) || profile.timeoutMs < 1 || profile.timeoutMs > 60_000
          || !Number.isSafeInteger(profile.maxOutputTokens) || profile.maxOutputTokens < 1) {
          advance('clarification_required', { reason: 'invalid_player_intent_profile', candidates: [] })
          return job
        }
        if (!prepared.budgetAvailable) {
          advance('clarification_required', { reason: 'budget_exhausted', candidates: [] })
          return job
        }
        // This receipt binds precisely the frozen request, profile and Host source binding.
        const { interpretationReceiptHash: _, ...source } = prepared.binding
        const receiptHash = hashWorldJson('player-intent-receipt/v1', { request: prepared.request, profile, source: source as unknown as WorldJsonValue })
        const frozen = { request: prepared.request, profile, binding: { ...source, interpretationReceiptHash: receiptHash } }
        const call = calls.prepare(job.address, job.inputId, frozen as unknown as WorldJsonValue)
        this.options.faultInjector?.hit('player-input.after-call-prepared')
        advance('prepared', { ...frozen as unknown as WorldJsonObject, modelCallId: call.modelCallId })
        this.options.faultInjector?.hit('player-input.after-prepared')
        }
      }
      if (job.status === 'prepared' || job.status === 'dispatch_started' || job.status === 'response_received') {
        const prepared = job.records.prepared as unknown as PreparedPlayerIntent & { modelCallId: string }
        let call = calls.read(prepared.modelCallId)
        if (call === undefined) {
          if (job.status !== 'prepared') {
            // A rebuildable Context DB cannot justify retrying a possibly billed request.
            advance('timed_out_ambiguous', { reason: 'context_response_unavailable', candidates: [] })
            return job
          }
          const { modelCallId: _, ...frozen } = prepared
          call = calls.prepare(job.address, job.inputId, frozen as unknown as WorldJsonValue)
        }
        const { modelCallId: _, ...frozen } = prepared
        if (call.requestHash !== hashWorldJson('player-intent-request/v1', frozen as unknown as WorldJsonValue)
          || (job.status === 'response_received' && (job.records.response_received as { responseHash: string }).responseHash !== call.responseHash)) {
          failWorld({ errorCode: 'BUNDLE_HASH_MISMATCH', category: 'integrity', retryable: false,
            address: job.address, correlationId: job.inputId, message: 'player interpretation diverges from World authority' })
        }
        if (job.status === 'prepared') {
          advance('dispatch_started', { modelCallId: call.modelCallId })
          if (call.state === 'prepared' && calls.start(call.modelCallId)) {
            this.options.faultInjector?.hit('player-input.after-dispatch')
            const controller = new AbortController()
            let timer: ReturnType<typeof setTimeout> | undefined
            const modelCallId = call.modelCallId
            // Late callbacks open their own short-lived Context connection after this worker closes.
            const response = Promise.resolve().then(() => this.options.dispatch(prepared.request, prepared.profile, controller.signal)).then(value => {
              const lateCalls = new PlayerIntentCallStore(this.options.contextPath)
              try { lateCalls.respond(modelCallId, value) } finally { lateCalls.close() }
              return 'response' as const
            }, () => 'failed' as const)
            let heartbeat: ReturnType<typeof setTimeout> | undefined
            const leaseFailure = new Promise<never>((_, reject) => {
              const renew = () => {
                try {
                  const lease = this.options.renewLease()
                  heartbeat = setTimeout(renew, Math.max(1, Math.floor((lease.expiresAtMs - Date.now()) / 3)))
                } catch (error) { reject(error) }
              }
              renew()
            })
            let outcome: 'response' | 'failed' | 'timeout'
            try {
              outcome = await Promise.race([response, leaseFailure, new Promise<'timeout'>(resolve => {
                timer = setTimeout(() => resolve('timeout'), prepared.profile.timeoutMs)
              })])
            } finally {
              clearTimeout(timer)
              clearTimeout(heartbeat)
              controller.abort()
            }
            if (outcome !== 'response') {
              calls.finish(modelCallId, 'dispatch_started', 'timed_out_ambiguous')
              advance('timed_out_ambiguous', { reason: outcome, candidates: [] })
              return job
            }
            this.options.faultInjector?.hit('player-input.after-response')
          }
          call = calls.read(call.modelCallId)!
        }
        if (call.state === 'dispatch_started' || call.state === 'prepared') {
          if (call.state === 'dispatch_started') calls.finish(call.modelCallId, 'dispatch_started', 'timed_out_ambiguous')
          advance('timed_out_ambiguous', { reason: 'dispatch_result_unknown', candidates: [] })
          return job
        }
        if (call.state !== 'response_received' && call.state !== 'validated') {
          advance('invalid_response', { reason: call.state, candidates: [] })
          return job
        }
        if (job.status === 'dispatch_started') advance('response_received', { responseHash: call.responseHash })
        let outcome: ReturnType<typeof bindPlayerIntentCandidate>
        try { outcome = bindPlayerIntentCandidate(call.response, prepared.binding) }
        catch {
          calls.finish(call.modelCallId, 'response_received', 'invalid_response')
          advance('invalid_response', { reason: 'candidate_validation_failed', candidates: [] })
          return job
        }
        if (outcome.status === 'clarification_required') {
          calls.finish(call.modelCallId, 'response_received', 'validated')
          advance('clarification_required', { reason: outcome.reason, candidates: [] })
          return job
        }
        calls.finish(call.modelCallId, 'response_received', 'validated')
        advance('validated', outcome.submission)
        this.options.faultInjector?.hit('player-input.after-validated')
      }
      if (job.status === 'validated') {
        const receipt = this.options.enqueue(job)
        this.options.faultInjector?.hit('player-input.after-round-enqueue')
        advance('round_enqueued', receipt)
      }
      const result = await this.options.complete(job)
      this.options.faultInjector?.hit('player-input.after-world-commit')
      advance('completed', result)
      return job
    } finally { calls.close(); jobs.close() }
  }
}
