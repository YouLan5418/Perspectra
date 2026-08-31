import type { DatabaseSync } from 'node:sqlite'
import {
  assertProtocolString,
  brandId,
  canonicalizeWorldJson,
  compareWorldText,
  deterministicId,
  failWorld,
  hashWorldJson,
  planStableCallBudget,
  type CharacterId,
  type ClaimedReactionJob,
  type FaultInjector,
  type InteractionRoundId,
  type ReactionCycleDraft,
  type ReactionCycleId,
  type ReactionCycleStopReason,
  type ReactionCycleTerminalReason,
  type ReactionJobId,
  type ReactionJobProviderBinding,
  type ReactionWaveSettlementDraft,
  type StableCallBudgetDecision,
  type StableCallBudgetPlan,
  type StoredReactionCycle,
  type StoredReactionCycleBundle,
  type StoredReactionJob,
  type StoredReactionStimulus,
  type StoredReactionWave,
  type TransactionId,
  type WorldAddress,
  type WorldEventDraft,
  type WorldHash,
  type WorldJsonObject,
  type WorldJsonValue,
  worldAddressKey,
} from '@harness-world/contracts'
import { parseWorldJson, rollbackAndThrow, worldJsonText } from './sqlite.ts'

export interface ReactionSourceEvent {
  readonly draft: WorldEventDraft
  readonly eventOrdinal: number
  readonly seq: number
  readonly eventHash: WorldHash
}

export interface PrepareInitialReactionCycleInput {
  readonly address: WorldAddress
  readonly rootRoundId: InteractionRoundId
  readonly rootTransactionId: TransactionId
  readonly finalHeadSeq: number
  readonly finalHeadHash: WorldHash
  readonly draft: ReactionCycleDraft
  readonly events: readonly ReactionSourceEvent[]
}

function safeInteger(value: number, name: string, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be a safe integer from ${minimum} through ${maximum}`)
  }
  return value
}

function objectValue(value: WorldJsonValue, name: string): WorldJsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError(`${name} must be an object`)
  return value as WorldJsonObject
}

function exactJson(text: string, name: string): WorldJsonValue {
  const value = parseWorldJson(text)
  if (worldJsonText(value) !== text) throw new Error(`${name} is not stored as canonical World JSON`)
  return value
}

function hashCycle(cycle: Omit<StoredReactionCycle, 'status' | 'stopReason' | 'terminalReason' | 'terminalAtSeq' | 'cycleHash' | 'stateHash'>): WorldHash {
  return hashWorldJson('reaction-cycle/v1', cycle)
}

export function hashReactionCycleState(cycle: StoredReactionCycle): WorldHash {
  return hashWorldJson('reaction-cycle-state/v1', {
    cycleId: cycle.cycleId,
    cycleHash: cycle.cycleHash,
    status: cycle.status,
    stopReason: cycle.stopReason,
    terminalReason: cycle.terminalReason,
    terminalAtSeq: cycle.terminalAtSeq,
  })
}

function hashWave(wave: Omit<StoredReactionWave, 'status' | 'reactionRoundId' | 'resultTransactionId' | 'authorityHash' | 'waveHash' | 'stateHash'>): WorldHash {
  return hashWorldJson('reaction-wave/v1', wave)
}

export function hashReactionWaveState(wave: StoredReactionWave): WorldHash {
  return hashWorldJson('reaction-wave-state/v1', {
    cycleId: wave.cycleId,
    wave: wave.wave,
    waveHash: wave.waveHash,
    status: wave.status,
    reactionRoundId: wave.reactionRoundId,
    resultTransactionId: wave.resultTransactionId,
    authorityHash: wave.authorityHash,
  })
}

function hashJob(job: Omit<StoredReactionJob,
  | 'status'
  | 'claimOwnerId'
  | 'claimExpiresAtMs'
  | 'claimFencingToken'
  | 'attemptCount'
  | 'outcome'
  | 'contextReceiptId'
  | 'contextReceiptHash'
  | 'providerCallId'
  | 'providerRequestHash'
  | 'proposalHash'
  | 'resultTransactionId'
  | 'jobHash'
  | 'stateHash'
>): WorldHash {
  return hashWorldJson('reaction-job/v1', job)
}

export function hashReactionJobState(job: StoredReactionJob): WorldHash {
  return hashWorldJson('reaction-job-state/v1', {
    jobId: job.jobId,
    jobHash: job.jobHash,
    status: job.status,
    claimOwnerId: job.claimOwnerId,
    claimExpiresAtMs: job.claimExpiresAtMs,
    claimFencingToken: job.claimFencingToken,
    attemptCount: job.attemptCount,
    outcome: job.outcome,
    contextReceiptId: job.contextReceiptId,
    contextReceiptHash: job.contextReceiptHash,
    providerCallId: job.providerCallId,
    providerRequestHash: job.providerRequestHash,
    proposalHash: job.proposalHash,
    resultTransactionId: job.resultTransactionId,
  })
}

export function hashReactionStimulusEntry(stimulus: Omit<StoredReactionStimulus, 'stimulusEntryHash'>): WorldHash {
  return hashWorldJson('reaction-stimulus-entry/v1', stimulus)
}

function hashStimulusBundle(characterId: CharacterId, stimuli: ReadonlyArray<{
  readonly sourceEventSeq: number
  readonly sourceEventOrdinal: number
  readonly observationOrdinal: number
  readonly observationId: string
  readonly sourceEventHash: WorldHash
}>): WorldHash {
  return hashWorldJson('reaction-stimulus-bundle/v1', {
    characterId,
    entries: stimuli.map(value => ({
      sourceEventSeq: value.sourceEventSeq,
      sourceEventOrdinal: value.sourceEventOrdinal,
      observationOrdinal: value.observationOrdinal,
      observationId: value.observationId,
      sourceEventHash: value.sourceEventHash,
    })),
  })
}

interface ReactionCycleBundleContent {
  readonly cycle: StoredReactionCycle
  readonly waves: readonly StoredReactionWave[]
  readonly jobs: readonly StoredReactionJob[]
  readonly stimuli: readonly StoredReactionStimulus[]
}

export function hashReactionCycleAuthority(input: ReactionCycleBundleContent): WorldHash {
  return hashWorldJson('reaction-cycle-initial-bundle/v1', {
    cycleHash: input.cycle.cycleHash,
    waveHashes: input.waves.map(wave => wave.waveHash),
    jobHashes: input.jobs.map(job => job.jobHash),
    stimulusEntryHashes: input.stimuli.map(stimulus => stimulus.stimulusEntryHash),
  })
}

export function hashReactionCycleBundle(input: ReactionCycleBundleContent): WorldHash {
  return hashWorldJson('reaction-cycle-state-bundle/v1', {
    authorityHash: hashReactionCycleAuthority(input),
    cycleStateHash: input.cycle.stateHash,
    waveStateHashes: input.waves.map(wave => wave.stateHash),
    jobStateHashes: input.jobs.map(job => job.stateHash),
  })
}

function validatePolicy(draft: ReactionCycleDraft): void {
  canonicalizeWorldJson(draft)
  if (draft.policyVersion !== 'reaction-policy/v1' || draft.profileId !== 'responsive/v1') {
    throw new TypeError('Reaction Cycle policy must be reaction-policy/v1 responsive/v1')
  }
  safeInteger(draft.maxWaves, 'reactionCycle.maxWaves', 1, 3)
  safeInteger(draft.maxNpcCalls, 'reactionCycle.maxNpcCalls', 1, 8)
  safeInteger(draft.maxCallsPerCharacter, 'reactionCycle.maxCallsPerCharacter', 1, 2)
  if (draft.maxActionsPerCall !== 1) throw new RangeError('reactionCycle.maxActionsPerCall must equal one')
  if (draft.allowedActionTypes.length !== 1 || draft.allowedActionTypes[0] !== 'speak@1') {
    throw new TypeError('Reaction Cycle v1 only allows speak@1')
  }
  safeInteger(draft.initialTokenBudget, 'reactionCycle.initialTokenBudget', 0)
  safeInteger(draft.deadlineAtMs, 'reactionCycle.deadlineAtMs', 0)
  if (draft.candidates.length === 0) throw new TypeError('Reaction Cycle requires at least one candidate')
}

function reactionCycleIdentity(input: PrepareInitialReactionCycleInput): {
  readonly cycleId: ReactionCycleId
  readonly budgetHash: WorldHash
} {
  const cycleId = brandId(deterministicId('reaction-cycle', {
    address: input.address,
    rootRoundId: input.rootRoundId,
    rootTransactionId: input.rootTransactionId,
    createdAtSeq: input.finalHeadSeq,
  }), 'ReactionCycleId')
  const budgetHash = hashWorldJson('reaction-cycle-budget/v1', {
    policyVersion: input.draft.policyVersion,
    profileId: input.draft.profileId,
    maxWaves: input.draft.maxWaves,
    maxNpcCalls: input.draft.maxNpcCalls,
    maxCallsPerCharacter: input.draft.maxCallsPerCharacter,
    maxActionsPerCall: input.draft.maxActionsPerCall,
    allowedActionTypes: input.draft.allowedActionTypes,
    initialTokenBudget: input.draft.initialTokenBudget,
    deadlineAtMs: input.draft.deadlineAtMs,
  })
  return { cycleId, budgetHash }
}

function prepareStimuli(
  input: PrepareInitialReactionCycleInput,
  cycleId: ReactionCycleId,
  characterId: CharacterId,
  sourceDrafts: ReactionCycleDraft['candidates'][number]['stimuli'],
): { readonly jobId: ReactionJobId; readonly stimulusHash: WorldHash; readonly stimuli: readonly StoredReactionStimulus[] } {
  if (sourceDrafts.length === 0) throw new TypeError('Reaction candidate requires at least one authorized stimulus')
  const ordered = [...sourceDrafts].sort((left, right) => left.sourceEventOrdinal - right.sourceEventOrdinal
    || left.observationOrdinal - right.observationOrdinal)
  const identities = new Set<string>()
  const partial = ordered.map((source, stimulusOrdinal) => {
    safeInteger(source.sourceEventOrdinal, 'reaction stimulus sourceEventOrdinal', 0)
    safeInteger(source.observationOrdinal, 'reaction stimulus observationOrdinal', 0)
    const identity = `${source.sourceEventOrdinal}:${source.observationOrdinal}`
    if (identities.has(identity)) throw new TypeError('Reaction candidate contains duplicate stimulus source coordinates')
    identities.add(identity)
    if (source.observerCharacterId !== characterId) throw new TypeError('Reaction stimulus observer does not match candidate character')
    if (source.observationOrdinal !== 0) throw new TypeError('observation.upsert v1 contains exactly one Observation')
    const event = input.events[source.sourceEventOrdinal]
    if (event === undefined || event.eventOrdinal !== source.sourceEventOrdinal || event.draft.eventType !== 'observation.upsert') {
      throw new TypeError('Reaction stimulus must reference an observation.upsert in the Root Round')
    }
    const data = objectValue(event.draft.data, 'observation.upsert data')
    const value = objectValue(data.value as WorldJsonValue, 'observation.upsert value')
    if (data.id !== source.observationId || value.observerId !== characterId) {
      throw new TypeError('Reaction stimulus identity or observer diverges from its source Observation')
    }
    return {
      address: input.address,
      stimulusOrdinal,
      observerCharacterId: characterId,
      sourceRoundId: input.rootRoundId,
      sourceTransactionId: input.rootTransactionId,
      sourceEventSeq: event.seq,
      sourceEventOrdinal: event.eventOrdinal,
      observationOrdinal: source.observationOrdinal,
      observationId: source.observationId,
      sourceEventHash: event.eventHash,
    }
  })
  const stimulusHash = hashStimulusBundle(characterId, partial)
  const jobId = brandId(deterministicId('reaction-job', {
    address: input.address, cycleId, wave: 1, characterId, stimulusHash,
  }), 'ReactionJobId')
  const stimuli = partial.map(value => {
    const withoutHash = { jobId, ...value }
    return { ...withoutHash, stimulusEntryHash: hashReactionStimulusEntry(withoutHash) }
  })
  return { jobId, stimulusHash, stimuli }
}

function prepareJob(
  input: PrepareInitialReactionCycleInput,
  cycleId: ReactionCycleId,
  decision: StableCallBudgetDecision,
): StoredReactionJob {
  const budgetDecision = decision.status === 'reserved' ? 'reserved' : decision.exclusion!
  const immutable = {
    jobId: brandId(decision.candidate.jobId, 'ReactionJobId'),
    address: input.address,
    cycleId,
    wave: 1,
    characterId: decision.candidate.characterId,
    stimulusHash: decision.candidate.stimulusHash,
    budgetDecision,
    budgetOrdinal: decision.reservationOrdinal,
    reservedTokens: decision.status === 'reserved' ? decision.candidate.estimatedTokens : 0,
  } as const
  const jobHash = hashJob(immutable)
  const job: StoredReactionJob = {
    ...immutable,
    status: decision.status === 'reserved' ? 'pending' : 'skipped',
    claimOwnerId: null,
    claimExpiresAtMs: null,
    claimFencingToken: null,
    attemptCount: 0,
    outcome: null,
    contextReceiptId: null,
    contextReceiptHash: null,
    providerCallId: null,
    providerRequestHash: null,
    proposalHash: null,
    resultTransactionId: null,
    jobHash,
    stateHash: 'sha256:pending',
  }
  return { ...job, stateHash: hashReactionJobState(job) }
}

/** Build the exact initial Cycle rows from one Root Round before the enclosing transaction commits. */
export function prepareInitialReactionCycle(input: PrepareInitialReactionCycleInput): StoredReactionCycleBundle {
  validatePolicy(input.draft)
  safeInteger(input.finalHeadSeq, 'reactionCycle.finalHeadSeq', 1)
  if (input.events.length === 0 || input.events.at(-1)?.seq !== input.finalHeadSeq) {
    throw new TypeError('Reaction Cycle events do not end at finalHeadSeq')
  }
  const { cycleId, budgetHash } = reactionCycleIdentity(input)
  const seenCharacters = new Set<CharacterId>()
  const preparedCandidates = input.draft.candidates.map(candidate => {
    if (seenCharacters.has(candidate.characterId)) throw new TypeError('Reaction Cycle contains duplicate candidate characters')
    seenCharacters.add(candidate.characterId)
    safeInteger(candidate.estimatedTokens, 'reaction candidate estimatedTokens', 1)
    const prepared = prepareStimuli(input, cycleId, candidate.characterId, candidate.stimuli)
    return { candidate, ...prepared }
  })
  const budgetPlan = planStableCallBudget(preparedCandidates.map(value => ({
    wave: 1,
    characterId: value.candidate.characterId,
    stimulusHash: value.stimulusHash,
    jobId: value.jobId,
    estimatedTokens: value.candidate.estimatedTokens,
  })), {
    remainingCalls: input.draft.maxNpcCalls,
    remainingTokens: input.draft.initialTokenBudget,
    maxCallsPerCharacter: input.draft.maxCallsPerCharacter,
    usedCallsByCharacter: [],
  })
  const immutableCycle = {
    cycleId,
    address: input.address,
    rootRoundId: input.rootRoundId,
    rootTransactionId: input.rootTransactionId,
    createdAtSeq: input.finalHeadSeq,
    policyVersion: input.draft.policyVersion,
    profileId: input.draft.profileId,
    maxWaves: input.draft.maxWaves,
    maxNpcCalls: input.draft.maxNpcCalls,
    maxCallsPerCharacter: input.draft.maxCallsPerCharacter,
    maxActionsPerCall: input.draft.maxActionsPerCall,
    allowedActionTypes: input.draft.allowedActionTypes,
    initialTokenBudget: input.draft.initialTokenBudget,
    deadlineAtMs: input.draft.deadlineAtMs,
    budgetHash,
  } as const
  const cycleHash = hashCycle(immutableCycle)
  const cycleSeed: StoredReactionCycle = {
    ...immutableCycle,
    status: 'active',
    stopReason: null,
    terminalReason: null,
    terminalAtSeq: null,
    cycleHash,
    stateHash: 'sha256:pending',
  }
  const cycle = { ...cycleSeed, stateHash: hashReactionCycleState(cycleSeed) }
  const immutableWave = {
    cycleId,
    address: input.address,
    wave: 1,
    baseHeadSeq: input.finalHeadSeq,
    baseHeadHash: input.finalHeadHash,
    callsBefore: 0,
    tokensBefore: input.draft.initialTokenBudget,
    budgetPlan,
    budgetPlanHash: budgetPlan.planHash,
    reservedCalls: budgetPlan.reservedCalls,
    reservedTokens: budgetPlan.reservedTokens,
  } as const
  const waveHash = hashWave(immutableWave)
  const waveSeed: StoredReactionWave = {
    ...immutableWave,
    status: 'frozen',
    reactionRoundId: null,
    resultTransactionId: null,
    authorityHash: null,
    waveHash,
    stateHash: 'sha256:pending',
  }
  const wave = { ...waveSeed, stateHash: hashReactionWaveState(waveSeed) }
  const jobs = budgetPlan.decisions.map(decision => prepareJob(input, cycleId, decision))
  const stimuliByJob = new Map(preparedCandidates.map(value => [value.jobId, value.stimuli] as const))
  const stimuli = jobs.flatMap(job => stimuliByJob.get(job.jobId)!)
  const bundle = { cycle, waves: [wave], jobs, stimuli }
  return {
    ...bundle,
    authorityHash: hashReactionCycleAuthority(bundle),
    bundleHash: hashReactionCycleBundle(bundle),
  }
}

/** Insert an already prepared initial bundle on the caller-owned World transaction. */
export function insertInitialReactionCycle(db: DatabaseSync, bundle: StoredReactionCycleBundle): void {
  const cycle = bundle.cycle
  db.prepare(`
    INSERT INTO world_reaction_cycles(
      cycle_id, address_key, root_round_id, root_transaction_id, created_at_seq,
      policy_version, profile_id, max_waves, max_npc_calls, max_calls_per_character,
      max_actions_per_call, allowed_action_types_json, initial_token_budget, deadline_at_ms,
      budget_hash, status, stop_reason, terminal_reason, terminal_at_seq, cycle_hash, state_hash
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    cycle.cycleId,
    worldAddressKey(cycle.address),
    cycle.rootRoundId,
    cycle.rootTransactionId,
    cycle.createdAtSeq,
    cycle.policyVersion,
    cycle.profileId,
    cycle.maxWaves,
    cycle.maxNpcCalls,
    cycle.maxCallsPerCharacter,
    cycle.maxActionsPerCall,
    worldJsonText(cycle.allowedActionTypes),
    cycle.initialTokenBudget,
    cycle.deadlineAtMs,
    cycle.budgetHash,
    cycle.status,
    cycle.stopReason,
    cycle.terminalReason,
    cycle.terminalAtSeq,
    cycle.cycleHash,
    cycle.stateHash,
  )
  for (const wave of bundle.waves) {
    db.prepare(`
      INSERT INTO world_reaction_waves(
        cycle_id, address_key, wave, base_head_seq, base_head_hash, calls_before, tokens_before,
        budget_plan_json, budget_plan_hash, reserved_calls, reserved_tokens, status,
        reaction_round_id, result_transaction_id, authority_hash, wave_hash, state_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      wave.cycleId,
      worldAddressKey(wave.address),
      wave.wave,
      wave.baseHeadSeq,
      wave.baseHeadHash,
      wave.callsBefore,
      wave.tokensBefore,
      worldJsonText(wave.budgetPlan),
      wave.budgetPlanHash,
      wave.reservedCalls,
      wave.reservedTokens,
      wave.status,
      wave.reactionRoundId,
      wave.resultTransactionId,
      wave.authorityHash,
      wave.waveHash,
      wave.stateHash,
    )
  }
  for (const job of bundle.jobs) {
    db.prepare(`
      INSERT INTO world_reaction_jobs(
        job_id, address_key, cycle_id, wave, character_id, stimulus_hash, status,
        budget_decision, budget_ordinal, reserved_tokens, claim_owner_id, claim_expires_at_ms,
        claim_fencing_token, attempt_count, outcome, context_receipt_id, context_receipt_hash,
        provider_call_id, provider_request_hash, proposal_hash, result_transaction_id, job_hash, state_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      job.jobId,
      worldAddressKey(job.address),
      job.cycleId,
      job.wave,
      job.characterId,
      job.stimulusHash,
      job.status,
      job.budgetDecision,
      job.budgetOrdinal,
      job.reservedTokens,
      job.claimOwnerId,
      job.claimExpiresAtMs,
      job.claimFencingToken,
      job.attemptCount,
      job.outcome,
      job.contextReceiptId,
      job.contextReceiptHash,
      job.providerCallId,
      job.providerRequestHash,
      job.proposalHash,
      job.resultTransactionId,
      job.jobHash,
      job.stateHash,
    )
  }
  for (const stimulus of bundle.stimuli) {
    db.prepare(`
      INSERT INTO world_reaction_job_stimuli(
        job_id, address_key, stimulus_ordinal, observer_character_id, source_round_id,
        source_transaction_id, source_event_seq, source_event_ordinal, observation_ordinal,
        observation_id, source_event_hash, stimulus_entry_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      stimulus.jobId,
      worldAddressKey(stimulus.address),
      stimulus.stimulusOrdinal,
      stimulus.observerCharacterId,
      stimulus.sourceRoundId,
      stimulus.sourceTransactionId,
      stimulus.sourceEventSeq,
      stimulus.sourceEventOrdinal,
      stimulus.observationOrdinal,
      stimulus.observationId,
      stimulus.sourceEventHash,
      stimulus.stimulusEntryHash,
    )
  }
}

function worldHash(value: string, name: string): WorldHash {
  if (!/^sha256:[0-9a-f]{64}$/u.test(value)) throw new Error(`${name} is not a lowercase WorldHash`)
  return value as WorldHash
}

function nullableWorldHash(value: string | null, name: string): WorldHash | null {
  return value === null ? null : worldHash(value, name)
}

interface CycleRow {
  readonly cycle_id: string
  readonly root_round_id: string
  readonly root_transaction_id: string
  readonly created_at_seq: number
  readonly policy_version: string
  readonly profile_id: string
  readonly max_waves: number
  readonly max_npc_calls: number
  readonly max_calls_per_character: number
  readonly max_actions_per_call: number
  readonly allowed_action_types_json: string
  readonly initial_token_budget: number
  readonly deadline_at_ms: number
  readonly budget_hash: string
  readonly status: StoredReactionCycle['status']
  readonly stop_reason: StoredReactionCycle['stopReason']
  readonly terminal_reason: StoredReactionCycle['terminalReason']
  readonly terminal_at_seq: number | null
  readonly cycle_hash: string
  readonly state_hash: string
}

interface WaveRow {
  readonly cycle_id: string
  readonly wave: number
  readonly base_head_seq: number
  readonly base_head_hash: string
  readonly calls_before: number
  readonly tokens_before: number
  readonly budget_plan_json: string
  readonly budget_plan_hash: string
  readonly reserved_calls: number
  readonly reserved_tokens: number
  readonly status: StoredReactionWave['status']
  readonly reaction_round_id: string | null
  readonly result_transaction_id: string | null
  readonly authority_hash: string | null
  readonly wave_hash: string
  readonly state_hash: string
}

interface JobRow {
  readonly job_id: string
  readonly cycle_id: string
  readonly wave: number
  readonly character_id: string
  readonly stimulus_hash: string
  readonly status: StoredReactionJob['status']
  readonly budget_decision: StoredReactionJob['budgetDecision']
  readonly budget_ordinal: number | null
  readonly reserved_tokens: number
  readonly claim_owner_id: string | null
  readonly claim_expires_at_ms: number | null
  readonly claim_fencing_token: number | null
  readonly attempt_count: number
  readonly outcome: StoredReactionJob['outcome']
  readonly context_receipt_id: string | null
  readonly context_receipt_hash: string | null
  readonly provider_call_id: string | null
  readonly provider_request_hash: string | null
  readonly proposal_hash: string | null
  readonly result_transaction_id: string | null
  readonly job_hash: string
  readonly state_hash: string
}

interface StimulusRow {
  readonly job_id: string
  readonly stimulus_ordinal: number
  readonly observer_character_id: string
  readonly source_round_id: string
  readonly source_transaction_id: string
  readonly source_event_seq: number
  readonly source_event_ordinal: number
  readonly observation_ordinal: number
  readonly observation_id: string
  readonly source_event_hash: string
  readonly stimulus_entry_hash: string
}

function parseBudgetPlan(text: string, expectedHash: string): StableCallBudgetPlan {
  const value = objectValue(exactJson(text, 'Reaction wave budget plan'), 'Reaction wave budget plan')
  if (!Array.isArray(value.decisions) || typeof value.limits !== 'object' || value.limits === null
    || Array.isArray(value.limits) || typeof value.planHash !== 'string') {
    throw new Error('Reaction wave budget plan is malformed')
  }
  const plan = value as unknown as StableCallBudgetPlan
  const replay = planStableCallBudget(plan.decisions.map(decision => decision.candidate), plan.limits)
  if (worldJsonText(replay) !== text || replay.planHash !== expectedHash) {
    throw new Error('Reaction wave budget plan is divergent')
  }
  return plan
}

function readCycleRow(db: DatabaseSync, addressKey: string, selector: { readonly cycleId?: string; readonly rootTransactionId?: string }): CycleRow | undefined {
  if (selector.cycleId !== undefined) {
    return db.prepare(`SELECT * FROM world_reaction_cycles WHERE address_key = ? AND cycle_id = ?`)
      .get(addressKey, selector.cycleId) as unknown as CycleRow | undefined
  }
  if (selector.rootTransactionId !== undefined) {
    return db.prepare(`SELECT * FROM world_reaction_cycles WHERE address_key = ? AND root_transaction_id = ?`)
      .get(addressKey, selector.rootTransactionId) as unknown as CycleRow | undefined
  }
  return db.prepare(`SELECT * FROM world_reaction_cycles WHERE address_key = ? AND status <> 'terminal'`)
    .get(addressKey) as unknown as CycleRow | undefined
}

function readReactionCycle(
  db: DatabaseSync,
  address: WorldAddress,
  selector: { readonly cycleId?: string; readonly rootTransactionId?: string },
): StoredReactionCycleBundle | undefined {
  const addressKey = worldAddressKey(address)
  const row = readCycleRow(db, addressKey, selector)
  if (row === undefined) return undefined
  const allowed = exactJson(row.allowed_action_types_json, 'Reaction Cycle allowed Action types')
  if (!Array.isArray(allowed) || allowed.length !== 1 || allowed[0] !== 'speak@1'
    || row.policy_version !== 'reaction-policy/v1' || row.profile_id !== 'responsive/v1'
    || row.max_actions_per_call !== 1) {
    throw new Error('Reaction Cycle policy row is malformed')
  }
  const cycleId = brandId(row.cycle_id, 'ReactionCycleId')
  const cycle: StoredReactionCycle = {
    cycleId,
    address,
    rootRoundId: brandId(row.root_round_id, 'InteractionRoundId'),
    rootTransactionId: brandId(row.root_transaction_id, 'TransactionId'),
    createdAtSeq: row.created_at_seq,
    policyVersion: row.policy_version,
    profileId: row.profile_id,
    maxWaves: row.max_waves,
    maxNpcCalls: row.max_npc_calls,
    maxCallsPerCharacter: row.max_calls_per_character,
    maxActionsPerCall: row.max_actions_per_call,
    allowedActionTypes: ['speak@1'],
    initialTokenBudget: row.initial_token_budget,
    deadlineAtMs: row.deadline_at_ms,
    budgetHash: worldHash(row.budget_hash, 'Reaction Cycle budget_hash'),
    status: row.status,
    stopReason: row.stop_reason,
    terminalReason: row.terminal_reason,
    terminalAtSeq: row.terminal_at_seq,
    cycleHash: worldHash(row.cycle_hash, 'Reaction Cycle cycle_hash'),
    stateHash: worldHash(row.state_hash, 'Reaction Cycle state_hash'),
  }
  const immutableCycle = {
    cycleId: cycle.cycleId,
    address: cycle.address,
    rootRoundId: cycle.rootRoundId,
    rootTransactionId: cycle.rootTransactionId,
    createdAtSeq: cycle.createdAtSeq,
    policyVersion: cycle.policyVersion,
    profileId: cycle.profileId,
    maxWaves: cycle.maxWaves,
    maxNpcCalls: cycle.maxNpcCalls,
    maxCallsPerCharacter: cycle.maxCallsPerCharacter,
    maxActionsPerCall: cycle.maxActionsPerCall,
    allowedActionTypes: cycle.allowedActionTypes,
    initialTokenBudget: cycle.initialTokenBudget,
    deadlineAtMs: cycle.deadlineAtMs,
    budgetHash: cycle.budgetHash,
  }
  if (hashCycle(immutableCycle) !== cycle.cycleHash || hashReactionCycleState(cycle) !== cycle.stateHash) {
    throw new Error('Reaction Cycle hash is divergent')
  }

  const waveRows = db.prepare(`SELECT * FROM world_reaction_waves WHERE cycle_id = ? ORDER BY wave`).all(cycleId) as unknown as WaveRow[]
  const waves = waveRows.map((waveRow, index): StoredReactionWave => {
    if (waveRow.wave !== index + 1) throw new Error('Reaction Cycle wave sequence is discontinuous')
    const budgetPlan = parseBudgetPlan(waveRow.budget_plan_json, waveRow.budget_plan_hash)
    const wave: StoredReactionWave = {
      cycleId,
      address,
      wave: waveRow.wave,
      baseHeadSeq: waveRow.base_head_seq,
      baseHeadHash: worldHash(waveRow.base_head_hash, 'Reaction wave base_head_hash'),
      callsBefore: waveRow.calls_before,
      tokensBefore: waveRow.tokens_before,
      budgetPlan,
      budgetPlanHash: worldHash(waveRow.budget_plan_hash, 'Reaction wave budget_plan_hash'),
      reservedCalls: waveRow.reserved_calls,
      reservedTokens: waveRow.reserved_tokens,
      status: waveRow.status,
      reactionRoundId: waveRow.reaction_round_id === null ? null : brandId(waveRow.reaction_round_id, 'InteractionRoundId'),
      resultTransactionId: waveRow.result_transaction_id === null ? null : brandId(waveRow.result_transaction_id, 'TransactionId'),
      authorityHash: nullableWorldHash(waveRow.authority_hash, 'Reaction wave authority_hash'),
      waveHash: worldHash(waveRow.wave_hash, 'Reaction wave wave_hash'),
      stateHash: worldHash(waveRow.state_hash, 'Reaction wave state_hash'),
    }
    const immutable = {
      cycleId: wave.cycleId,
      address: wave.address,
      wave: wave.wave,
      baseHeadSeq: wave.baseHeadSeq,
      baseHeadHash: wave.baseHeadHash,
      callsBefore: wave.callsBefore,
      tokensBefore: wave.tokensBefore,
      budgetPlan: wave.budgetPlan,
      budgetPlanHash: wave.budgetPlanHash,
      reservedCalls: wave.reservedCalls,
      reservedTokens: wave.reservedTokens,
    }
    if (hashWave(immutable) !== wave.waveHash || hashReactionWaveState(wave) !== wave.stateHash) {
      throw new Error('Reaction wave hash is divergent')
    }
    return wave
  })
  if (waves.length === 0 || waves.length > cycle.maxWaves) throw new Error('Reaction Cycle wave count is invalid')

  const jobRows = db.prepare(`SELECT * FROM world_reaction_jobs WHERE cycle_id = ?`).all(cycleId) as unknown as JobRow[]
  jobRows.sort((left, right) => compareWorldText(
    `${left.wave}\u001f${left.character_id}\u001f${left.stimulus_hash}\u001f${left.job_id}`,
    `${right.wave}\u001f${right.character_id}\u001f${right.stimulus_hash}\u001f${right.job_id}`,
  ))
  const jobs = jobRows.map((jobRow): StoredReactionJob => {
    const job: StoredReactionJob = {
      jobId: brandId(jobRow.job_id, 'ReactionJobId'),
      address,
      cycleId,
      wave: jobRow.wave,
      characterId: brandId(jobRow.character_id, 'CharacterId'),
      stimulusHash: worldHash(jobRow.stimulus_hash, 'Reaction Job stimulus_hash'),
      status: jobRow.status,
      budgetDecision: jobRow.budget_decision,
      budgetOrdinal: jobRow.budget_ordinal,
      reservedTokens: jobRow.reserved_tokens,
      claimOwnerId: jobRow.claim_owner_id,
      claimExpiresAtMs: jobRow.claim_expires_at_ms,
      claimFencingToken: jobRow.claim_fencing_token,
      attemptCount: jobRow.attempt_count,
      outcome: jobRow.outcome,
      contextReceiptId: jobRow.context_receipt_id,
      contextReceiptHash: nullableWorldHash(jobRow.context_receipt_hash, 'Reaction Job context_receipt_hash'),
      providerCallId: jobRow.provider_call_id,
      providerRequestHash: nullableWorldHash(jobRow.provider_request_hash, 'Reaction Job provider_request_hash'),
      proposalHash: nullableWorldHash(jobRow.proposal_hash, 'Reaction Job proposal_hash'),
      resultTransactionId: jobRow.result_transaction_id === null ? null : brandId(jobRow.result_transaction_id, 'TransactionId'),
      jobHash: worldHash(jobRow.job_hash, 'Reaction Job job_hash'),
      stateHash: worldHash(jobRow.state_hash, 'Reaction Job state_hash'),
    }
    const immutable = {
      jobId: job.jobId,
      address: job.address,
      cycleId: job.cycleId,
      wave: job.wave,
      characterId: job.characterId,
      stimulusHash: job.stimulusHash,
      budgetDecision: job.budgetDecision,
      budgetOrdinal: job.budgetOrdinal,
      reservedTokens: job.reservedTokens,
    }
    if (hashJob(immutable) !== job.jobHash || hashReactionJobState(job) !== job.stateHash) {
      throw new Error('Reaction Job hash is divergent')
    }
    return job
  })
  const stimulusRows = db.prepare(`SELECT * FROM world_reaction_job_stimuli WHERE address_key = ? AND job_id IN (
    SELECT job_id FROM world_reaction_jobs WHERE cycle_id = ?
  )`).all(addressKey, cycleId) as unknown as StimulusRow[]
  const jobRank = new Map(jobs.map((job, index) => [job.jobId, index] as const))
  stimulusRows.sort((left, right) => jobRank.get(left.job_id as ReactionJobId)!
    - jobRank.get(right.job_id as ReactionJobId)!
    || left.stimulus_ordinal - right.stimulus_ordinal)
  const stimuli = stimulusRows.map((stimulusRow): StoredReactionStimulus => {
    const stimulusWithoutHash = {
      jobId: brandId(stimulusRow.job_id, 'ReactionJobId'),
      address,
      stimulusOrdinal: stimulusRow.stimulus_ordinal,
      observerCharacterId: brandId(stimulusRow.observer_character_id, 'CharacterId'),
      sourceRoundId: brandId(stimulusRow.source_round_id, 'InteractionRoundId'),
      sourceTransactionId: brandId(stimulusRow.source_transaction_id, 'TransactionId'),
      sourceEventSeq: stimulusRow.source_event_seq,
      sourceEventOrdinal: stimulusRow.source_event_ordinal,
      observationOrdinal: stimulusRow.observation_ordinal,
      observationId: stimulusRow.observation_id,
      sourceEventHash: worldHash(stimulusRow.source_event_hash, 'Reaction stimulus source_event_hash'),
    }
    const stimulus = {
      ...stimulusWithoutHash,
      stimulusEntryHash: worldHash(stimulusRow.stimulus_entry_hash, 'Reaction stimulus stimulus_entry_hash'),
    }
    if (hashReactionStimulusEntry(stimulusWithoutHash) !== stimulus.stimulusEntryHash) {
      throw new Error('Reaction stimulus entry hash is divergent')
    }
    const source = db.prepare(`
      SELECT event_type, data_json, event_hash, transaction_id, event_ordinal
      FROM events WHERE address_key = ? AND seq = ?
    `).get(addressKey, stimulus.sourceEventSeq) as {
      event_type: string
      data_json: string
      event_hash: string
      transaction_id: string
      event_ordinal: number
    } | undefined
    const sourceData = source === undefined ? undefined : objectValue(
      exactJson(source.data_json, 'Reaction stimulus source Event'), 'Reaction stimulus source Event',
    )
    const sourceValue = sourceData === undefined ? undefined : objectValue(
      sourceData.value as WorldJsonValue, 'Reaction stimulus source Observation',
    )
    if (source === undefined || source.event_type !== 'observation.upsert'
      || source.event_hash !== stimulus.sourceEventHash || source.transaction_id !== stimulus.sourceTransactionId
      || source.event_ordinal !== stimulus.sourceEventOrdinal || sourceData?.id !== stimulus.observationId
      || sourceValue?.observerId !== stimulus.observerCharacterId) {
      throw new Error('Reaction stimulus source binding is divergent')
    }
    return stimulus
  })
  for (const job of jobs) {
    const owned = stimuli.filter(stimulus => stimulus.jobId === job.jobId)
    if (owned.length === 0 || owned.some((stimulus, index) => stimulus.stimulusOrdinal !== index)
      || hashStimulusBundle(job.characterId, owned) !== job.stimulusHash) {
      throw new Error('Reaction Job stimulus bundle is divergent')
    }
  }
  const initialWave = waves[0]!
  if (initialWave.budgetPlan.decisions.length !== jobs.filter(job => job.wave === 1).length) {
    throw new Error('Reaction wave budget decisions do not match Jobs')
  }
  for (const [index, decision] of initialWave.budgetPlan.decisions.entries()) {
    const job = jobs.filter(value => value.wave === 1)[index]!
    if (decision.candidate.jobId !== job.jobId
      || decision.candidate.characterId !== job.characterId || decision.candidate.stimulusHash !== job.stimulusHash
      || decision.reservationOrdinal !== job.budgetOrdinal
      || (decision.status === 'reserved' ? 'reserved' : decision.exclusion) !== job.budgetDecision
      || (decision.status === 'reserved' ? decision.candidate.estimatedTokens : 0) !== job.reservedTokens) {
      throw new Error('Reaction Job diverges from its frozen budget decision')
    }
  }
  const bundle = { cycle, waves, jobs, stimuli }
  return {
    ...bundle,
    authorityHash: hashReactionCycleAuthority(bundle),
    bundleHash: hashReactionCycleBundle(bundle),
  }
}

export function readReactionCycleById(
  db: DatabaseSync,
  address: WorldAddress,
  cycleId: ReactionCycleId,
): StoredReactionCycleBundle | undefined {
  return readReactionCycle(db, address, { cycleId })
}

export function readReactionCycleByRootTransaction(
  db: DatabaseSync,
  address: WorldAddress,
  transactionId: TransactionId,
): StoredReactionCycleBundle | undefined {
  return readReactionCycle(db, address, { rootTransactionId: transactionId })
}

export function readActiveReactionCycle(db: DatabaseSync, address: WorldAddress): StoredReactionCycleBundle | undefined {
  return readReactionCycle(db, address, {})
}

/**
 * Mark the branch's current Cycle as stop-requested inside the caller's existing write transaction.
 * The first durable stop reason wins; callers must not use this helper outside a BEGIN IMMEDIATE boundary.
 */
export function requestReactionCycleStopInTransaction(
  db: DatabaseSync,
  address: WorldAddress,
  reason: ReactionCycleStopReason,
): ReactionCycleId | undefined {
  const bundle = readActiveReactionCycle(db, address)
  if (bundle === undefined) return undefined
  if (bundle.cycle.status !== 'active') return bundle.cycle.cycleId
  const stopped: StoredReactionCycle = {
    ...bundle.cycle,
    status: 'stop_requested',
    stopReason: reason,
  }
  const stateHash = hashReactionCycleState(stopped)
  const result = db.prepare(`
    UPDATE world_reaction_cycles SET status = 'stop_requested', stop_reason = ?, state_hash = ?
    WHERE address_key = ? AND cycle_id = ? AND status = 'active' AND state_hash = ?
  `).run(reason, stateHash, worldAddressKey(address), stopped.cycleId, bundle.cycle.stateHash)
  if (result.changes !== 1) throw new Error('Reaction Cycle stop request changed concurrently')
  return stopped.cycleId
}

const STOP_REASONS = new Set<ReactionCycleTerminalReason>([
  'player_preempted', 'user_cancelled', 'administrative_stop', 'quarantined',
])
const TERMINAL_REASONS = new Set<ReactionCycleTerminalReason>([
  'quiescent', 'all_abstained', 'call_limit', 'wave_limit', 'token_budget_exhausted',
  'deadline_reached', 'provider_terminal', ...STOP_REASONS,
])

export function normalizeReactionWaveSettlement(
  draft: ReactionWaveSettlementDraft,
): ReactionWaveSettlementDraft {
  canonicalizeWorldJson(draft)
  safeInteger(draft.wave, 'reactionSettlement.wave', 1)
  if (!TERMINAL_REASONS.has(draft.terminalReason)) throw new TypeError('Reaction settlement terminal reason is invalid')
  const jobs = [...draft.jobs].sort((left, right) => compareWorldText(left.jobId, right.jobId))
  if (new Set(jobs.map(job => job.jobId)).size !== jobs.length) {
    throw new TypeError('Reaction settlement Job ids must be unique')
  }
  for (const job of jobs) {
    assertProtocolString(job.claimOwnerId, 'reactionSettlement.claimOwnerId')
    safeInteger(job.claimFencingToken, 'reactionSettlement.claimFencingToken', 1)
    worldHash(job.expectedStateHash, 'Reaction settlement expectedStateHash')
    nullableWorldHash(job.proposalHash, 'Reaction settlement proposalHash')
    const proposalRequired = job.outcome === 'proposed' || job.outcome === 'rejected'
    if (proposalRequired !== (job.proposalHash !== null)) {
      throw new TypeError('Reaction settlement proposal Hash does not match its outcome')
    }
  }
  return { ...draft, jobs }
}

interface PreparedReactionJobSettlement {
  readonly previous: ClaimedReactionJob
  readonly settled: StoredReactionJob
}

export interface PreparedReactionWaveSettlement {
  readonly draft: ReactionWaveSettlementDraft
  readonly previousCycle: StoredReactionCycle
  readonly terminalCycle: StoredReactionCycle
  readonly previousWave: StoredReactionWave
  readonly committedWave: StoredReactionWave
  readonly jobs: readonly PreparedReactionJobSettlement[]
  readonly settlementHash: WorldHash
}

function hashReactionWaveSettlement(
  cycleId: ReactionCycleId,
  wave: number,
  waveStateHash: WorldHash,
  jobStateHashes: readonly WorldHash[],
  terminalReason: ReactionCycleTerminalReason | null,
  terminalAtSeq: number | null,
): WorldHash {
  return hashWorldJson('reaction-wave-settlement/v1', {
    cycleId, wave, waveStateHash, jobStateHashes, terminalReason, terminalAtSeq,
  })
}

/** Validate and freeze the exact post-state before the owning Round commit row exists. */
export function prepareReactionWaveSettlement(
  db: DatabaseSync,
  address: WorldAddress,
  draftInput: ReactionWaveSettlementDraft,
  reactionRoundId: InteractionRoundId,
  resultTransactionId: TransactionId,
  roundAuthorityHash: WorldHash | null,
  expectedHeadSeq: number,
  expectedHeadHash: WorldHash | 'genesis',
  finalHeadSeq: number,
  nowMs: number,
): PreparedReactionWaveSettlement {
  const draft = normalizeReactionWaveSettlement(draftInput)
  if (roundAuthorityHash === null) throw new TypeError('Reaction Round settlement requires Round Authority')
  const bundle = readReactionCycleById(db, address, draft.cycleId)
  if (bundle === undefined || bundle.cycle.status === 'terminal') throw new Error('Reaction Cycle is absent or terminal')
  const previousWave = bundle.waves.find(value => value.wave === draft.wave)
  if (previousWave === undefined || previousWave.status !== 'frozen' || draft.wave !== bundle.waves.length) {
    throw new Error('Reaction settlement does not target the current frozen wave')
  }
  if (previousWave.baseHeadSeq !== expectedHeadSeq || previousWave.baseHeadHash !== expectedHeadHash) {
    throw new Error('Reaction settlement base Head is divergent')
  }
  if (bundle.cycle.status === 'stop_requested') {
    if (draft.terminalReason !== bundle.cycle.stopReason) throw new Error('Reaction settlement must preserve the durable stop reason')
  } else if (STOP_REASONS.has(draft.terminalReason)) {
    throw new Error('Reaction settlement cannot invent a stop reason')
  }
  const reserved = bundle.jobs.filter(job => job.wave === draft.wave && job.budgetDecision === 'reserved')
    .sort((left, right) => compareWorldText(left.jobId, right.jobId))
  if (reserved.length !== draft.jobs.length || reserved.some((job, index) => job.jobId !== draft.jobs[index]!.jobId)) {
    throw new Error('Reaction settlement must cover every reserved Job exactly once')
  }
  const jobs = reserved.map((job, index): PreparedReactionJobSettlement => {
    const settlement = draft.jobs[index]!
    if (job.status !== 'claimed' || job.claimOwnerId !== settlement.claimOwnerId
      || job.claimFencingToken !== settlement.claimFencingToken || job.stateHash !== settlement.expectedStateHash
      || job.claimExpiresAtMs! <= nowMs) {
      throw new Error('Reaction settlement Job claim is stale, expired, or divergent')
    }
    if (settlement.outcome !== 'runtime_unavailable' && job.providerCallId === null) {
      throw new Error('Reaction settlement outcome requires a bound ProviderCall')
    }
    const settled: StoredReactionJob = {
      ...job,
      status: 'settled',
      outcome: settlement.outcome,
      proposalHash: settlement.proposalHash,
      resultTransactionId,
    }
    return { previous: job as ClaimedReactionJob, settled: { ...settled, stateHash: hashReactionJobState(settled) } }
  })
  const committedWaveSeed: StoredReactionWave = {
    ...previousWave,
    status: 'committed',
    reactionRoundId,
    resultTransactionId,
    authorityHash: roundAuthorityHash,
  }
  const committedWave = { ...committedWaveSeed, stateHash: hashReactionWaveState(committedWaveSeed) }
  const terminalSeed: StoredReactionCycle = {
    ...bundle.cycle,
    status: 'terminal',
    terminalReason: draft.terminalReason,
    terminalAtSeq: finalHeadSeq,
  }
  const terminalCycle = { ...terminalSeed, stateHash: hashReactionCycleState(terminalSeed) }
  return {
    draft,
    previousCycle: bundle.cycle,
    terminalCycle,
    previousWave,
    committedWave,
    jobs,
    settlementHash: hashReactionWaveSettlement(
      draft.cycleId,
      draft.wave,
      committedWave.stateHash,
      jobs.map(job => job.settled.stateHash),
      draft.terminalReason,
      finalHeadSeq,
    ),
  }
}

/** Apply a prepared settlement after its Round commit row has been inserted in the same transaction. */
export function applyPreparedReactionWaveSettlement(
  db: DatabaseSync,
  address: WorldAddress,
  prepared: PreparedReactionWaveSettlement,
): void {
  const addressKey = worldAddressKey(address)
  for (const job of prepared.jobs) {
    const result = db.prepare(`
      UPDATE world_reaction_jobs
      SET status = 'settled', outcome = ?, proposal_hash = ?, result_transaction_id = ?, state_hash = ?
      WHERE address_key = ? AND job_id = ? AND status = 'claimed' AND claim_owner_id = ?
        AND claim_fencing_token = ? AND state_hash = ?
    `).run(
      job.settled.outcome,
      job.settled.proposalHash,
      job.settled.resultTransactionId,
      job.settled.stateHash,
      addressKey,
      job.settled.jobId,
      job.previous.claimOwnerId,
      job.previous.claimFencingToken,
      job.previous.stateHash,
    )
    if (result.changes !== 1) throw new Error('Reaction settlement Job changed concurrently')
  }
  const waveResult = db.prepare(`
    UPDATE world_reaction_waves
    SET status = 'committed', reaction_round_id = ?, result_transaction_id = ?, authority_hash = ?, state_hash = ?
    WHERE address_key = ? AND cycle_id = ? AND wave = ? AND status = 'frozen' AND state_hash = ?
  `).run(
    prepared.committedWave.reactionRoundId,
    prepared.committedWave.resultTransactionId,
    prepared.committedWave.authorityHash,
    prepared.committedWave.stateHash,
    addressKey,
    prepared.committedWave.cycleId,
    prepared.committedWave.wave,
    prepared.previousWave.stateHash,
  )
  if (waveResult.changes !== 1) throw new Error('Reaction settlement Wave changed concurrently')
  const cycleResult = db.prepare(`
    UPDATE world_reaction_cycles
    SET status = 'terminal', terminal_reason = ?, terminal_at_seq = ?, state_hash = ?
    WHERE address_key = ? AND cycle_id = ? AND status <> 'terminal' AND state_hash = ?
  `).run(
    prepared.terminalCycle.terminalReason,
    prepared.terminalCycle.terminalAtSeq,
    prepared.terminalCycle.stateHash,
    addressKey,
    prepared.terminalCycle.cycleId,
    prepared.previousCycle.stateHash,
  )
  if (cycleResult.changes !== 1) throw new Error('Reaction settlement Cycle changed concurrently')
}

/** Rebuild the immutable settlement link used by a committed Reaction Round bundle. */
export function readReactionWaveSettlementHashByTransaction(
  db: DatabaseSync,
  address: WorldAddress,
  transactionId: TransactionId,
  roundAuthorityHash: WorldHash | null,
  roundHeadSeq: number,
): WorldHash | undefined {
  const row = db.prepare(`
    SELECT cycle_id, wave FROM world_reaction_waves WHERE address_key = ? AND result_transaction_id = ?
  `).get(worldAddressKey(address), transactionId) as { cycle_id: string; wave: number } | undefined
  if (row === undefined) return undefined
  const bundle = readReactionCycleById(db, address, brandId(row.cycle_id, 'ReactionCycleId'))
  const wave = bundle?.waves.find(value => value.wave === row.wave)
  const jobs = bundle?.jobs.filter(job => job.wave === row.wave && job.budgetDecision === 'reserved') ?? []
  if (bundle === undefined || wave?.status !== 'committed' || wave.resultTransactionId !== transactionId
    || roundAuthorityHash === null || wave.authorityHash !== roundAuthorityHash
    || jobs.some(job => job.status !== 'settled' || job.resultTransactionId !== transactionId)) {
    throw new Error('Reaction Round settlement binding is divergent')
  }
  const isTerminalRound = bundle.cycle.terminalAtSeq === roundHeadSeq
  return hashReactionWaveSettlement(
    bundle.cycle.cycleId,
    wave.wave,
    wave.stateHash,
    jobs.map(job => job.stateHash),
    isTerminalRound ? bundle.cycle.terminalReason : null,
    isTerminalRound ? bundle.cycle.terminalAtSeq : null,
  )
}

function assertCurrentReactionWriter(
  db: DatabaseSync,
  address: WorldAddress,
  ownerId: string,
  writerFencingToken: number,
  nowMs: number,
): number {
  const lease = db.prepare(`
    SELECT owner_id, fencing_token, expires_at_ms FROM writer_leases WHERE address_key = ?
  `).get(worldAddressKey(address)) as { owner_id: string; fencing_token: number; expires_at_ms: number } | undefined
  if (lease === undefined || lease.owner_id !== ownerId || lease.fencing_token !== writerFencingToken
    || lease.expires_at_ms <= nowMs) {
    failWorld({
      errorCode: 'WRITER_LEASE_LOST',
      category: 'runtime',
      message: 'Reaction Job operation is not owned by the current branch Writer lease',
      retryable: true,
      correlationId: `reaction-job:${worldAddressKey(address)}`,
      address,
      details: { suppliedFencingToken: writerFencingToken },
    })
  }
  return lease.expires_at_ms
}

function validateClaimInput(ownerId: string, writerFencingToken: number, nowMs: number, claimTtlMs: number): number {
  assertProtocolString(ownerId, 'ownerId')
  safeInteger(writerFencingToken, 'writerFencingToken', 1)
  safeInteger(nowMs, 'nowMs', 0)
  safeInteger(claimTtlMs, 'claimTtlMs', 1)
  return safeInteger(nowMs + claimTtlMs, 'claimExpiresAtMs', 1)
}

function claimedJob(job: StoredReactionJob, ownerId: string, claimExpiresAtMs: number): ClaimedReactionJob {
  const claimFencingToken = safeInteger((job.claimFencingToken ?? 0) + 1, 'Reaction Job claim fencing token', 1)
  const attemptCount = safeInteger(job.attemptCount + 1, 'Reaction Job attempt count', 1)
  const claimed: ClaimedReactionJob = {
    ...job,
    status: 'claimed',
    budgetDecision: 'reserved',
    budgetOrdinal: job.budgetOrdinal!,
    claimOwnerId: ownerId,
    claimExpiresAtMs,
    claimFencingToken,
    attemptCount,
  }
  return { ...claimed, stateHash: hashReactionJobState(claimed) }
}

function updateClaim(db: DatabaseSync, previous: StoredReactionJob, claimed: ClaimedReactionJob): void {
  const result = db.prepare(`
    UPDATE world_reaction_jobs
    SET status = 'claimed', claim_owner_id = ?, claim_expires_at_ms = ?, claim_fencing_token = ?,
      attempt_count = ?, state_hash = ?
    WHERE address_key = ? AND job_id = ? AND state_hash = ?
  `).run(
    claimed.claimOwnerId,
    claimed.claimExpiresAtMs,
    claimed.claimFencingToken,
    claimed.attemptCount,
    claimed.stateHash,
    worldAddressKey(claimed.address),
    claimed.jobId,
    previous.stateHash,
  )
  if (result.changes !== 1) throw new Error('Reaction Job claim changed concurrently')
}

/** Claim one frozen, budget-reserved Job using the current branch Writer lease. */
export function claimNextReactionJob(
  db: DatabaseSync,
  address: WorldAddress,
  ownerId: string,
  writerFencingToken: number,
  nowMs: number,
  claimTtlMs: number,
  faultInjector?: FaultInjector,
): ClaimedReactionJob | undefined {
  const requestedExpiry = validateClaimInput(ownerId, writerFencingToken, nowMs, claimTtlMs)
  db.exec('BEGIN IMMEDIATE')
  try {
    const writerExpiresAtMs = assertCurrentReactionWriter(db, address, ownerId, writerFencingToken, nowMs)
    const bundle = readActiveReactionCycle(db, address)
    if (bundle === undefined || bundle.cycle.status !== 'active') {
      db.exec('COMMIT')
      return undefined
    }
    const job = bundle.jobs.find(candidate => candidate.status === 'pending'
      || (candidate.status === 'claimed' && candidate.claimExpiresAtMs! <= nowMs && candidate.providerCallId === null))
    if (job === undefined) {
      db.exec('COMMIT')
      return undefined
    }
    const claimed = claimedJob(job, ownerId, Math.min(requestedExpiry, writerExpiresAtMs))
    updateClaim(db, job, claimed)
    faultInjector?.hit('reaction.after-job-claim')
    db.exec('COMMIT')
    return claimed
  } catch (error: unknown) {
    rollbackAndThrow(db, error)
  }
}

/** Extend a live Job lease. The Job fence and branch Writer fence must both still match. */
export function renewReactionJobClaim(
  db: DatabaseSync,
  address: WorldAddress,
  jobId: ReactionJobId,
  ownerId: string,
  writerFencingToken: number,
  jobFencingToken: number,
  nowMs: number,
  claimTtlMs: number,
): ClaimedReactionJob {
  const requestedExpiry = validateClaimInput(ownerId, writerFencingToken, nowMs, claimTtlMs)
  safeInteger(jobFencingToken, 'jobFencingToken', 1)
  db.exec('BEGIN IMMEDIATE')
  try {
    const writerExpiresAtMs = assertCurrentReactionWriter(db, address, ownerId, writerFencingToken, nowMs)
    const bundle = readActiveReactionCycle(db, address)
    const job = bundle?.jobs.find(candidate => candidate.jobId === jobId)
    if (job?.status !== 'claimed' || job.claimOwnerId !== ownerId || job.claimFencingToken !== jobFencingToken
      || job.claimExpiresAtMs! <= nowMs) {
      throw new Error('Reaction Job claim is stale, expired, or owned by another worker')
    }
    const renewed: ClaimedReactionJob = {
      ...job,
      status: 'claimed',
      budgetDecision: 'reserved',
      budgetOrdinal: job.budgetOrdinal!,
      claimOwnerId: ownerId,
      claimExpiresAtMs: Math.max(job.claimExpiresAtMs!, Math.min(requestedExpiry, writerExpiresAtMs)),
      claimFencingToken: jobFencingToken,
    }
    const stored = { ...renewed, stateHash: hashReactionJobState(renewed) }
    const result = db.prepare(`
      UPDATE world_reaction_jobs SET claim_expires_at_ms = ?, state_hash = ?
      WHERE address_key = ? AND job_id = ? AND status = 'claimed' AND claim_owner_id = ?
        AND claim_fencing_token = ? AND claim_expires_at_ms > ? AND state_hash = ?
    `).run(
      stored.claimExpiresAtMs,
      stored.stateHash,
      worldAddressKey(address),
      jobId,
      ownerId,
      jobFencingToken,
      nowMs,
      job.stateHash,
    )
    if (result.changes !== 1) throw new Error('Reaction Job claim changed concurrently')
    db.exec('COMMIT')
    return stored
  } catch (error: unknown) {
    rollbackAndThrow(db, error)
  }
}

/** Bind one live Job claim to an exact Context Receipt and append-once ProviderCall before dispatch. */
export function bindReactionJobProvider(
  db: DatabaseSync,
  address: WorldAddress,
  jobId: ReactionJobId,
  ownerId: string,
  writerFencingToken: number,
  jobFencingToken: number,
  nowMs: number,
  binding: ReactionJobProviderBinding,
): ClaimedReactionJob {
  assertProtocolString(ownerId, 'ownerId')
  safeInteger(writerFencingToken, 'writerFencingToken', 1)
  safeInteger(jobFencingToken, 'jobFencingToken', 1)
  safeInteger(nowMs, 'nowMs', 0)
  assertProtocolString(binding.contextReceiptId, 'contextReceiptId')
  assertProtocolString(binding.providerCallId, 'providerCallId')
  worldHash(binding.contextReceiptHash, 'contextReceiptHash')
  worldHash(binding.providerRequestHash, 'providerRequestHash')
  db.exec('BEGIN IMMEDIATE')
  try {
    assertCurrentReactionWriter(db, address, ownerId, writerFencingToken, nowMs)
    const bundle = readActiveReactionCycle(db, address)
    const job = bundle?.jobs.find(candidate => candidate.jobId === jobId)
    if (job?.status !== 'claimed' || job.claimOwnerId !== ownerId || job.claimFencingToken !== jobFencingToken
      || job.claimExpiresAtMs! <= nowMs) {
      throw new Error('Reaction Job Provider binding requires a live matching claim')
    }
    if (job.providerCallId !== null) {
      if (job.contextReceiptId !== binding.contextReceiptId || job.contextReceiptHash !== binding.contextReceiptHash
        || job.providerCallId !== binding.providerCallId || job.providerRequestHash !== binding.providerRequestHash) {
        throw new Error('Reaction Job Provider binding is divergent')
      }
      db.exec('COMMIT')
      return job as ClaimedReactionJob
    }
    const bound: ClaimedReactionJob = {
      ...job,
      status: 'claimed',
      budgetDecision: 'reserved',
      budgetOrdinal: job.budgetOrdinal!,
      claimOwnerId: ownerId,
      claimExpiresAtMs: job.claimExpiresAtMs!,
      claimFencingToken: jobFencingToken,
      contextReceiptId: binding.contextReceiptId,
      contextReceiptHash: binding.contextReceiptHash,
      providerCallId: binding.providerCallId,
      providerRequestHash: binding.providerRequestHash,
    }
    const stored = { ...bound, stateHash: hashReactionJobState(bound) }
    const result = db.prepare(`
      UPDATE world_reaction_jobs
      SET context_receipt_id = ?, context_receipt_hash = ?, provider_call_id = ?, provider_request_hash = ?, state_hash = ?
      WHERE address_key = ? AND job_id = ? AND status = 'claimed' AND claim_owner_id = ?
        AND claim_fencing_token = ? AND claim_expires_at_ms > ? AND provider_call_id IS NULL AND state_hash = ?
    `).run(
      stored.contextReceiptId,
      stored.contextReceiptHash,
      stored.providerCallId,
      stored.providerRequestHash,
      stored.stateHash,
      worldAddressKey(address),
      jobId,
      ownerId,
      jobFencingToken,
      nowMs,
      job.stateHash,
    )
    if (result.changes !== 1) throw new Error('Reaction Job Provider binding changed concurrently')
    db.exec('COMMIT')
    return stored
  } catch (error: unknown) {
    rollbackAndThrow(db, error)
  }
}
