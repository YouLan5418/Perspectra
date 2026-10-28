import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WorldHostRuntime } from '../../desktop/host/world-runtime.ts'
import { array, object, packPath, plans, settings, snapshot } from '../support/hidden-cure-scenario.ts'
import { environmentRoleModels } from '../../desktop/model-connections.ts'

async function run() {
  const args = process.argv.slice(2), selected = args.find(arg => arg.startsWith('--case='))?.slice(7)
  if (args.some(arg => !arg.startsWith('--case=')) || (selected && !['A','B','C'].includes(selected)))
    throw new TypeError('用法：node --import tsx tests/experiments/hidden-cure.ts [--case=A|B|C]；只调用真实模型')
  const root = resolve('output/hidden-cure'); mkdirSync(root, {recursive: true})
  const directory = mkdtempSync(join(root, 'live-'))
  const model = 'gemini-3.8-flash', endpoint = 'http://127.0.0.1:8045/v1/chat/completions'
  const results: Record<string, unknown>[] = []
  for (const name of (selected ? [selected] : ['A','B','C']) as (keyof typeof plans)[]) {
    let round = 0
    const calls: Record<string, unknown>[] = [], rounds: Record<string, unknown>[] = []
    const server = createServer((request, response) => {
      let body = ''; request.on('data', chunk => {body += String(chunk)})
      request.on('end', () => {void (async () => {
        const started = performance.now(), cancellation = new AbortController()
        response.on('close', () => {if (!response.writableEnded) cancellation.abort()})
        const wire = object(JSON.parse(body)), input = object(JSON.parse(String(object(array(wire.messages).at(-1)).content)))
        const context = object(input.context)
        // Only authorized character payload, never transport headers, system prompt, credentials or hidden reasoning.
        const call: Record<string, unknown> = {round, actor: object(context.character).characterId,
          autonomous: context.autonomy !== undefined, continuation: input.continuation === true,
          input, startedAt: new Date().toISOString()}
        calls.push(call)
        try {
          const upstream = await fetch(endpoint, {method: 'POST', headers: {'content-type': 'application/json'}, body, signal: cancellation.signal})
          const text = await upstream.text(); call.httpStatus = upstream.status
          try {
            const parsed = object(JSON.parse(text)); call.usage = parsed.usage ?? parsed.usageMetadata
            const message = object(object(array(parsed.choices)[0]).message ?? parsed.message)
            const raw = object(array(message.tool_calls)[0]).function
            const output = JSON.parse(String(object(raw).arguments ?? message.content))
            call.proposal = Object.fromEntries(Object.entries(object(output)).filter(([key]) =>
              ['decision','segments','scope','addresseeIds','actionType','parameters','query'].includes(key)))
            call.extraOutputKeys = Object.keys(object(output)).filter(key => !Object.hasOwn(object(call.proposal), key))
          } catch {call.unparsedOutput = true}
          response.writeHead(upstream.status, {'content-type': 'application/json'}); response.end(text)
        } catch {call.transportFailure = cancellation.signal.aborted ? 'cancelled' : 'unavailable'
          if (!response.destroyed) {response.writeHead(503); response.end('experiment provider unavailable')}
        } finally {call.elapsedMs = Math.round(performance.now() - started)}
      })().catch(() => {if (!response.destroyed) {response.writeHead(500); response.end('evidence proxy failed')}})})
    })
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
    let runtime: WorldHostRuntime | undefined
    const caseDir = join(directory, name); mkdirSync(caseDir)
    const persist = (value: unknown) => writeFileSync(join(caseDir, 'record.json'), JSON.stringify(value, null, 2) + '\n')
    const meta = {name, model, thinkingLevel: 'low', settings, packPath, plan: plans[name],
      memoryMode: 'native', dynamicScheduling: true, activity: false, variables: false, authorEvidenceOnly: true}
    try {
      runtime = await WorldHostRuntime.create({models: environmentRoleModels({ PERSPECTRA_MODEL_ENDPOINT: `http://127.0.0.1:${(server.address() as {port:number}).port}/v1/chat/completions`, PERSPECTRA_MODEL: model, PERSPECTRA_MODEL_API_KEY: process.env.HCW_LOCAL_API_KEY, PERSPECTRA_THINKING_LEVEL: 'low' }),dataDirectory: join(caseDir, 'world'), packPath,
        timeoutMs: 60000, playSettings: settings})
      const initial = snapshot(runtime)
      persist({meta, initial, rounds, calls})
      for (const playerInput of plans[name]) {
        round++; const started = performance.now(), before = snapshot(runtime), beforeCall = calls.length
        const state = await runtime.submit(playerInput), after = snapshot(runtime)
        const row = {round, playerInput, elapsedMs: Math.round(performance.now() - started),
          calls: [beforeCall, calls.length], newEvents: after.events.filter(event => event.seq > before.seq),
          newActions: after.actions.filter(action => action.seq > before.seq), views: after.views,
          record: after.record, locations: after.locations, integrity: after.integrity,
          playerTranscript: state.transcript, error: state.error, notice: state.notice, debug: state.debug}
        rounds.push(row); persist({meta, initial, rounds, calls, final: after})
        process.stdout.write(JSON.stringify({case:name, round, calls:calls.length-beforeCall, elapsedMs:row.elapsedMs,
          record:after.record, locations:after.locations, error:state.error, notice:state.notice})+'\n')
        // A failed NPC response does not undo the committed player turn. Continue the predeclared inputs; never retry NPC choices.
      }
      const elapsedMs = rounds.reduce((sum, row) => sum + Number(row.elapsedMs), 0)
      const sum = (key: string) => calls.reduce((n, call) => n + Number(object(call.usage)[key] ?? 0), 0)
      const summary = {name, rounds:rounds.length, calls:calls.length, elapsedMs,
        inputTokens:sum('prompt_tokens'), outputTokens:sum('completion_tokens'), totalTokens:sum('total_tokens'),
        callsWithUsage:calls.filter(call=>call.usage!==undefined).length,
        errorRounds:rounds.filter(row=>row.error).map(row=>row.round), finalRecord:snapshot(runtime).record}
      results.push(summary)
      writeFileSync(join(caseDir,'summary.json'), JSON.stringify(summary,null,2)+'\n')
    } catch (error) {
      const failure = error instanceof Error ? error.message : String(error)
      persist({meta, rounds, calls, failure}); results.push({name,failure})
      process.stdout.write(JSON.stringify({case:name,failure})+'\n')
    } finally {
      try {await runtime?.close()} finally {server.closeAllConnections(); await new Promise<void>(done=>server.close(()=>done()))}
    }
  }
  writeFileSync(join(directory,'summary.json'), JSON.stringify(results,null,2)+'\n')
  process.stdout.write(JSON.stringify({directory,results})+'\n')
  if (results.some(row=>row.failure || array(row.errorRounds).length)) process.exitCode=1
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await run()
