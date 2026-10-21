// 默认使用受控响应；只有 --live 才调用真实上游模型。
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { currentEntityState, currentLocation } from '@harness-world/kernel'
import { WorldStore } from '@harness-world/store-sqlite'
import { estimateRequestTokens } from '../../packages/provider-chat/src/request-inspector.ts'
import { projectPlayerView } from '../../desktop/host/frontend-adapter.ts'
import { playSettings } from '../../desktop/play-settings.ts'
import { WorldHostRuntime } from '../../desktop/host/world-runtime.ts'

// Author-side acceptance driver; retain no raw prompts, responses, reasoning or credentials.
const args = process.argv.slice(2), live = args.includes('--live'), stagedAutonomy = args.includes('--staged-autonomy')
const cases = ['isolated-default', 'isolated-burst', 'mixed-serial', 'mixed-dynamic'] as const
type Case = typeof cases[number]
const selected = args.find(arg => arg.startsWith('--case='))?.slice(7)
if (args.some(arg => !['--live','--staged-autonomy'].includes(arg) && !arg.startsWith('--case=')) || (selected && !cases.includes(selected as Case))) {
  throw new TypeError('用法：autonomy-scheduling.ts [--live] [--staged-autonomy] [--case=isolated-default|isolated-burst|mixed-serial|mixed-dynamic]')
}
const model = 'gemini-3.8-flash', endpoint = 'http://127.0.0.1:8045/v1/chat/completions'
const actorId = 'character:friend', keyId = 'entity:brass-key', archiveId = 'location:archive-room'
const outputRoot = resolve('output/autonomy-scheduling')
mkdirSync(outputRoot, {recursive: true})
const directory = mkdtempSync(join(outputRoot, live ? 'live-' : 'controlled-'))
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : {}
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : []
const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
function externalObservations(values: unknown): number {
  return array(values).filter(entry => {
    const row = object(entry), outer = object(object(row.value ?? row).content)
    const content = typeof outer.actorId === 'string' ? outer : object(outer.content)
    return typeof content.actorId === 'string' && content.actorId !== actorId
  }).length
}
interface Usage { inputTokens?: number; outputTokens?: number; totalTokens?: number; cachedInputTokens?: number; reasoningTokens?: number }
interface Call {
  round: number; actor: string; autonomous: boolean; continuation: boolean; location: unknown;
  startedMs: number; finishedMs?: number; httpStatus?: number; cancelled?: boolean;
  externalStimuli: number; externalObservations: number; estimatedRequestTokens: number;
  decision?: unknown; actionType?: unknown; definitionId?: unknown; destination?: unknown; usage?: Usage;
  outputShape?: {extraKeys:boolean;segmentTypes:string[];segmentLengths:(number|null)[];scope:string;addresseeCount:number|null};
}
function responseMetadata(call: Call, value: unknown): void {
  const root = object(value), usage = object(root.usage ?? root.usageMetadata)
  const fields = {
    inputTokens: number(usage.prompt_tokens ?? usage.input_tokens ?? usage.promptTokenCount),
    outputTokens: number(usage.completion_tokens ?? usage.output_tokens ?? usage.candidatesTokenCount),
    totalTokens: number(usage.total_tokens ?? usage.totalTokenCount),
    cachedInputTokens: number(object(usage.prompt_tokens_details).cached_tokens),
    reasoningTokens: number(object(usage.completion_tokens_details).reasoning_tokens),
  }
  const entries = Object.entries(fields).filter(([, value]) => value !== undefined)
  if (entries.length) call.usage = Object.fromEntries(entries) as Usage
  const message = object(object(array(root.choices)[0]).message ?? root.message)
  const tool = object(array(message.tool_calls)[0]), raw = object(tool.function).arguments ?? message.content
  if (typeof raw !== 'string') return
  try {
    const result = object(JSON.parse(raw)), parameters = object(result.parameters)
    call.decision = result.decision; call.actionType = result.actionType
    call.definitionId = object(parameters.definitionRef).id; call.destination = parameters.locationId
    // Diagnose rejected formats without retaining dialogue or unrecognized model fields.
    call.outputShape = {extraKeys:Object.keys(result).some(key=>!['decision','segments','scope','addresseeIds','actionType','parameters','query'].includes(key)),
      segmentTypes:array(result.segments).map(segment=>['speech','narration'].includes(String(object(segment).type))?String(object(segment).type):'invalid'),
      segmentLengths:array(result.segments).map(segment=>typeof object(segment).text==='string'?String(object(segment).text).length:null),
      scope:result.scope===undefined?'omitted':['scene_public','direct','private','self'].includes(String(result.scope))?String(result.scope):'invalid',
      addresseeCount:result.addresseeIds===undefined?0:Array.isArray(result.addresseeIds)?result.addresseeIds.length:null}
  } catch { /* The runtime classifies malformed output; no raw text is retained here. */ }
}
function cost(calls: readonly Call[]) {
  const sum = (field: keyof Usage) => calls.some(call => call.usage?.[field] !== undefined)
    ? calls.reduce((total, call) => total + (call.usage?.[field] ?? 0), 0) : null
  return {modelCalls: calls.length, callsWithUsage: calls.filter(call => call.usage !== undefined).length,
    providerInputTokens: sum('inputTokens'), providerOutputTokens: sum('outputTokens'), providerTotalTokens: sum('totalTokens'),
    providerCachedInputTokens: sum('cachedInputTokens'), providerReasoningTokens: sum('reasoningTokens'),
    estimatedWholeRequestTokens: calls.reduce((total, call) => total + call.estimatedRequestTokens, 0)}
}
function goalDecision(input: Record<string, unknown>) {
  if (input.continuation) return {decision: 'abstain'}
  const context = object(input.context), location = context.locationId
  const item = array(object(context.items).current).map(object).find(item => item.entityId === keyId)
  if (location === archiveId && item?.holderId === null && item.locationId === archiveId) return {decision: 'abstain'}
  if (item?.holderId === actorId && location !== archiveId) return {decision: 'perform', actionType: 'move', parameters: {locationId: archiveId}}
  const definition = item?.holderId === actorId ? 'drop' : 'take'
  return {decision: 'perform', actionType: 'interact', parameters: {targetRef: {kind: 'entity', id: keyId},
    bindingId: `binding:key-${definition}`, definitionRef: {id: `base:${definition}`, version: 1}, arguments: {}}}
}
function activationResults(value: unknown) {
  return array(object(value).activations).map(entry => {
    const activation = object(entry), result = object(activation.result)
    return {actor: activation.characterId, status: result.status, calls: result.calls, failure:result.failure}
  })
}
async function run(name: Case) {
  const mixed = name.startsWith('mixed'), serialScheduling = name === 'mixed-serial', burst = name === 'isolated-burst'
  const settings = playSettings({publicationCharacters: 600, maximumWaves: 2, maximumNpcCalls: 6, maximumCallsPerCharacter: 1,
    reactionDeadlineSeconds: 120, autonomyOpportunities: burst ? 6 : 1, autonomyNpcCalls: burst ? 12 : 3,
    autonomyReactionWaves: 1, autonomyReactionCalls: 4, autonomyDeadlineSeconds: 120})
  let origin = performance.now(), round = 0, active = 0, peak = 0
  const calls: Call[] = [], rounds: Record<string, unknown>[] = [], controller = new AbortController()
  const server = createServer((request, response) => {
    let body = ''; request.on('data', chunk => {body += String(chunk)})
    request.on('end', () => {void (async () => {
      const wire = object(JSON.parse(body)), message = object(array(wire.messages).at(-1))
      const input = object(JSON.parse(String(message.content))), context = object(input.context)
      const actor = String(object(context.character).characterId)
      const call: Call = {round, actor, autonomous: context.autonomy !== undefined, continuation: input.continuation === true,
        location: context.locationId, startedMs: Math.round(performance.now() - origin),
        externalStimuli: externalObservations(context.stimulus), externalObservations: externalObservations(context.history),
        estimatedRequestTokens: estimateRequestTokens(body)}
      calls.push(call); active++; peak = Math.max(peak, active)
      const cancellation = new AbortController(), signal = AbortSignal.any([controller.signal, cancellation.signal])
      response.on('close', () => {if (!response.writableEnded) cancellation.abort()})
      try {
        if (live) {
          const upstream = await fetch(endpoint, {method: 'POST', headers: {'content-type': 'application/json'}, body, signal})
          const text = await upstream.text(); call.httpStatus = upstream.status
          try {responseMetadata(call, JSON.parse(text))} catch { /* Invalid responses are not saved. */ }
          response.writeHead(upstream.status, {'content-type': 'application/json'}); response.end(text)
        } else {
          await delay(actor === actorId ? 60 : actor === 'character:witness' ? 400 : 80, undefined, {signal})
          const output = call.autonomous ? goalDecision(input) : {decision: 'publish', segments: [{type: 'speech', text: '好的，你继续整理吧。'}]}
          const result = {message: {content: JSON.stringify(output)}}
          responseMetadata(call, result); call.httpStatus = 200
          response.writeHead(200, {'content-type': 'application/json'}); response.end(JSON.stringify(result))
        }
      } catch {
        call.cancelled = signal.aborted
        if (!response.destroyed) {response.writeHead(503); response.end('experiment provider unavailable')}
      } finally {active--; call.finishedMs = Math.round(performance.now() - origin)}
    })()})
  })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const runtime = await WorldHostRuntime.create({dataDirectory: join(directory, name),
    packPath: resolve('examples/world-packs/autonomy-scheduling'), provider: live ? 'local' : 'ollama',
    model: live ? model : 'controlled-goal-fixture', ...(live ? {thinkingLevel: 'low' as const} : {}),
    utilityEndpoint: `http://127.0.0.1:${(server.address() as {port: number}).port}/v1/chat/completions`,
    timeoutMs: live ? 60000 : 5000, serialScheduling, stagedAutonomy, playSettings: settings})
  let initialIdleCalls = 0, finalIdleCalls = 0, goalCompletedRound: number | null = null, reachedSeq: number | null = null
  let state = await runtime.state()
  const save = () => writeFileSync(join(directory, name + '.json'), JSON.stringify({name, settings, rounds, calls, playerView: projectPlayerView(state)}, null, 2))
  const originalRandom = Math.random
  // Hold role tie-breaking constant; real answers and gateway latency remain uncontrolled.
  Math.random = () => 0.5
  try {
    origin = performance.now()
    const beforeIdle = calls.length; await delay(live ? 2000 : 100); initialIdleCalls = calls.length - beforeIdle
    for (round = 1; round <= (burst ? 1 : 6); round++) {
      const start = Math.round(performance.now() - origin), beforeCalls = calls.length
      const beforeLine = state.transcript.at(-1)?.seq ?? 0
      let firstVisibleReplyMs: number | null = null, polling = false
      const poll = setInterval(() => {
        if (polling) return; polling = true
        void runtime.state().then(current => {
          if (firstVisibleReplyMs === null && current.transcript.some(line => line.seq > beforeLine && !line.player && line.segments !== undefined)) {
            firstVisibleReplyMs = Math.round(performance.now() - origin) - start
          }
        }).finally(() => {polling = false})
      }, 40)
      try {
        const input = mixed ? '/act move ' + JSON.stringify({locationId: round % 2 ? 'location:front-room' : 'location:back-room'})
          : '/act speak ' + JSON.stringify({text: `我继续整理自己的笔记，第${round}页。`, scope: 'self', addresseeIds: []})
        state = await runtime.submit(input)
      } finally {clearInterval(poll)}
      const store = new WorldStore(join(runtime.dataDirectory, 'world.sqlite'))
      try {
        const events = store.readEvents(runtime.address), key = currentEntityState(events, keyId)
        const goalComplete = key?.holderId === null && key.locationId === archiveId
        const reached = events.find(event => event.eventType === 'entity.transferred'
          && object(event.data).entityId === keyId && object(event.data).toLocationId === archiveId)
        if (reached && goalCompletedRound === null) {
          goalCompletedRound = round
          reachedSeq = events.find(event => event.transactionId === reached.transactionId
            && event.eventType === 'action.resolved' && object(event.data).actorId === actorId)?.seq ?? reached.seq
        }
        const roundCalls = calls.slice(beforeCalls), ordinary = roundCalls.filter(call => !call.autonomous)
        const autonomous = roundCalls.filter(call => call.autonomous)
        const firstAuto = autonomous[0]?.startedMs, ordinaryEnd = ordinary.length ? Math.max(...ordinary.map(call => call.finishedMs ?? call.startedMs)) : null
        const autonomy = object(state.debug.autonomy)
        const result = {round, elapsedMs: Math.round(performance.now() - origin) - start, firstVisibleReplyMs,
          ordinaryElapsedMs: ordinary.length ? (ordinaryEnd ?? start) - ordinary[0]!.startedMs : 0,
          autonomousElapsedMs: autonomous.length ? (autonomous.at(-1)!.finishedMs ?? start) - firstAuto! : 0,
          ordinaryFinishedBeforeAutonomy: firstAuto === undefined || ordinaryEnd === null || ordinaryEnd <= firstAuto,
          ordinaryCalls: ordinary.length, autonomousCalls: autonomous.length, cost: cost(roundCalls),
          goalComplete, actorLocation: currentLocation(events, actorId), key,
          ordinaryTerminal: object(state.debug.activationCycle).terminalReason,
          autonomousTerminal: autonomy.terminalReason, reactionCalls: autonomy.reactionCalls,
          ordinaryActivations: activationResults(state.debug.activationCycle), autonomousActivations: activationResults(autonomy),
          error: state.error, notice: state.notice, integrity: store.verifyBranchIntegrity(runtime.address)}
        rounds.push(result); save()
        process.stdout.write(JSON.stringify({case: name, round, elapsedMs: result.elapsedMs, goalComplete,
          ordinaryCalls: ordinary.length, autonomousCalls: autonomous.length, error: state.error}) + '\n')
      } finally {store.close()}
      if (state.error) break
    }
    const beforeFinalIdle = calls.length; await delay(live ? 2000 : 100); finalIdleCalls = calls.length - beforeFinalIdle
    const store = new WorldStore(join(runtime.dataDirectory, 'world.sqlite'))
    try {
      const events = store.readEvents(runtime.address)
      const actions = events.filter(event => event.eventType === 'action.resolved' && object(event.data).actorId === actorId
        && object(event.data).actionType !== 'speak').map(event => {
          const resolved = object(event.data), record = store.readRoundAuthority(runtime.address, event.transactionId)?.authority
          const action = object(object(record).action), parameters = object(action.parameters)
          return {seq: event.seq, accepted: resolved.accepted, actionType: action.actionType,
            definitionId: object(parameters.definitionRef).id, destination: parameters.locationId}
        })
      const external = events.filter(event => event.eventType === 'observation.upsert'
        && object(object(event.data).value).observerId === actorId
        && typeof object(object(object(event.data).value).content).actorId === 'string'
        && object(object(object(event.data).value).content).actorId !== actorId)
      const autonomous = calls.filter(call => call.autonomous), ordinary = calls.filter(call => !call.autonomous)
      const callsAfterGoal = goalCompletedRound === null ? [] : autonomous.filter(call => call.round > goalCompletedRound!)
      const accepted = actions.filter(action => action.accepted), afterCompletion = reachedSeq === null ? [] : accepted.filter(action => action.seq > reachedSeq!)
      const completedAction = reachedSeq === null ? -1 : actions.findIndex(action => action.seq === reachedSeq)
      const completedCall = completedAction < 0 ? undefined : autonomous.filter(call => call.decision === 'perform')[completedAction]
      const afterGoal = completedCall === undefined ? [] : autonomous.slice(autonomous.indexOf(completedCall) + 1)
      const invariants = {noExternalObservations: external.length === 0 && autonomous.every(call => call.externalStimuli === 0 && call.externalObservations === 0),
        autonomousRoleOnly: autonomous.every(call => call.actor === actorId), noErrors: !rounds.some(row => row.error),
        noRejectedAutonomousActions: actions.every(action => action.accepted),
        goalCompleted: currentEntityState(events, keyId)?.locationId === archiveId && currentEntityState(events, keyId)?.holderId === null,
        noActionsAfterCompletion: afterCompletion.length === 0, noIsolatedExpressionInPlayerView: !state.transcript.some(line => line.speaker === '保管员'),
        stagedOrderPreserved: !serialScheduling && !stagedAutonomy || rounds.every(row => row.ordinaryFinishedBeforeAutonomy),
        boundedConcurrency: peak <= 2 && (!serialScheduling || peak <= 1), idleDoesNotRun: initialIdleCalls === 0 && finalIdleCalls === 0}
      const metrics = {name, elapsedMs: rounds.reduce((total, row) => total + Number(row.elapsedMs), 0),
        rounds: rounds.length, goalCompletedRound, peakConcurrentCalls: peak, cost: cost(calls),
        overlappingPlayerRounds: rounds.filter(row=>!row.ordinaryFinishedBeforeAutonomy).length,
        autonomousCost: cost(autonomous), ordinaryCost: cost(ordinary),
        callsInLaterPlayerRoundsAfterGoalCompletion: callsAfterGoal.length,
        additionalOpportunityCostAfterGoalCompletion: cost(afterGoal.filter(call => !call.continuation)),
        resultContinuationCostAfterGoalCompletion: cost(afterGoal.filter(call => call.continuation)),
        decisionsInAdditionalOpportunitiesAfterGoal: afterGoal.filter(call => !call.continuation).map(call => call.decision),
        externalObservationCount: external.length, initialIdleCalls, finalIdleCalls, invariants, actions,
        staleResults: rounds.flatMap(row => [...array(row.ordinaryActivations),...array(row.autonomousActivations)]).filter(row => object(row).status === 'stale').length}
      writeFileSync(join(directory, name + '.json'), JSON.stringify({metrics, settings, rounds, calls, playerView: projectPlayerView(state)}, null, 2))
      return metrics
    } finally {store.close()}
  } finally {
    Math.random = originalRandom; controller.abort(); await runtime.close()
    server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()))
  }
}
const results = []
for (const name of cases.filter(name => !selected || selected === name)) results.push(await run(name))
const summary = {live, stagedAutonomy, model: live ? model : 'controlled-goal-fixture', endpoint: live ? endpoint : null,
  thinkingLevel: live ? 'low' : null, injectedLiveDelayMs: 0, directory, results}
writeFileSync(join(directory, 'summary.json'), JSON.stringify(summary, null, 2))
process.stdout.write(JSON.stringify(summary, null, 2) + '\n')
if (results.some(result => Object.values(result.invariants).some(value => !value)) || (!live && results.some(result => result.name === 'mixed-dynamic' && result.peakConcurrentCalls !== 2))) {
  process.exitCode = 1
}
