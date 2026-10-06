/** Normal HTTP playtest, real provider, manual Memory refresh; no forced cognition or replayed choices. */
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { WorldJsonObject } from '@harness-world/contracts'
import { WorldStore } from '@harness-world/store-sqlite'
import { FrozenWorldPlaytestRuntime } from './playtest-frozen-runtime.ts'
import { createPlaytestServer } from './playtest-server.ts'
import { coreRunner } from './hindsight-python.ts'
const root = resolve(process.argv[2] ?? '')
if (!process.argv[2] || existsSync(root)) throw new Error('specify a new data directory')
mkdirSync(root, { recursive:true })
const save = (name:string, value:unknown) => writeFileSync(join(root,name),JSON.stringify(value,null,2))
const claims = ['我听看守说，桌上的黄铜钥匙能开后室柜子，不过他自己也没试过。',
  '另一位访客却说，这把黄铜钥匙是前室抽屉的钥匙；他也没有实际试过。我们先记着两种说法。']
const gaps = ['我今天换了件灰色外套，你觉得怎么样？','我在家种了一盆薄荷，最近长得挺快。',
  '昨晚电影的配乐很好听。','周末想试着烤最普通的面包。','这支笔写起来挺顺手。',
  '你们喜欢安静一点的音乐吗？','家里的窗帘该洗了，我回去再处理。','晚饭想做得简单一点，你们喜欢什么口味？']
const question = '回到这把黄铜钥匙，你现在觉得它有什么用？哪些事情已经确认了？'
const model = 'gemini-3.7-flash'
const tuning = { maximumWaves:1, maximumNpcCalls:2, maximumCallsPerCharacter:1,
  reactionDeadlineSeconds:90, recentObservations:4, recentSelfObservations:4 }
save('protocol.json',{ phase:'6.5',model,pack:'examples/world-packs/prototype-g1',claims,gaps,question,tuning,
  paths:['normal HTTP submit','manual refresh','candidate ID admission','minimal Delivery'],
  controls:['existing pack and normal runtime; real Source commits; no seeded cognition',
    'no JEV or native memory in Core mode; no selective retries; response failures retained'],
  limits:['one continuous trajectory, no randomized control; page UI not automated',
    'manual refresh rebuilds generic observations; no known-family lineage update in this path'] })
const run = coreRunner({HCW_LOCAL_MODEL:model,HCW_HINDSIGHT_UTILITY_TRACE:join(root,'utility.jsonl')})
const measuredRun: import('./hindsight-python.ts').CoreRunner = async(input,signal)=>{
    const start=performance.now(), result=await run(input,signal)
    const path=join(root,'bridge.jsonl')
    const {appendFileSync}=await import('node:fs')
    appendFileSync(path,JSON.stringify({input,result,durationMs:performance.now()-start})+'\n')
    return result
}
const runtime = await FrozenWorldPlaytestRuntime.create({ dataDirectory:root,
  packPath:resolve('examples/world-packs/prototype-g1'),provider:'local',model,
  ...(process.env.HCW_LOCAL_ENDPOINT ? { utilityEndpoint:process.env.HCW_LOCAL_ENDPOINT } : {}),
  ...(process.env.HCW_LOCAL_API_KEY ? { apiKey:process.env.HCW_LOCAL_API_KEY } : {}),
  timeoutMs:90000,tuning,memoryCore:true,memoryCoreRun:measuredRun,memoryCoreBuildRun:measuredRun })
const token=randomBytes(32).toString('hex'), server=createPlaytestServer(runtime,token)
server.listen(0,'127.0.0.1'); await once(server,'listening')
const address=server.address();if(!address || typeof address==='string')throw new Error('no HTTP port')
const base='http://127.0.0.1:'+address.port
const head=()=>{ const store=new WorldStore(join(root,'world.sqlite'))
  try{return store.head(runtime.address)}finally{store.close()} }
const stages:unknown[]=[]
let index=0, failed=false
async function stage(label:string,text?:string) {
  const before=head(),start=performance.now()
  const response=await fetch(base+(text===undefined?'/api/memory/refresh':'/api/submit'),{
    method:'POST',headers:{'x-playtest-token':token,'content-type':'application/json'},
    ...(text===undefined?{}:{body:JSON.stringify({text})}), signal:AbortSignal.timeout(650000) })
  let state=await response.json() as WorldJsonObject
  const requestDurationMs=performance.now()-start
  // This diagnostic intentionally waits to compare archived results; the player HTTP request does not.
  if(text===undefined && response.ok) { await runtime.waitForMemory(); state=await runtime.state() as unknown as WorldJsonObject }
  const after=head(),row={index:index++,label,text:text??null,status:response.status,
    before,after,requestDurationMs,durationMs:performance.now()-start,state}
  stages.push(row);save('stages.json',stages)
  if (text===undefined && before.headSeq!==after.headSeq) throw new Error('refresh changed authoritative world prefix')
  console.log(JSON.stringify({label,status:response.status,headSeq:after.headSeq,error:state.error,
    npcMessages:(state.transcript as WorldJsonObject[]|undefined)?.filter(r=>!r.player&&Number(r.seq)>before.headSeq).length}))
  if (!response.ok || state.error===true || (text===undefined && Number((state.memoryMaintenance as WorldJsonObject)?.failed)>0)) { failed=true;throw new Error('recorded stage failed; no automatic replay') }
}
try {
  save('initial-state.json',await runtime.state())
  for(const [i,text]of claims.entries())await stage('claim-'+i,text)
  await stage('refresh-initial')
  // Freeze actual natural archive before the long gap, without injecting or altering it.
  for(const actor of ['character:companion','character:friend']) {
    const name=Buffer.from(actor).toString('base64url')+'.json'
    writeFileSync(join(root,'initial-'+name),readFileSync(join(root,'memory-core',name)))
  }
  for(const [i,text]of gaps.entries())await stage('gap-'+i,text)
  await stage('delayed-question',question)
  await stage('refresh-after-question')
  await stage('question-after-refresh',question)
} catch(error) {
  save('failure.json',{message:String(error),stagesCompleted:stages.length});failed=true
} finally {
  save('final-state.json',await runtime.state())
  const store=new WorldStore(join(root,'world.sqlite'))
  try{save('events.json',store.readEvents(runtime.address))}finally{store.close()}
  await runtime.close();await new Promise<void>((done,reject)=>server.close(error=>error?reject(error):done()))
  save('summary.json',{phase:'6.5',completed:!failed,stages:stages.length,address:runtime.address})
}
if(failed)process.exitCode=1
