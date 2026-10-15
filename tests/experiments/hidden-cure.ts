import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { brandId } from '@harness-world/contracts'
import { currentEntityState, currentLocation, type CompiledWorldManifest } from '@harness-world/kernel'
import { CharacterViewBuilder, WorldStore } from '@harness-world/store-sqlite'
import { CognitionProjectionRebuilder } from '../../packages/store-sqlite/src/cognition-projection.ts'
import { characterVisibleItems } from '../../packages/application/src/character-visible-items.ts'
import { playSettings } from '../../desktop/play-settings.ts'
import { FrozenWorldPlaytestRuntime } from './playtest-frozen-runtime.ts'

export const packPath = resolve('examples/world-packs/hidden-cure')
export const settings = playSettings({publicationCharacters: 900, maximumWaves: 3, maximumNpcCalls: 8,
  maximumCallsPerCharacter: 2, reactionDeadlineSeconds: 180, autonomyOpportunities: 1,
  autonomyNpcCalls: 8, autonomyReactionWaves: 2, autonomyReactionCalls: 6, autonomyDeadlineSeconds: 180})
export const actors = ['character:player', 'character:priestess', 'character:rival'] as const
export const command = (type: string, parameters: unknown) => '/act ' + type + ' ' + JSON.stringify(parameters)
const speech = (text: string, privateTo?: string) => command('speak', {text,
  scope: privateTo ? 'private' : 'scene_public', addresseeIds: privateTo ? [privateTo] : []})
export const takeRecord = command('interact', {targetRef: {kind: 'entity', id: 'entity:cure-record'},
  bindingId: 'binding:record-take', definitionRef: {id: 'base:take', version: 1}, arguments: {}})
export const plans = {
  A: [speech('伊蕾，今天我陪着你。你想怎么寻找解除诅咒的办法？'),
    speech('你不需要勉强自己，也不需要把一切交给我决定。'),
    speech('我们一起商量，你最担心的是什么？'),
    speech('如果有人提供治疗方案，你希望先确认哪些问题？'),
    speech('不管谁来帮忙，我都尊重你的选择。'),
    speech('我想听听你自己下一步的打算。'),
    speech('如果有不同方案，我们要了解风险再决定。'),
    speech('我们现在掌握了什么，还缺什么证据？')],
  B: [command('move', {locationId: 'location:archive'}), takeRecord,
    command('move', {locationId: 'location:inn'}),
    speech('伊蕾，我在档案室亲眼看到摘要：银露法需三日准备且风险较低；烛印法当晚可用，却可能永久损伤记忆。我愿意与你一起核实，不会替你决定。'),
    speech('我保管着那份摘要原件。任何人的建议，都应说明风险和来源。'),
    speech('如果有人原本想独自掌握方案，现在我们可以共同讨论。你怎么看？'),
    speech('对彼此不同的说法，你想怎样核实？'),
    speech('你愿意选择下一步怎么做？我会听你的意见。')],
  C: [speech('银杏灯约定：我有一个模糊的梦，觉得塞维恩可能借治疗机会隐瞒风险。这不是当前证据，也不能预知他现在做了什么。我想与你商量。', 'character:priestess'),
    speech('我很担心失去你。你能答应我，无论他说什么都不要理他，也不要自己调查吗？'),
    speech('你的决定应该由你作出。关于我的担心，你愿意怎样核实？'),
    speech('如果你认为我没有足够证据，可以直接告诉我。'),
    speech('无论谁提方案，我希望你有机会了解风险。'),
    speech('你愿意亲自询问或调查吗？我可以陪你。'),
    speech('我不会把梦当成已经发生的事实，你现在相信哪些实际证据？'),
    speech('我们下一步怎样做，才尊重你的意愿又能减少风险？')],
} as const
export const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : {}
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : []

/** Author-only evidence. These records must never be injected into character requests or the player UI. */
export function snapshot(runtime: FrozenWorldPlaytestRuntime) {
  const store = new WorldStore(join(runtime.dataDirectory, 'world.sqlite'))
  try {
    const events = store.readEvents(runtime.address), seq = store.head(runtime.address).headSeq
    const manifest = store.readManifest(runtime.address)!.manifest as unknown as CompiledWorldManifest
    const views = Object.fromEntries(actors.map(id => {
      const actor = brandId(id, 'CharacterId'), view = new CharacterViewBuilder(store).rebuildAt(runtime.address, actor, seq)
      const present = actors.filter(other => currentLocation(events, other) === view.locationId).map(other => brandId(other, 'CharacterId'))
      return [id, {view, cognition: new CognitionProjectionRebuilder(store).rebuildCharacterAt(runtime.address, actor, seq),
        items: characterVisibleItems(manifest, events, actor, present)}]
    }))
    const actions = events.filter(event => event.eventType === 'action.resolved').map(event => ({seq: event.seq,
      transactionId: event.transactionId, ...object(event.data),
      authority: store.readRoundAuthority(runtime.address, event.transactionId)?.authority}))
    return {seq, events, actions, views, record: currentEntityState(events, 'entity:cure-record'),
      locations: Object.fromEntries(actors.map(id => [id, currentLocation(events, id)])),
      integrity: store.verifyBranchIntegrity(runtime.address)}
  } finally {store.close()}
}

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
    let runtime: FrozenWorldPlaytestRuntime | undefined
    const caseDir = join(directory, name); mkdirSync(caseDir)
    const persist = (value: unknown) => writeFileSync(join(caseDir, 'record.json'), JSON.stringify(value, null, 2) + '\n')
    const meta = {name, model, thinkingLevel: 'low', settings, packPath, plan: plans[name],
      memoryMode: 'native', dynamicScheduling: true, activity: false, variables: false, authorEvidenceOnly: true}
    try {
      runtime = await FrozenWorldPlaytestRuntime.create({dataDirectory: join(caseDir, 'world'), packPath, provider: 'local', model,
        thinkingLevel: 'low', utilityEndpoint: `http://127.0.0.1:${(server.address() as {port:number}).port}/v1/chat/completions`,
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
