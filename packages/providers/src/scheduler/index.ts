import type { CharacterId, WorldJsonValue } from '@perspectra/sdk/contracts'
import type {
  SchedulerActivation,
  SchedulerCycle,
  SchedulerInstance,
  SchedulerResult,
  SchedulerRound,
  SchedulerTurnResult,
  SeamProvider,
} from '@perspectra/sdk'
import type { ActivationLimits } from '@perspectra/sdk'
import { runActivitySchedule } from './activity.ts'
import { runAutonomousSchedule } from './autonomy.ts'
import type { OpportunityRound } from './opportunity-round.ts'

type Activation = SchedulerActivation
type ActivationResult = SchedulerCycle
type ScheduleOptions = { readonly maximumConcurrent?: number; readonly strictCallBudget?: boolean }

/** Every scheduled part must finish normally before the common cycle may settle. */
function terminalReason(...reasons: string[]): string {
  return (
    reasons.find(reason => reason === 'failed') ??
    reasons.find(reason => reason === 'interrupted') ??
    reasons.find(reason => reason !== 'quiescent') ??
    'quiescent'
  )
}

/** The bounded scheduling players get unless a plugin replaces it. Unfinished activations need not survive. */
export const officialSchedulerProvider: SeamProvider<SchedulerInstance> = {
  id: 'official-scheduler',
  version: '2.0.0',
  open: async () => ({ run: round => runOfficialSchedule(round, { strictCallBudget: true }) }),
}

export async function runOfficialSchedule(
  input: SchedulerRound,
  options: ScheduleOptions = {},
): Promise<SchedulerResult> {
  const nominated = input.wakeups?.() ?? []
  const round: OpportunityRound = {
    ...input,
    ...(nominated.length
      ? {
          autonomy: {
            ...(input.opportunityLimits ?? {
              maximumNpcCalls: input.limits.maximumNpcCalls,
              deadlineSeconds: input.limits.reactionDeadlineSeconds ?? 30,
              reactionLimits: input.limits,
            }),
            roles: nominated.map(candidate => ({
              characterId: candidate.characterId,
              opportunities: candidate.opportunities,
            })),
            stimuli: new Map(nominated.map(candidate => [candidate.characterId, candidate.stimulusSeqs])),
          },
        }
      : {}),
  }
  if (round.phase === 'activity') return runActivitySchedule(round)
  if (round.phase === 'opportunity')
    return round.autonomy
      ? runAutonomousSchedule(round, next => runSceneSchedule(next, options))
      : { calls: 0, wave: 0, terminalReason: 'quiescent', activations: [] }
  if (round.autonomy && (!round.allowConcurrent || round.autonomy.staged)) {
    const { autonomy: _autonomy, ...scene } = round
    const stimuli = new Map(round.autonomy.stimuli)
    const ordinary = await runSceneSchedule(
      {
        ...scene,
        turn: async (id, input) => {
          // Absorbing an opportunity must also deliver its explicit authorized stimulus.
          const result = await round.turn(id, {
            ...input,
            stimulusSeqs: [
              ...new Set([...input.stimulusSeqs, ...(stimuli.get(id) ?? []).filter(seq => seq > round.afterSeq)]),
            ],
          })
          if (result.status !== 'stale') stimuli.delete(id)
          return result
        },
      },
      options,
    )
    if (round.signal.aborted) return ordinary
    const counts = new Map(round.initialCounts)
    const lastStatus = new Map<CharacterId, SchedulerTurnResult['status']>()
    for (const activation of ordinary.activations) {
      counts.set(activation.characterId, (counts.get(activation.characterId) ?? 0) + 1)
      lastStatus.set(activation.characterId, activation.result.status)
    }
    const roles = round.autonomy.roles.map(role => ({
      ...role,
      // Do not restart a stopped actor in another mode, especially after a committed stale action.
      opportunities: ['inactive', 'failed', 'interrupted', 'stale'].includes(lastStatus.get(role.characterId) ?? '')
        ? 0
        : Math.max(
            0,
            role.opportunities -
              ordinary.activations.filter(
                entry => entry.characterId === role.characterId && !['inactive', 'stale'].includes(entry.result.status),
              ).length,
          ),
    }))
    const autonomous = await runAutonomousSchedule(
      { ...round, autonomy: { ...round.autonomy, roles }, phase: 'opportunity', initialCounts: counts },
      next => runSceneSchedule(next, options),
    )
    return {
      ...ordinary,
      terminalReason: terminalReason(ordinary.terminalReason, autonomous.terminalReason),
      ...(autonomous.autonomy === undefined ? {} : { autonomy: autonomous.autonomy }),
    }
  }
  return runSceneSchedule(round, options)
}

async function runSceneSchedule(round: OpportunityRound, options: ScheduleOptions): Promise<SchedulerResult> {
  if (round.allowConcurrent) return runDynamicActivations(round, options)
  const limits = round.limits
  const signal = AbortSignal.any([round.signal, AbortSignal.timeout((limits.reactionDeadlineSeconds ?? 30) * 1_000)])
  const activations: Activation[] = []
  const counts = new Map<CharacterId, number>(round.initialCounts)
  const inactive = new Set<CharacterId>()
  let calls = 0,
    wave = 0,
    hitCharacterLimit = false
  const candidates = (afterSeq: number, rootStimulus = false) => {
    const result = new Map<CharacterId, number[]>()
    for (const observation of round.observationsSince(afterSeq, round.headSeq())) {
      const id = observation.characterId
      if (!round.characterIds.includes(id) || inactive.has(id)) continue
      if (!rootStimulus && !observation.substantive) continue
      const entries = result.get(id) ?? []
      entries.push(observation.seq)
      result.set(id, entries)
    }
    return result
  }
  let pending = candidates(round.afterSeq, true)
  for (wave = 1; wave <= limits.maximumWaves && pending.size > 0; wave++) {
    const before = round.headSeq()
    // Shuffle eligible roles, not observations or scripted Activity turns. Nearby roles get
    // the first opportunities; departure observers still receive their bounded reactions.
    const present = new Set(round.presentCharacterIds())
    const eligible = round.characterIds.filter(
      id => pending.has(id) && (counts.get(id) ?? 0) < limits.maximumCallsPerCharacter,
    )
    const shuffle = (ids: CharacterId[]) => {
      for (let index = ids.length - 1; index > 0; index--) {
        const other = Math.floor(Math.random() * (index + 1))
        ;[ids[index], ids[other]] = [ids[other]!, ids[index]!]
      }
      return ids
    }
    const order = [
      ...shuffle(eligible.filter(id => present.has(id))),
      ...shuffle(eligible.filter(id => !present.has(id))),
    ]
    for (const characterId of order) {
      if (signal.aborted) return { calls, wave, terminalReason: 'interrupted', activations }
      // Reserve the result-aware reply slot; a second operation is offered only with a third slot reserved.
      if (calls >= limits.maximumNpcCalls) return { calls, wave, terminalReason: 'call_limit', activations }
      const result = await round.turn(characterId, {
        signal,
        stimulusSeqs: pending.get(characterId)!,
        ...(options.strictCallBudget || calls + 1 === limits.maximumNpcCalls
          ? { maxModelCalls: limits.maximumNpcCalls - calls }
          : {}),
        maxCalls: calls + 3 <= limits.maximumNpcCalls ? 3 : calls + 2 <= limits.maximumNpcCalls ? 2 : 1,
      })
      calls += result.calls
      activations.push({ characterId, result })
      if (result.status === 'inactive') {
        inactive.add(characterId)
        continue
      }
      counts.set(characterId, (counts.get(characterId) ?? 0) + 1)
      if (result.status === 'failed' || result.status === 'interrupted') {
        return { calls, wave, terminalReason: result.status, activations }
      }
      if (result.status === 'stale') return { calls, wave, terminalReason: 'interrupted', activations }
    }
    pending = candidates(before)
    for (const id of pending.keys())
      if ((counts.get(id) ?? 0) >= limits.maximumCallsPerCharacter) {
        pending.delete(id)
        hitCharacterLimit = true
      }
  }
  return {
    calls,
    wave: Math.min(wave - 1, limits.maximumWaves),
    terminalReason: pending.size ? 'wave_limit' : hitCharacterLimit ? 'character_limit' : 'quiescent',
    activations,
  }
}

/** Readiness follows committed observations rather than a barrier between whole waves. */
async function runDynamicActivations(round: OpportunityRound, options: ScheduleOptions): Promise<SchedulerResult> {
  const limits = round.limits
  const controller = new AbortController()
  const signal = AbortSignal.any([round.signal, controller.signal])
  const ordinarySignal = AbortSignal.any([signal, AbortSignal.timeout((limits.reactionDeadlineSeconds ?? 30) * 1000)])
  const autonomySignal = round.autonomy
    ? AbortSignal.any([signal, AbortSignal.timeout(round.autonomy.deadlineSeconds * 1000)])
    : ordinarySignal
  const concurrency = options.maximumConcurrent ?? 2
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 2)
    throw new RangeError('activation concurrency must be 1 or 2')
  type Kind = 'ordinary' | 'autonomous' | 'autonomyReaction'
  type Continuation = {
    actionId: string
    afterSeq?: number
    action: { actionType: string; parameters: WorldJsonValue }
  }
  type Pending = {
    observations: { seq: number; kind: Kind; depth: number }[]
    depths: Partial<Record<Kind, number>>
    continuationOf?: Continuation
    continuationKind?: Kind
  }
  type Job = {
    observations: Pending['observations']
    kind: Kind
    depth: number
    continuationOf?: Continuation
    absorbsAutonomy: boolean
  }
  type Completed = { id: CharacterId; result: SchedulerTurnResult } | { id: CharacterId; error: unknown }
  const phase = (phaseLimits: ActivationLimits, phaseSignal: AbortSignal) => ({
    limits: phaseLimits,
    signal: phaseSignal,
    calls: 0,
    reserved: 0,
    wave: 0,
    activations: [] as Activation[],
    characterLimit: false,
    waveLimit: false,
    failed: false,
    interrupted: false,
  })
  // These replace the three sequential stages; concurrency and scene exclusion remain shared.
  const phases = {
    ordinary: phase(limits, ordinarySignal),
    autonomous: phase({ ...limits, maximumNpcCalls: round.autonomy?.maximumNpcCalls ?? 0 }, autonomySignal),
    autonomyReaction: phase(
      round.autonomy?.reactionLimits ?? { ...limits, maximumWaves: 0, maximumNpcCalls: 0 },
      autonomySignal,
    ),
  }
  const opportunities = new Map(round.autonomy?.roles.map(role => [role.characterId, role.opportunities]) ?? [])
  const pending = new Map<CharacterId, Pending>(),
    consumed = new Map<CharacterId, number>()
  const counts = new Map<CharacterId, number>(round.initialCounts),
    stopped = new Set<CharacterId>()
  const consecutiveStale = new Map<CharacterId, number>()
  const running = new Map<CharacterId, { promise: Promise<Completed>; job: Job; reserve: number }>()
  const completed: Completed[] = []
  let cursor = round.afterSeq
  let notify!: () => void, changed: Promise<void>
  const reset = () => {
    changed = new Promise<void>(done => {
      notify = done
    })
  }
  reset()
  const wake = () => notify()
  for (const source of new Set([signal, ordinarySignal, autonomySignal]))
    source.addEventListener('abort', wake, { once: true })
  const seedAutonomous = (id: CharacterId) => {
    if ((opportunities.get(id) ?? 0) <= 0 || stopped.has(id) || autonomySignal.aborted) return
    const existing = pending.get(id)
    const explicit = round.autonomy?.stimuli.get(id) ?? []
    pending.set(id, {
      ...existing,
      observations: [
        ...(existing?.observations ?? []),
        ...explicit
          .filter(
            seq =>
              !(existing?.observations ?? []).some(entry => entry.seq === seq && entry.kind === 'autonomous') &&
              seq > (consumed.get(id) ?? round.afterSeq),
          )
          .map(seq => ({ seq, kind: 'autonomous' as const, depth: 0 })),
      ],
      depths: { ...existing?.depths, autonomous: 0 },
    })
  }
  const collect = (source: 'ordinary' | 'autonomyReaction', depth: number, root = false) => {
    const head = round.headSeq()
    for (const observation of round.observationsSince(cursor, head)) {
      const id = observation.characterId
      const kind = source,
        current = phases[kind]
      if (
        (!opportunities.has(id) && !round.characterIds.includes(id)) ||
        stopped.has(id) ||
        current.signal.aborted ||
        (source === 'autonomyReaction' && current.limits.maximumWaves === 0) ||
        observation.seq <= (consumed.get(id) ?? round.afterSeq)
      )
        continue
      if (!root && !observation.substantive) continue
      if (depth > current.limits.maximumWaves) {
        current.waveLimit = true
        continue
      }
      if ((counts.get(id) ?? 0) >= current.limits.maximumCallsPerCharacter && !running.has(id)) {
        current.characterLimit = true
        continue
      }
      const existing = pending.get(id)
      const nextDepth = depth
      pending.set(id, {
        ...existing,
        observations: [...(existing?.observations ?? []), { seq: observation.seq, kind, depth: nextDepth }],
        depths: { ...existing?.depths, [kind]: Math.max(existing?.depths[kind] ?? nextDepth, nextDepth) },
      })
    }
    cursor = head
    wake()
  }
  // Keep source sequences in the ephemeral queue, never add scheduling metadata to model stimuli.
  const discardConsumed = (id: CharacterId, through: number) => {
    consumed.set(id, Math.max(consumed.get(id) ?? round.afterSeq, through))
    const job = pending.get(id)
    if (!job) return
    job.observations = job.observations.filter(entry => entry.seq > through)
    const depths: Pending['depths'] = {}
    for (const entry of job.observations) depths[entry.kind] = Math.max(depths[entry.kind] ?? entry.depth, entry.depth)
    if (job.depths.autonomous !== undefined) depths.autonomous = 0
    if (job.continuationKind)
      depths[job.continuationKind] = Math.max(depths[job.continuationKind] ?? 0, job.depths[job.continuationKind]!)
    job.depths = depths
    if (!job.observations.length && !job.continuationOf && job.depths.autonomous === undefined) pending.delete(id)
  }
  const jobFor = (entry: Pending): Job => {
    // A ready player reaction can absorb autonomous observations without a duplicate activation.
    // Its own causal depth remains intact; completed-action continuations retain their original budget.
    const kind =
      entry.continuationKind ??
      (entry.depths.ordinary !== undefined
        ? 'ordinary'
        : entry.depths.autonomyReaction !== undefined
          ? 'autonomyReaction'
          : 'autonomous')
    return {
      observations: entry.observations,
      kind,
      depth: entry.depths[kind]!,
      absorbsAutonomy: entry.depths.autonomous !== undefined,
      ...(entry.continuationOf ? { continuationOf: entry.continuationOf } : {}),
    }
  }
  const account = (completion: Completed) => {
    const task = running.get(completion.id)!
    running.delete(completion.id)
    const current = phases[task.job.kind]
    current.reserved -= task.reserve
    if ('error' in completion) throw completion.error
    const result = completion.result
    current.calls += result.calls
    current.activations.push({ characterId: completion.id, result })
    return { task, current, result }
  }
  const outcome = (kind: Kind): ActivationResult => {
    const current = phases[kind]
    const hasPending = [...pending.values()].some(entry => entry.depths[kind] !== undefined)
    return {
      calls: current.calls,
      wave: current.wave,
      activations: current.activations,
      terminalReason: current.interrupted
        ? 'interrupted'
        : current.failed
          ? 'failed'
          : hasPending
            ? 'call_limit'
            : current.characterLimit
              ? 'character_limit'
              : current.waveLimit
                ? 'wave_limit'
                : 'quiescent',
    }
  }
  try {
    collect('ordinary', 1, true)
    for (const id of opportunities.keys()) seedAutonomous(id)
    while (pending.size || running.size) {
      reset()
      for (const completion of completed.splice(0)) {
        const { task, current, result } = account(completion)
        if (result.status === 'stale') {
          const retries = consecutiveStale.get(completion.id) ?? 0
          // One stale replan is allowed per character until it completes an activation.
          // A committed perform is represented by continuationOf, so dropping a repeatedly
          // stale continuation never repeats or rolls back that already committed action.
          if (retries >= 1) {
            pending.delete(completion.id)
            stopped.add(completion.id)
            current.characterLimit = true
            continue
          }
          consecutiveStale.set(completion.id, retries + 1)
          const next = pending.get(completion.id)
          const performed = result.performResult
          const continuation = performed
            ? {
                actionId: String(performed.operationId),
                action: performed.action as { actionType: string; parameters: WorldJsonValue },
              }
            : task.job.continuationOf
          pending.set(completion.id, {
            observations: [...(performed ? [] : task.job.observations), ...(next?.observations ?? [])],
            depths: {
              ...next?.depths,
              ...(task.job.absorbsAutonomy ? { autonomous: 0 } : {}),
              [task.job.kind]: Math.max(task.job.depth, next?.depths[task.job.kind] ?? task.job.depth),
            },
            continuationKind: task.job.kind,
            ...(continuation ? { continuationOf: continuation } : {}),
          })
          continue
        }
        if (result.status === 'inactive') {
          if (result.asOfWorldSeq !== undefined) discardConsumed(completion.id, result.asOfWorldSeq)
          stopped.add(completion.id)
          pending.delete(completion.id)
          consecutiveStale.delete(completion.id)
          continue
        }
        counts.set(completion.id, (counts.get(completion.id) ?? 0) + 1)
        if (task.job.absorbsAutonomy)
          opportunities.set(completion.id, Math.max(0, (opportunities.get(completion.id) ?? 0) - 1))
        consecutiveStale.delete(completion.id)
        if (result.asOfWorldSeq !== undefined) discardConsumed(completion.id, result.asOfWorldSeq)
        if (result.status === 'failed' || result.status === 'interrupted') {
          stopped.add(completion.id)
          pending.delete(completion.id)
          current.failed ||= result.status === 'failed'
          current.interrupted ||= result.status === 'interrupted'
        }
        // Finishing an autonomous opportunity never erases a newer, unread observation.
        if (task.job.absorbsAutonomy && (opportunities.get(completion.id) ?? 0) > 0) seedAutonomous(completion.id)
      }
      if (signal.aborted) break
      // Each former stage keeps its deadline; timing out one stage does not cancel unrelated work.
      for (const [id, entry] of pending)
        for (const kind of Object.keys(entry.depths) as Kind[]) {
          if (!phases[kind].signal.aborted) continue
          phases[kind].interrupted = true
          delete entry.depths[kind]
          entry.observations = entry.observations.filter(observation => observation.kind !== kind)
          if (entry.continuationKind === kind || !Object.keys(entry.depths).length) pending.delete(id)
        }
      let started = false
      const present = new Set(round.presentCharacterIds())
      const eligible = [...pending.keys()].filter(id => !running.has(id) && !stopped.has(id))
      // Randomize within the current priority group at each dispatch, never the stimulus history.
      const order = eligible
        .map(id => ({ id, rank: Math.random() }))
        .sort(
          (a, b) =>
            Number(present.has(b.id)) - Number(present.has(a.id)) ||
            (consecutiveStale.get(a.id) ?? 0) - (consecutiveStale.get(b.id) ?? 0) ||
            (counts.get(a.id) ?? 0) - (counts.get(b.id) ?? 0) ||
            a.rank - b.rank,
        )
      for (const { id } of order) {
        if (running.size >= concurrency) break
        const entry = pending.get(id)!
        let job = jobFor(entry)
        let current = phases[job.kind]
        if (
          !entry.continuationKind &&
          job.kind !== 'autonomous' &&
          entry.depths.autonomous !== undefined &&
          (current.limits.maximumNpcCalls - current.calls - current.reserved <= 0 ||
            (counts.get(id) ?? 0) >= current.limits.maximumCallsPerCharacter)
        ) {
          job = { ...job, kind: 'autonomous', depth: 0 }
          current = phases.autonomous
        }
        if (job.kind !== 'autonomous' && (counts.get(id) ?? 0) >= current.limits.maximumCallsPerCharacter) {
          pending.delete(id)
          current.characterLimit = true
          continue
        }
        const location = round.locationOf(id)
        if (
          (location === null && running.size > 0) ||
          [...running.keys()].some(other => round.locationOf(other) === null || round.locationOf(other) === location)
        )
          continue
        // At most one off-scene request; leave a slot for newly ready foreground reactions.
        if (!present.has(id) && [...running.keys()].some(other => !present.has(other))) continue
        // Off-scene work leaves optional third calls for foreground decisions and their successors.
        const competing =
          !present.has(id) &&
          ([...pending].some(([other, entry]) => present.has(other) && jobFor(entry).kind === job.kind) ||
            [...running].some(([other, task]) => present.has(other) && task.job.kind === job.kind))
        const reserve = Math.min(
          job.continuationOf ? 1 : competing ? 2 : 3,
          current.limits.maximumNpcCalls - current.calls - current.reserved,
        )
        if (reserve < (job.kind === 'autonomous' && !job.continuationOf ? 2 : 1)) continue
        pending.delete(id)
        current.reserved += reserve
        current.wave = Math.max(current.wave, job.depth)
        const promise = round
          .turn(id, {
            signal: current.signal,
            // One sequence may have several live scheduling sources, but is delivered only once.
            stimulusSeqs: [...new Set(job.observations.map(entry => entry.seq))],
            maxCalls: reserve === 1 ? 1 : job.kind === 'autonomous' ? 2 : reserve === 3 ? 3 : 2,
            maxModelCalls: reserve,
            ...(job.continuationOf ? { continuationOf: job.continuationOf } : {}),
            onCommitted: through => {
              discardConsumed(id, through)
              collect(
                job.kind === 'ordinary' ? 'ordinary' : 'autonomyReaction',
                job.kind === 'autonomous' ? 1 : job.depth + 1,
              )
            },
          })
          .then(
            result => ({ id, result }),
            error => ({ id, error }),
          )
          .then(result => {
            completed.push(result)
            wake()
            return result
          })
        running.set(id, { promise, job, reserve })
        started = true
      }
      if (!running.size) break
      if (!started && completed.length) continue
      await changed!
    }
    if (signal.aborted) {
      phases.ordinary.interrupted = true
      if (round.autonomy) phases.autonomous.interrupted = true
    }
    await Promise.all([...running.values()].map(task => task.promise))
    for (const completion of completed.splice(0)) {
      const { current, result } = account(completion)
      current.interrupted ||= result.status === 'interrupted'
      current.failed ||= result.status === 'failed'
    }
    running.clear()
    const ordinary = outcome('ordinary'),
      autonomous = outcome('autonomous'),
      reactions = outcome('autonomyReaction')
    return {
      ...ordinary,
      terminalReason: terminalReason(ordinary.terminalReason, autonomous.terminalReason, reactions.terminalReason),
      ...(round.autonomy
        ? {
            autonomy: {
              activations: autonomous.activations,
              autonomousCalls: autonomous.calls,
              reactionCalls: reactions.calls,
              reactions,
              terminalReason: terminalReason(autonomous.terminalReason, reactions.terminalReason),
            },
          }
        : {}),
    }
  } finally {
    controller.abort()
    // Closing the store or settling a player round must wait for every cancellation to be observed.
    await Promise.all([...running.values()].map(task => task.promise))
    for (const source of new Set([signal, ordinarySignal, autonomySignal])) source.removeEventListener('abort', wake)
  }
}

export { AutonomyPolicy, officialAutonomyProvider, autonomyInstruction } from './autonomy-policy.ts'
