import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { WorldJsonObject } from '@harness-world/contracts'
import { FrozenWorldPlaytestRuntime } from './playtest-frozen-runtime.ts'
import type { PlaytestState } from './playtest-server.ts'
import { projectPlayerView } from '../../packages/frontend/src/player-view.ts'

// A local, reproducible scheduling comparison. Only public player output and timings are saved.
const live = process.argv.slice(2).includes('--live')
const interrupt = process.argv.slice(2).includes('--interrupt')
const liveModel = 'gemini-3.8-flash'
if (process.argv.slice(2).some(arg => !['--live', '--interrupt'].includes(arg)) || (interrupt && !live)) {
  throw new TypeError('默认运行受控对比；--live 使用真实模型，--live --interrupt 验证插话与重新生成。')
}
const outputRoot = resolve('output/dynamic-scheduling')
mkdirSync(outputRoot, { recursive: true })
const directory = mkdtempSync(join(outputRoot, live ? 'live-' : 'comparison-'))
const object = (value: unknown) => value as WorldJsonObject
interface CallTiming { actor: string; startedMs: number; upstreamStartedMs?: number; finishedMs?: number; cancelled?: boolean; responseStatus?: number }
async function run(serialScheduling: boolean) {
  const originalRandom = Math.random
  // Fix the ordinary role shuffle only in the controlled provider comparison.
  if (!live) Math.random = () => 0.5
  let origin = performance.now(), active = 0, peak = 0
  const calls: CallTiming[] = [], actorCalls = new Map<string, number>()
  const controller = new AbortController()
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', chunk => { body += String(chunk) })
    request.on('end', () => { void (async () => {
      const wire = JSON.parse(body), input = object(JSON.parse(wire.messages.at(-1).content))
      const actor = String(object(object(input.context).character).characterId)
      const nth = (actorCalls.get(actor) ?? 0) + 1; actorCalls.set(actor, nth)
      const record: CallTiming = { actor, startedMs: Math.round(performance.now() - origin) }
      calls.push(record); active++; peak = Math.max(peak, active)
      const cancellation = new AbortController()
      const signal = AbortSignal.any([controller.signal, cancellation.signal])
      response.on('close', () => { if (!response.writableEnded) cancellation.abort() })
      try {
        await delay(actor === 'character:friend' ? (live ? 20000 : 2000) : (live ? 0 : 100), undefined, { signal })
        if (live) {
          record.upstreamStartedMs = Math.round(performance.now() - origin)
          const upstream = await fetch('http://127.0.0.1:8045/v1/chat/completions', {
            method: 'POST', headers: { 'content-type': 'application/json' }, body, signal,
          })
          const result = await upstream.text()
          record.responseStatus = upstream.status
          response.writeHead(upstream.status, { 'content-type': 'application/json' }); response.end(result)
        } else {
          const output = actor === 'character:friend'
            ? { decision: 'publish', segments: [{ type: 'speech', text: '后室独立的答复。' }] }
            : actor === 'character:companion'
              ? { decision: 'publish', segments: [{ type: 'speech', text: nth === 1 ? '你来了，坐这边吧。' : '刚才的话我听到了，我们继续聊。' }] }
              : nth === 1 ? { decision: 'publish', segments: [{ type: 'speech', text: '嗯，我也听到了。' }] } : { decision: 'abstain' }
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ message: { content: JSON.stringify(output) } }))
        }
      } catch {
        record.cancelled = signal.aborted
        if (!response.destroyed) { response.writeHead(503); response.end('experiment provider interrupted') }
      } finally { active--; record.finishedMs = Math.round(performance.now() - origin) }
    })() })
  })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const runtime = await FrozenWorldPlaytestRuntime.create({
    dataDirectory: join(directory, serialScheduling ? 'serial' : 'dynamic'),
    packPath: resolve('examples/world-packs/dynamic-scheduling'),
    provider: live ? 'local' : 'ollama', model: live ? liveModel : 'controlled-fixture',
    ...(live ? { thinkingLevel: 'low' as const } : {}),
    utilityEndpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/chat/completions`,
    serialScheduling, timeoutMs: live ? 90000 : 10000,
    tuning: { maximumWaves: 3, maximumNpcCalls: 12, maximumCallsPerCharacter: 2,
      reactionDeadlineSeconds: live ? 120 : 30, recentObservations: 16, recentSelfObservations: 8 },
  })
  const timeline: { elapsedMs: number; busy: boolean; canInterrupt: boolean; visibleNpcLines: number }[] = []
  let polling = false
  const poll = setInterval(() => {
    if (polling) return
    polling = true
    void runtime.state().then(state => {
      const row = { elapsedMs: Math.round(performance.now() - origin), busy: state.busy,
        canInterrupt: state.canInterrupt === true, visibleNpcLines: state.transcript.filter(line => !line.player).length }
      const last = timeline.at(-1)
      if (!last || last.busy !== row.busy || last.canInterrupt !== row.canInterrupt || last.visibleNpcLines !== row.visibleNpcLines) timeline.push(row)
    }).finally(() => { polling = false })
  }, 50)
  try {
    origin = performance.now()
    const first = runtime.submit('/act move {"locationId":"location:front-room"}')
    let interruptResult: Record<string, unknown> | undefined
    let state: PlaytestState
    if (interrupt) {
      // Cancel an actual in-flight gateway request, rather than merely its injected delay.
      let before
      const waitUntil = performance.now() + 60000
      while (performance.now() < waitUntil) {
        before = await runtime.state()
        const background = calls.find(call => call.actor === 'character:friend')
        if (before.canInterrupt && background?.upstreamStartedMs !== undefined && background.finishedMs === undefined) break
        if (!before.busy && calls.length) throw new Error('后台请求完成前未获得真实请求插话机会。')
        await delay(20)
      }
      const background = calls.find(call => call.actor === 'character:friend')
      if (!before?.canInterrupt || background?.upstreamStartedMs === undefined || background.finishedMs !== undefined) {
        throw new Error('没有观察到可中断的真实后台调用。')
      }
      const committedLines = before.transcript.filter(line => !line.player)
      const input = '我们继续聊吧，你们今天有什么打算？'
      const submittedMs = Math.round(performance.now() - origin)
      const next = runtime.submit(input)
      let committedMs: number | undefined
      while (performance.now() < waitUntil) {
        const current = await runtime.state()
        if (current.transcript.some(line => line.player && line.text === input)) {
          committedMs = Math.round(performance.now() - origin); break
        }
        await delay(20)
      }
      state = await next; await first
      // The cancelled gateway handler finishes asynchronously after downstream cancellation.
      for (let attempt = 0; attempt < 100 && background.finishedMs === undefined; attempt++) await delay(20)
      if (state.error || committedMs === undefined || !background.cancelled
        || committedLines.some(line => !state.transcript.some(retained => retained.seq === line.seq && retained.text === line.text))
        || state.transcript.filter(line => line.player && line.text === input).length !== 1) {
        throw new Error('真实插话未通过取消、保留已提交表达或单次输入检查。')
      }
      const tail = state.tailRound?.id
      if (!tail) throw new Error('插话后没有形成可重新生成的末端回合。')
      const regenerated = await runtime.regenerate(tail, 'real-model-interruption-regeneration')
      if (regenerated.error || regenerated.tailRound?.candidateIds?.length !== 2
        || regenerated.transcript.filter(line => line.player && line.text === input).length !== 1
        || committedLines.some(line => !regenerated.transcript.some(retained => retained.seq === line.seq && retained.text === line.text))) {
        throw new Error('真实插话后的末端重新生成未通过保留前缀或输入去重检查。')
      }
      interruptResult = { submittedMs, committedMs, acceptanceMs: committedMs - submittedMs,
        backgroundCancelled: background.cancelled, preservedNpcLines: committedLines.length,
        regenerationCandidates: regenerated.tailRound.candidateIds.length, playerInputOccurrences: 1 }
      state = regenerated
    } else state = await first
    const elapsedMs = Math.round(performance.now() - origin)
    const firstReplyMs = timeline.find(row => row.visibleNpcLines > 0)?.elapsedMs ?? null
    const foregroundFollowup = calls.filter(call => call.actor === 'character:companion')[1]
    const background = calls.find(call => call.actor === 'character:friend')
    const metrics = { scheduling: serialScheduling ? 'serial' : 'dynamic', elapsedMs, firstReplyMs,
      foregroundFollowupStartedMs: foregroundFollowup?.startedMs ?? null,
      backgroundFinishedMs: background?.finishedMs ?? null,
      foregroundFollowupBeforeBackgroundFinished: foregroundFollowup !== undefined && background?.finishedMs !== undefined
        && foregroundFollowup.startedMs < background.finishedMs,
      peakConcurrentCalls: peak, modelCalls: calls.length, error: state.error, notice: state.notice,
      ...(interruptResult ? { interrupt: interruptResult } : {}) }
    writeFileSync(join(directory, `${metrics.scheduling}.json`), JSON.stringify({ metrics, calls, timeline, playerView: projectPlayerView(state) }, null, 2))
    if (!live && (state.error || JSON.stringify(projectPlayerView(state)).includes('后室独立的答复。')
      || (serialScheduling ? peak !== 1 : !metrics.foregroundFollowupBeforeBackgroundFinished))) {
      throw new Error('受控对比未满足并行、前台续接或玩家隐私检查。')
    }
    return metrics
  } finally {
    Math.random = originalRandom
    clearInterval(poll); controller.abort(); await runtime.close()
    server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()))
  }
}
const results = []
if (!live) results.push(await run(true))
results.push(await run(false))
const summary = { live, interrupt, model: live ? liveModel : 'controlled-fixture',
  endpoint: live ? 'http://127.0.0.1:8045/v1/chat/completions' : null,
  thinkingLevel: live ? 'low' : null, injectedBackgroundDelayMs: live ? 20000 : 2000, results }
writeFileSync(join(directory, 'summary.json'), JSON.stringify(summary, null, 2))
process.stdout.write(`${JSON.stringify({ directory, ...summary }, null, 2)}\n`)
if (results.some(result => result.error)) process.exitCode = 1
