/** Real gateway smoke through the same HTTP entry points as the browser. Fresh data only. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import type { WorldJsonObject } from '@harness-world/contracts'
import { FrozenWorldPlaytestRuntime } from './playtest-frozen-runtime.ts'
import { createPlaytestServer } from './playtest-server.ts'
import { DEFAULT_PLAYTEST_TUNING } from './playtest-tuning.ts'

const root=resolve(process.argv[2]??'')
if(!process.argv[2]||existsSync(root))throw new Error('provide a fresh output directory')
mkdirSync(root,{recursive:true})
const dataDirectory=join(root,'data'),token=randomBytes(32).toString('hex')
process.env.HCW_HINDSIGHT_UTILITY_TRACE=join(root,'utility-calls.jsonl')
const options={dataDirectory,packPath:resolve('examples/world-packs/ai-girls-hosted-guess'),provider:'local' as const,
  model:'gemini-3.7-flash',memoryCore:true,tuning:{...DEFAULT_PLAYTEST_TUNING,reactionDeadlineSeconds:120},
  ...(process.env.HCW_LOCAL_API_KEY?{apiKey:process.env.HCW_LOCAL_API_KEY}:{})}
let runtime=await FrozenWorldPlaytestRuntime.create(options),server=createPlaytestServer(runtime,token)
const steps:unknown[]=[]
async function listen(){server.listen(0,'127.0.0.1');await once(server,'listening')}
await listen()
async function api(path:string,payload?:unknown){
 const address=server.address();if(!address||typeof address==='string')throw new Error('no port')
 const response=await fetch(`http://127.0.0.1:${address.port}`+path,{method:payload===undefined?'GET':'POST',
  headers:{'x-playtest-token':token,'content-type':'application/json'},
  ...(payload===undefined?{}:{body:JSON.stringify(payload)}),signal:AbortSignal.timeout(650000)})
 const state=await response.json() as WorldJsonObject
 steps.push({path,status:response.status,state});writeFileSync(join(root,'steps.json'),JSON.stringify(steps,null,2))
 if(!response.ok)throw new Error('HTTP '+response.status)
 console.log(JSON.stringify({path,status:response.status,headSeq:(state.debug as WorldJsonObject)?.headSeq}))
 return state
}
async function close(){await new Promise<void>(done=>server.close(()=>done()));await runtime.close()}
try{
 const html=await fetch(`http://127.0.0.1:${(server.address() as {port:number}).port}/`).then(r=>r.text())
 if(!html.includes('整理长期记忆'))throw new Error('host memory control missing')
 await api('/api/submit',{text:'早上好，我们先在这里歇一会儿吧。'})
 let state=await api('/api/state')
 const command=async(operation:string,parameters:WorldJsonObject={})=>{
  const activity=state.activity as WorldJsonObject
  state=await api('/api/activity',{activityId:operation==='start'?null:activity.id,revision:operation==='start'?0:activity.revision,
   operation,parameters,requestId:randomUUID()})
 }
 await command('start')
 try{await command('guess',{value:50})}catch{state=await api('/api/state')}
 state=await api('/api/escape',{})
 const before=Number((state.debug as WorldJsonObject).headSeq)
 let last=''
 const progress=setInterval(()=>{void runtime.state().then(s=>{const maintenance=JSON.stringify(s.memoryMaintenance);if(maintenance!==last){last=maintenance;console.log(JSON.stringify({maintenance:s.memoryMaintenance}))}})},2000)
 try{state=await api('/api/memory/refresh',{});await runtime.waitForMemory();state=await runtime.state() as unknown as WorldJsonObject
  if(Number((state.memoryMaintenance as WorldJsonObject)?.failed)>0)throw new Error('background maintenance failed')
 }finally{clearInterval(progress)}
 if(Number((state.debug as WorldJsonObject).headSeq)!==before)throw new Error('maintenance committed world events')
 await api('/api/submit',{text:'刚才那局猜数字是怎么结束的？接下来你想做什么？'})
 await close()
 runtime=await FrozenWorldPlaytestRuntime.create(options);server=createPlaytestServer(runtime,token);await listen()
 state=await api('/api/submit',{text:'我们接着聊吧，刚才那局已经结束了。'})
 const traces=readFileSync(join(dataDirectory,'memory-core/recall-trace.jsonl'),'utf8').trim().split('\n').map(s=>JSON.parse(s))
 const models=readFileSync(join(dataDirectory,'memory-core/model-trace.jsonl'),'utf8').trim().split('\n').map(s=>JSON.parse(s))
 const utility=readFileSync(join(root,'utility-calls.jsonl'),'utf8').trim().split('\n').map(s=>JSON.parse(s))
 const summary={completed:true,model:'gemini-3.7-flash',modelReturns:models.length,utilityCalls:utility.length,
  indexedRecallCalls:traces.filter(t=>t.status==='core').length,nonempty:traces.filter(t=>t.result?.delivery?.length).length,
  maintenanceWorldPrefixUnchanged:true,restartSucceeded:true,finalState:state}
 writeFileSync(join(root,'summary.json'),JSON.stringify(summary,null,2))
 console.log(JSON.stringify({...summary,finalState:undefined}))
}catch(error){writeFileSync(join(root,'failure.json'),JSON.stringify({error:error instanceof Error?error.message:String(error)},null,2));throw error}
finally{await close()}
