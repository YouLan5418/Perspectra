import { publicationSegments } from '@harness-world/contracts'
import { brandId, type CharacterId, type WorldAddress, type WorldJsonObject, type WorldJsonValue } from '@harness-world/contracts'
import type { WorldStore } from '@harness-world/store-sqlite'
import type { PrototypeCharacterTurn, PrototypeTurnResult } from './prototype-character-turn.ts'

type Activation = { characterId: CharacterId; result: PrototypeTurnResult }
interface ActivationResult {
  calls: number; wave: number; terminalReason: string; activations: Activation[];
}
interface ActivationLimits {
  readonly maximumWaves: number; readonly maximumNpcCalls: number;
  readonly maximumCallsPerCharacter: number; readonly reactionDeadlineSeconds?: number;
}
interface PrototypeActivationResult extends ActivationResult {
  autonomy?: {
    activations: Activation[]; autonomousCalls: number; reactionCalls: number;
    reactions: ActivationResult; terminalReason: string;
  };
}
/** Ephemeral, bounded scheduling; committed observations survive, unfinished activations need not. */
export interface PrototypeActivationInput {
  store: WorldStore; address: WorldAddress; turn: PrototypeCharacterTurn; afterSeq: number;
  characterIds: readonly CharacterId[]; signal: AbortSignal;
  presentCharacterIds?: () => readonly CharacterId[];
  /** Optional decisions already handled elsewhere in the same player turn. */
  initialCounts?: ReadonlyMap<CharacterId, number>;
  strictCallBudget?: boolean;
  /** Providing scene locations enables bounded dynamic dispatch across separate locations. */
  locationId?: (characterId: CharacterId) => string | null;
  maximumConcurrent?: number;
  limits?: ActivationLimits;
  /** Explicit autonomous opportunities share the dispatcher, never expand observation permission. */
  autonomy?: {
    turn: PrototypeCharacterTurn;
    roles: readonly {characterId: CharacterId; opportunities: number}[];
    maximumNpcCalls: number; deadlineSeconds: number;
    reactionLimits: ActivationLimits;
  };
}
export async function runPrototypeActivations(input: PrototypeActivationInput): Promise<PrototypeActivationResult> {
  if (input.locationId) return runDynamicActivations(input)
  const limits = input.limits ?? { maximumWaves: 3, maximumNpcCalls: 8, maximumCallsPerCharacter: 2 }
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout((limits.reactionDeadlineSeconds ?? 30) * 1_000)])
  const activations: { characterId: CharacterId; result: PrototypeTurnResult }[] = []
  const counts = new Map<CharacterId, number>(input.initialCounts)
  const inactive = new Set<CharacterId>()
  let calls = 0, wave = 0, hitCharacterLimit = false
  const candidates = (afterSeq: number, rootStimulus = false) => {
    const result = new Map<CharacterId, WorldJsonObject[]>()
    for (const event of input.store.readEvents(input.address)) {
      if (event.seq <= afterSeq || event.eventType !== 'observation.upsert') continue
      const value = (event.data as WorldJsonObject).value as WorldJsonObject
      const content = value.content as WorldJsonObject | undefined
      if (content === undefined || content.status !== 'accepted' || content.actorId === value.observerId) continue
      const id = brandId(String(value.observerId), 'CharacterId')
      if (!input.characterIds.includes(id) || inactive.has(id)) continue
      const speech = content.speech as WorldJsonObject | undefined
      if (!rootStimulus && speech !== undefined && !publicationSegments(speech).some(segment => segment.type === 'speech' && segment.text.trim())
        && !(speech.addresseeIds as string[] | undefined)?.includes(id)) continue
      const entries = result.get(id) ?? []
      entries.push(value); result.set(id, entries)
    }
    return result
  }
  let pending = candidates(input.afterSeq, true)
  for (wave = 1; wave <= limits.maximumWaves && pending.size > 0; wave++) {
    const before = input.store.head(input.address).headSeq
    // Shuffle eligible roles, not observations or scripted Activity turns. Nearby roles get
    // the first opportunities; departure observers still receive their bounded reactions.
    const present = new Set(input.presentCharacterIds?.() ?? input.characterIds)
    const eligible = input.characterIds.filter(id => pending.has(id)
      && (counts.get(id) ?? 0) < limits.maximumCallsPerCharacter)
    const shuffle = (ids: CharacterId[]) => {
      for (let index = ids.length - 1; index > 0; index--) {
        const other = Math.floor(Math.random() * (index + 1))
        ;[ids[index], ids[other]] = [ids[other]!, ids[index]!]
      }
      return ids
    }
    const order = [...shuffle(eligible.filter(id => present.has(id))),
      ...shuffle(eligible.filter(id => !present.has(id)))]
    for (const characterId of order) {
      if (signal.aborted) return { calls, wave, terminalReason: 'interrupted', activations }
      // Reserve the result-aware reply slot; a second operation is offered only with a third slot reserved.
      if (calls + 2 > limits.maximumNpcCalls) return { calls, wave, terminalReason: 'call_limit', activations }
      const result = await input.turn.run(characterId, { signal, stimulus: pending.get(characterId)!,
        ...(input.strictCallBudget ? {maxModelCalls: limits.maximumNpcCalls - calls} : {}),
        maxCalls: calls + 3 <= limits.maximumNpcCalls ? 3 : 2 })
      calls += result.calls
      activations.push({ characterId, result })
      if (result.status === 'inactive') { inactive.add(characterId); continue }
      counts.set(characterId, (counts.get(characterId) ?? 0) + 1)
      if (result.status === 'failed' || result.status === 'interrupted') {
        return { calls, wave, terminalReason: result.status, activations }
      }
      if (result.status === 'stale') return {calls, wave, terminalReason:'interrupted', activations}
    }
    pending = candidates(before)
    for (const id of pending.keys()) if ((counts.get(id) ?? 0) >= limits.maximumCallsPerCharacter) {
      pending.delete(id); hitCharacterLimit = true
    }
  }
  return { calls, wave: Math.min(wave - 1, limits.maximumWaves), terminalReason: pending.size ? 'wave_limit' : hitCharacterLimit ? 'character_limit' : 'quiescent', activations }
}

/** Readiness follows committed observations rather than a barrier between whole waves. */
async function runDynamicActivations(input: PrototypeActivationInput): Promise<PrototypeActivationResult> {
  const limits = input.limits ?? {maximumWaves:3,maximumNpcCalls:8,maximumCallsPerCharacter:2}
  const controller = new AbortController()
  const signal = AbortSignal.any([input.signal, controller.signal])
  const ordinarySignal = AbortSignal.any([signal, AbortSignal.timeout((limits.reactionDeadlineSeconds??30)*1000)])
  const autonomySignal = input.autonomy
    ? AbortSignal.any([signal, AbortSignal.timeout(input.autonomy.deadlineSeconds*1000)]) : ordinarySignal
  const concurrency = input.maximumConcurrent ?? 2
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 2) throw new RangeError('prototype concurrency must be 1 or 2')
  type Kind = 'ordinary' | 'autonomous' | 'autonomyReaction'
  type Continuation = NonNullable<NonNullable<Parameters<PrototypeCharacterTurn['run']>[1]>['continuationOf']>
  type Pending = {observations:{seq:number;value:WorldJsonObject;kind:Kind;depth:number}[];depths:Partial<Record<Kind,number>>;
    continuationOf?:Continuation; continuationKind?:Kind}
  type Job = {observations:Pending['observations'];kind:Kind;depth:number;continuationOf?:Continuation}
  type Completed = {id:CharacterId; result:PrototypeTurnResult} | {id:CharacterId; error:unknown}
  const phase = (phaseLimits:ActivationLimits, phaseSignal:AbortSignal) => ({limits:phaseLimits,signal:phaseSignal,
    calls:0,reserved:0,wave:0,activations:[] as Activation[],characterLimit:false,waveLimit:false,failed:false,interrupted:false})
  // These replace the three sequential stages; concurrency and scene exclusion remain shared.
  const phases = {
    ordinary:phase(limits,ordinarySignal),
    autonomous:phase({...limits,maximumNpcCalls:input.autonomy?.maximumNpcCalls??0},autonomySignal),
    autonomyReaction:phase(input.autonomy?.reactionLimits??{...limits,maximumWaves:0,maximumNpcCalls:0},autonomySignal),
  }
  const opportunities = new Map(input.autonomy?.roles.map(role=>[role.characterId,role.opportunities])??[])
  const pending = new Map<CharacterId, Pending>(), consumed = new Map<CharacterId,number>()
  const counts = new Map<CharacterId,number>(input.initialCounts), stopped = new Set<CharacterId>()
  const consecutiveStale = new Map<CharacterId,number>()
  const running = new Map<CharacterId,{promise:Promise<Completed>; job:Job; reserve:number}>()
  const completed:Completed[] = []
  let cursor = input.afterSeq
  let notify!:()=>void, changed:Promise<void>
  const reset = () => { changed = new Promise<void>(done => {notify=done}) }
  reset()
  const wake = () => notify()
  for (const source of new Set([signal,ordinarySignal,autonomySignal])) source.addEventListener('abort',wake,{once:true})
  const seedAutonomous = (id:CharacterId) => {
    if ((opportunities.get(id)??0)<=0 || stopped.has(id) || autonomySignal.aborted) return
    const existing=pending.get(id)
    pending.set(id,{...existing,observations:existing?.observations??[],depths:{autonomous:0}})
  }
  const collect = (source: 'ordinary'|'autonomyReaction', depth:number, root=false) => {
    const head = input.store.head(input.address).headSeq
    for (const event of input.store.readEvents(input.address)) {
      if (event.seq <= cursor || event.seq > head || event.eventType !== 'observation.upsert') continue
      const value = (event.data as WorldJsonObject).value as WorldJsonObject
      const content = value.content as WorldJsonObject | undefined
      if (!content || content.status !== 'accepted' || content.actorId === value.observerId) continue
      const id = brandId(String(value.observerId),'CharacterId')
      const autonomous=opportunities.has(id), kind=autonomous?'autonomous':source, current=phases[kind]
      if ((!autonomous && !input.characterIds.includes(id)) || stopped.has(id) || current.signal.aborted
        || (!autonomous && source==='autonomyReaction' && current.limits.maximumWaves===0)
        || (autonomous && (opportunities.get(id)??0)<=0) || event.seq <= (consumed.get(id)??input.afterSeq)) continue
      const speech = content.speech as WorldJsonObject | undefined
      if (!root && speech && !publicationSegments(speech).some(s => s.type==='speech' && s.text.trim())
        && !(speech.addresseeIds as string[]|undefined)?.includes(id)) continue
      if (!autonomous && depth > current.limits.maximumWaves) {current.waveLimit=true;continue}
      if (!autonomous && (counts.get(id)??0) >= current.limits.maximumCallsPerCharacter && !running.has(id)) {current.characterLimit=true;continue}
      const existing = pending.get(id)
      const nextDepth=autonomous?0:depth
      pending.set(id,{...existing,observations:[...(existing?.observations??[]),{seq:event.seq,value,kind,depth:nextDepth}],
        depths:{...existing?.depths,[kind]:Math.max(existing?.depths[kind]??nextDepth,nextDepth)}})
    }
    cursor = head
    wake()
  }
  // Keep source sequences in the ephemeral queue, never add scheduling metadata to model stimuli.
  const discardConsumed = (id:CharacterId, through:number) => {
    consumed.set(id,Math.max(consumed.get(id)??input.afterSeq,through))
    const job=pending.get(id)
    if (!job) return
    job.observations=job.observations.filter(entry=>entry.seq>through)
    const depths:Pending['depths']={}
    for (const entry of job.observations) depths[entry.kind]=Math.max(depths[entry.kind]??entry.depth,entry.depth)
    if (job.depths.autonomous!==undefined) depths.autonomous=0
    if (job.continuationKind) depths[job.continuationKind]=Math.max(depths[job.continuationKind]??0,job.depths[job.continuationKind]!)
    job.depths=depths
    if (!job.observations.length && !job.continuationOf && job.depths.autonomous===undefined) pending.delete(id)
  }
  const jobFor = (entry:Pending):Job => {
    // A ready player reaction can absorb autonomous observations without a duplicate activation.
    // Its own causal depth remains intact; completed-action continuations retain their original budget.
    const kind=entry.continuationKind??(entry.depths.ordinary!==undefined?'ordinary':entry.depths.autonomous!==undefined?'autonomous':'autonomyReaction')
    return {observations:entry.observations,kind,depth:entry.depths[kind]!,...(entry.continuationOf?{continuationOf:entry.continuationOf}:{})}
  }
  const account = (completion:Completed) => {
    const task=running.get(completion.id)!
    running.delete(completion.id)
    const current=phases[task.job.kind]
    current.reserved-=task.reserve
    if ('error' in completion) throw completion.error
    const result=completion.result
    current.calls+=result.calls;current.activations.push({characterId:completion.id,result})
    return {task,current,result}
  }
  const outcome = (kind:Kind):ActivationResult => {
    const current=phases[kind]
    const hasPending=[...pending.values()].some(entry=>entry.depths[kind]!==undefined)
    return {calls:current.calls,wave:current.wave,activations:current.activations,
      terminalReason:current.interrupted?'interrupted':current.failed?'failed':hasPending?'call_limit'
        :current.characterLimit?'character_limit':current.waveLimit?'wave_limit':'quiescent'}
  }
  try {
    collect('ordinary',1,true)
    for (const id of opportunities.keys()) seedAutonomous(id)
    while (pending.size || running.size) {
      reset()
      for (const completion of completed.splice(0)) {
        const {task,current,result}=account(completion)
        if (result.status==='stale') {
          const retries=consecutiveStale.get(completion.id)??0
          // One stale replan is allowed per character until it completes an activation.
          // A committed perform is represented by continuationOf, so dropping a repeatedly
          // stale continuation never repeats or rolls back that already committed action.
          if (retries>=1) {
            pending.delete(completion.id);stopped.add(completion.id);current.characterLimit=true
            continue
          }
          consecutiveStale.set(completion.id,retries+1)
          const next=pending.get(completion.id)
          const performed=result.performResult
          const continuation=performed?{actionId:String(performed.operationId),action:performed.action as {actionType:string;parameters:WorldJsonValue}}:task.job.continuationOf
          pending.set(completion.id,{observations:[...(performed?[]:task.job.observations),...(next?.observations??[])],
            depths:{...next?.depths,[task.job.kind]:Math.max(task.job.depth,next?.depths[task.job.kind]??task.job.depth)},
            ...(continuation?{continuationOf:continuation,continuationKind:task.job.kind}:{})})
          continue
        }
        if (result.status==='inactive') {
          if (result.asOfWorldSeq!==undefined) discardConsumed(completion.id,result.asOfWorldSeq)
          stopped.add(completion.id);pending.delete(completion.id);consecutiveStale.delete(completion.id)
          continue
        }
        counts.set(completion.id,(counts.get(completion.id)??0)+1)
        if (task.job.kind==='autonomous') opportunities.set(completion.id,opportunities.get(completion.id)!-1)
        consecutiveStale.delete(completion.id)
        if (result.asOfWorldSeq!==undefined) discardConsumed(completion.id,result.asOfWorldSeq)
        if (result.status==='failed' || result.status==='interrupted') {
          stopped.add(completion.id);pending.delete(completion.id)
          current.failed ||= result.status==='failed';current.interrupted ||= result.status==='interrupted'
        }
        if (task.job.kind==='autonomous') {
          if ((opportunities.get(completion.id)??0)>0) seedAutonomous(completion.id)
          else pending.delete(completion.id)
        } else if ((counts.get(completion.id)??0)>=limits.maximumCallsPerCharacter && pending.has(completion.id)) {
          for (const kind of Object.keys(pending.get(completion.id)!.depths) as Kind[]) phases[kind].characterLimit=true
          pending.delete(completion.id)
        }
      }
      if (signal.aborted) break
      // Each former stage keeps its deadline; timing out one stage does not cancel unrelated work.
      for (const [id,entry] of pending) for (const kind of Object.keys(entry.depths) as Kind[]) {
        if (!phases[kind].signal.aborted) continue
        phases[kind].interrupted=true
        delete entry.depths[kind]
        entry.observations=entry.observations.filter(observation=>observation.kind!==kind)
        if (entry.continuationKind===kind || !Object.keys(entry.depths).length) pending.delete(id)
      }
      let started = false
      const present = new Set(input.presentCharacterIds?.()??input.characterIds)
      const eligible = [...pending.keys()].filter(id=>!running.has(id) && !stopped.has(id))
      // Randomize within the current priority group at each dispatch, never the stimulus history.
      const order = eligible.map(id=>({id,rank:Math.random()})).sort((a,b)=>Number(present.has(b.id))-Number(present.has(a.id))
        ||(consecutiveStale.get(a.id)??0)-(consecutiveStale.get(b.id)??0)
        ||(counts.get(a.id)??0)-(counts.get(b.id)??0)||a.rank-b.rank)
      for (const {id} of order) {
        if (running.size>=concurrency) break
        const job=jobFor(pending.get(id)!),current=phases[job.kind]
        if (job.kind!=='autonomous' && (counts.get(id)??0)>=current.limits.maximumCallsPerCharacter) {pending.delete(id);current.characterLimit=true;continue}
        const location=input.locationId!(id)
        if ((location===null && running.size>0) || [...running.keys()].some(other=>input.locationId!(other)===null || input.locationId!(other)===location)) continue
        // At most one off-scene request; leave a slot for newly ready foreground reactions.
        if (!present.has(id) && [...running.keys()].some(other=>!present.has(other))) continue
        const minimum=job.continuationOf?1:2
        const reserve=Math.min(job.continuationOf?1:3,current.limits.maximumNpcCalls-current.calls-current.reserved)
        if (reserve<minimum) continue
        pending.delete(id);current.reserved+=reserve;current.wave=Math.max(current.wave,job.depth)
        const turn=job.kind==='autonomous'?input.autonomy!.turn:input.turn
        const promise=turn.run(id,{signal:current.signal,stimulus:job.observations.map(entry=>entry.value),
          maxCalls:job.kind==='autonomous'?2:reserve===3?3:2,maxModelCalls:reserve,
          ...(job.continuationOf?{continuationOf:job.continuationOf}:{}),
          onCommitted:(through)=>{discardConsumed(id,through);collect(job.kind==='ordinary'?'ordinary':'autonomyReaction',job.kind==='autonomous'?1:job.depth+1)},
        }).then(result=>({id,result}),error=>({id,error})).then(result=>{completed.push(result);wake();return result})
        running.set(id,{promise,job,reserve});started=true
      }
      if (!running.size) break
      if (!started && completed.length) continue
      await changed!
    }
    if (signal.aborted) {
      phases.ordinary.interrupted=true
      if (input.autonomy) phases.autonomous.interrupted=true
    }
    await Promise.all([...running.values()].map(task=>task.promise))
    for (const completion of completed.splice(0)) {
      const {current,result}=account(completion)
      current.interrupted ||= result.status==='interrupted';current.failed ||= result.status==='failed'
    }
    running.clear()
    const ordinary=outcome('ordinary'),autonomous=outcome('autonomous'),reactions=outcome('autonomyReaction')
    return {...ordinary,...(input.autonomy?{autonomy:{activations:autonomous.activations,autonomousCalls:autonomous.calls,
      reactionCalls:reactions.calls,reactions,terminalReason:autonomous.terminalReason!=='quiescent'?autonomous.terminalReason:reactions.terminalReason}}:{})}
  } finally {
    controller.abort()
    // Closing the store or settling a player round must wait for every cancellation to be observed.
    await Promise.all([...running.values()].map(task=>task.promise))
    for (const source of new Set([signal,ordinarySignal,autonomySignal])) source.removeEventListener('abort',wake)
  }
}
