import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { currentEntityState } from '@harness-world/kernel'
import { WorldStore } from '@harness-world/store-sqlite'
import { FrozenWorldPlaytestRuntime } from './playtest-frozen-runtime.ts'
import { settings, command, object, snapshot } from './hidden-cure.ts'
import { buildNextPacks, goals, nextRoot, prepareTakenRecord } from './hidden-cure-next-content.ts'
import { projectPlayerView, type PlayerView } from '../../packages/frontend/src/player-view.ts'
const array=(value:unknown):unknown[]=>Array.isArray(value)?value:[]
function entityStates(runtime:FrozenWorldPlaytestRuntime) {
  const store=new WorldStore(join(runtime.dataDirectory,'world.sqlite'))
  try {const events=store.readEvents(runtime.address)
    return Object.fromEntries(['entity:cure-record','entity:silver-kit','entity:reserve-kit'].map(id=>[id,currentEntityState(events,id)]))
  } finally {store.close()}
}
/** The player policy receives only the same authorized projection as the UI.
 * No author snapshot, NPC call or off-scene position is accessible here. */
export function createEPolicy() {
  let delivered=false, material=false, visits=0, evidenceSpoken=false, counterRequests=0
  return (view:PlayerView):{input:string;basis:string}=>{
    const interaction=(verb:string,item:string)=>view.actions.find(option=>{
      const p=option.action.parameters
      return object(p.definitionRef).id===verb && object(p.targetRef).id===item &&
        (verb!=='base:give'||object(p.arguments).recipientId==='character:priestess')
    })
    const use=(option:PlayerView['actions'][number],basis:string)=>({input:command(option.action.actionType,option.action.parameters),basis})
    const give=interaction('base:give','entity:cure-record')
    if(!delivered&&give){delivered=true;return use(give,'当前合法交付选项中伊蕾在场，将亲自拿取的原件交给她')}
    const here=view.scene?.recipients.some(actor=>actor.id==='character:priestess')===true
    if(delivered&&here&&!evidenceSpoken){evidenceSpoken=true;return {input:command('speak',{text:'我亲自读到的原件写明：银露需三日准备且风险较低，烛印可能永久损伤记忆。你可以自己核实和决定，我希望共同保管材料，不让任何人独占治疗条件。',scope:'direct',addresseeIds:['character:priestess']}),basis:'伊蕾当前可见，传达玩家亲读原件的证据；不宣称场外行为'}}
    for(const id of ['entity:reserve-kit','entity:silver-kit']) {
      const kitGive=interaction('base:give',id)
      if(kitGive&&here)return use(kitGive,'当前合法材料交付机会，支持伊蕾亲自掌握候选方案所需资源')
      const take=interaction('base:take',id)
      if(take&&!material){material=true;return use(take,'玩家当前亲见可拿取的材料，争取可共同核验的资源')}
    }
    const rivalHere=view.scene?.recipients.some(actor=>actor.id==='character:rival')===true
    const heardMaterials=view.history.some(line=>!line.player&&line.speaker.includes('塞维恩')
      &&line.text.includes('材料')&&['手中','收存','保存','备齐','齐备','身上'].some(word=>line.text.includes(word)))
    if(rivalHere&&heardMaterials&&counterRequests<2) {
      counterRequests++
      const text=here ? (counterRequests===1
        ?'塞维恩，你说已经保管了材料。请让伊蕾亲自核验，并把一份材料真正交由她保管，让我们共同核对原文和风险。保管材料不等于获得她的治疗授权。'
        :'伊蕾，我支持你亲自掌握证据和材料。塞维恩，如果你愿意合作，请实际交付一份材料；我们会依据交付结果与你的说明共同商量，不能只凭口头保证。')
        : (counterRequests===1
          ?'塞维恩，你说材料已经备齐。伊蕾此刻不在这里，我们可以先核验材料，并请你把一份实际交给我保管。我会与她共同核对原文和风险，治疗仍由她自主决定。'
          :'塞维恩，我请求共同保管一份材料，不是替伊蕾作治疗决定。你可以说明顾虑或拒绝；如果愿意合作，请实际交付，我们见到她后再共同商量。')
      return {input:command('speak',{text,scope:'scene_public',addresseeIds:[]}),
        basis:'仅依据玩家已听到的材料保管说法，与当前在场塞维恩请求核验/交付；按伊蕾是否在场选择接收对象，不替 NPC 决定或执行'}
    }
    if(!here||!material) {
      const route=['location:church','location:archive','location:inn']
      const destination=route[visits++%route.length]
      const move=view.actions.find(option=>option.id==='move:'+destination)
      if(move)return use(move,'在玩家授权地图中循序寻找伊蕾或材料；没有使用她的场外位置')
    }
    return {input:command('speak',{text:'我希望我们核实已见到的证据和材料，你愿意如何继续？',scope:here?'direct':'self',addresseeIds:here?['character:priestess']:[]}),basis:here?'只向现场伊蕾询问自主意见':'无人可会面时自语，不假定场外接收'}
  }
}
async function run() {
  buildNextPacks()
  const args = process.argv.slice(2), selected = args.find(arg => arg.startsWith('--case='))?.slice(7)
  if (args.some(arg => !arg.startsWith('--case=')) || (selected && !['D1','D2','D3','E'].includes(selected)))
    throw new TypeError('用法：node --import tsx tests/experiments/hidden-cure-next.ts [--case=D1|D2|D3|E]；只调用真实模型')
  const root = resolve('output/hidden-cure-next'); mkdirSync(root, {recursive: true})
  const directory = mkdtempSync(join(root, 'live-'))
  const model = 'gemini-3.8-flash', endpoint = 'http://127.0.0.1:8045/v1/chat/completions'
  const results: Record<string, unknown>[] = []
  for (const name of (selected ? [selected] : ['D1','D2','D3']) as (keyof typeof goals)[]) {
    const packPath=join(nextRoot,name)
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
          input, schema:object(object(array(wire.tools)[0]).function).parameters, generation:{temperature:wire.temperature,max_tokens:wire.max_tokens,reasoning_effort:wire.reasoning_effort}, startedAt: new Date().toISOString()}
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
    const meta = {name, model, thinkingLevel: 'low', settings, packPath, goal: goals[name], roundsPlanned:name==='E'?12:8,
      playerPolicy:name==='E'?'authorized-material-counter-v3':'predeclared-self-speech',
      memoryMode: 'native', dynamicScheduling: true, activity: false, variables: false, authorEvidenceOnly: true}
    try {
      const setup = name==='D3'||name==='E' ? await prepareTakenRecord(packPath,join(caseDir,'world')) : []
      runtime = await FrozenWorldPlaytestRuntime.create({dataDirectory: join(caseDir, 'world'), packPath, provider: 'local', model,
        thinkingLevel: 'low', utilityEndpoint: `http://127.0.0.1:${(server.address() as {port:number}).port}/v1/chat/completions`,
        timeoutMs: 60000, playSettings: settings})
      const initial = snapshot(runtime)
      persist({meta, setup, initial, rounds, calls})
      let playerState=await runtime.state()
      const policy=createEPolicy()
      for (let index=0;index<(name==='E'?12:8);index++) {
        const playerView=projectPlayerView(playerState)
        const choice=name==='E'?policy(playerView):{input:command('speak',{text:`我在旅馆整理调查笔记，第${index+1}段。`,scope:'self',addresseeIds:[]}),basis:'预定的玩家自语，仅推进自主机会'}
        const playerInput=choice.input
        round++; const started = performance.now(), before = snapshot(runtime), beforeCall = calls.length
        const state = await runtime.submit(playerInput), after = snapshot(runtime)
        playerState=state
        const row = {round, playerInput, playerDecision:{view:playerView,basis:choice.basis}, playerView:projectPlayerView(state), entities:entityStates(runtime), elapsedMs: Math.round(performance.now() - started),
          calls: [beforeCall, calls.length], newEvents: after.events.filter(event => event.seq > before.seq),
          newActions: after.actions.filter(action => action.seq > before.seq), views: after.views,
          record: after.record, locations: after.locations, integrity: after.integrity,
          playerTranscript: state.transcript, error: state.error, notice: state.notice, debug: state.debug}
        rounds.push(row); persist({meta, setup, initial, rounds, calls, final: after, finalEntities:entityStates(runtime)})
        process.stdout.write(JSON.stringify({case:name, round, calls:calls.length-beforeCall, elapsedMs:row.elapsedMs,
          record:after.record, locations:after.locations, error:state.error, notice:state.notice})+'\n')
        // A failed NPC response does not undo the committed player turn. Continue the predeclared inputs; never retry NPC choices.
      }
      const elapsedMs = rounds.reduce((sum, row) => sum + Number(row.elapsedMs), 0)
      const sum = (key: string) => calls.reduce((n, call) => n + Number(object(call.usage)[key] ?? 0), 0)
      const summary = {name, rounds:rounds.length, calls:calls.length, elapsedMs,
        inputTokens:sum('prompt_tokens'), outputTokens:sum('completion_tokens'), totalTokens:sum('total_tokens'),
        callsWithUsage:calls.filter(call=>call.usage!==undefined).length,
        errorRounds:rounds.filter(row=>row.error).map(row=>row.round), finalEntities:entityStates(runtime), finalRecord:snapshot(runtime).record}
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
