import { spawn } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { WorldStore } from '@harness-world/store-sqlite'
import { currentEntityState } from '@harness-world/kernel'
import type { WorldJsonObject } from '@harness-world/contracts'
import { FrozenWorldPlaytestRuntime } from '../experiments/playtest-frozen-runtime.ts'
import type { CoreRunner } from '../experiments/hindsight-python.ts'
import { readTailSelection } from '../../desktop/tail-storage.ts'
import { readStoryNodes } from '../../desktop/story-nodes.ts'
import { preflightSave } from '../../desktop/save-preflight.ts'
import { FrontendActions, projectPlayerView, playerViewPatch } from '../../packages/frontend/src/player-view.ts'

const roots: string[] = [], servers: Server[] = [], runtimes: FrozenWorldPlaytestRuntime[] = []
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close()
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(done=>server.close(()=>done())) }
  for (const root of roots.splice(0)) rmSync(root,{recursive:true,force:true})
})
const object = (value: unknown) => value as WorldJsonObject
const built = (input: WorldJsonObject): WorldJsonObject => ({
  archive:{scope:input.scope!,sources:input.sources!,facts:[],episodes:[],observations:[]},
  index:{scope:input.scope!,units:[],vectors:[]},
})
const empty = {delivery:[],deliveryTrace:{delivered:[],activityCoverage:[]}}
async function fixture(core = false, build?: CoreRunner) {
  const root = mkdtempSync(join(tmpdir(),'tail-round-')); roots.push(root)
  const pack=join(root,'pack'),data=join(root,'data')
  cpSync(resolve('examples/world-packs/prototype-g1'),pack,{recursive:true})
  mkdirSync(join(pack,'scripts'))
  cpSync(resolve('examples/world-packs/ai-girls-awaken-v10/scripts/variables.js'),join(pack,'scripts/variables.js'))
  writeFileSync(join(pack,'scripts/activity.js'),readFileSync(resolve('examples/world-packs/ai-girls-awaken-v10/scripts/activity.js'),'utf8').replaceAll('character:gpt','character:companion'))
  const source=JSON.parse(readFileSync(join(pack,'worldpack.source.json'),'utf8'))
  source.assetFiles=['scripts/variables.js','scripts/activity.js']
  writeFileSync(join(pack,'worldpack.source.json'),JSON.stringify(source))
  let decide: (input: WorldJsonObject) => unknown | Promise<unknown> = () => ({decision:'abstain'})
  const requests: WorldJsonObject[] = [], memoryRequests: WorldJsonObject[] = []
  const server=createServer((request,response)=>{
    let body='';request.on('data',chunk=>{body+=String(chunk)})
    request.on('end',()=>{void(async()=>{
      const wire=JSON.parse(body),input=JSON.parse(wire.messages.at(-1).content) as WorldJsonObject
      requests.push(input)
      try {
        const output=await decide(input)
        response.writeHead(200,{'content-type':'application/json'})
        response.end(JSON.stringify(core ? {choices:[{message:{content:JSON.stringify(output)}}]} : {message:{content:JSON.stringify(output)}}))
      } catch { response.writeHead(503);response.end('fixture unavailable') }
    })()})
  })
  servers.push(server);await new Promise<void>(done=>server.listen(0,'127.0.0.1',done))
  const run:CoreRunner=async(input,signal)=>{memoryRequests.push(input);return input.operation==='build' ? build ? build(input,signal) : built(input) : empty}
  const options={dataDirectory:data,packPath:pack,provider:core?'local' as const:'ollama' as const,model:'fixture',
    utilityEndpoint:'http://127.0.0.1:'+(server.address() as {port:number}).port+'/v1/chat/completions',timeoutMs:5000,
    ...(core?{memoryCore:true,memoryCoreRun:run,memoryCoreBuildRun:run}:{})}
  const create=async()=>{const runtime=await FrozenWorldPlaytestRuntime.create(options);runtimes.push(runtime);return runtime}
  const runtime=await create()
  const events=(directory=runtime.dataDirectory)=>{const store=new WorldStore(join(directory,'world.sqlite'));try{return store.readEvents(runtime.address)}finally{store.close()}}
  return {root,data,pack,options,runtime,create,events,requests,memoryRequests,setDecision:(fn:typeof decide)=>{decide=fn}}
}
function take() {
  return {decision:'perform',actionType:'interact',parameters:{targetRef:{kind:'entity',id:'entity:brass-key'},bindingId:'binding:key-take',
    definitionRef:{id:'base:take',version:1},arguments:{}}}
}
const actor=(input:WorldJsonObject)=>String(object(object(input.context).character).characterId)
const tail=async(runtime:FrozenWorldPlaytestRuntime)=>(await runtime.state()).tailRound!.id!
const regenerate=async(runtime:FrozenWorldPlaytestRuntime)=>runtime.regenerate(await tail(runtime),randomUUID())

it('replaces all effects of the tail, keeps the old result, repeats from one base and survives reopen',async()=>{
  const f=await fixture(),runtime=f.runtime
  f.setDecision(input=>actor(input)==='character:companion' ? input.continuation ? { decision:'publish', segments: [{ type: 'speech', text: '旧回合独有暗号紫檀四号。' }] } : take() : {decision:'abstain'})
  const old=await runtime.submit('请看看钥匙。')
  expect(old.tailRound?.canRegenerate).toBe(true)
  const original=JSON.stringify(f.events()),base=readTailSelection(f.data)!.tail!.base
  expect(currentEntityState(f.events(),'entity:brass-key')?.holderId).toBe('character:companion')
  f.requests.length=0;f.setDecision(()=>({decision:'abstain'}))
  const next=await regenerate(runtime)
  expect(next.transcript.some(line=>line.text.includes('紫檀四号'))).toBe(false)
  expect(currentEntityState(f.events(),'entity:brass-key')?.holderId).toBe(null)
  expect(JSON.stringify(f.events(f.data))).toBe(original)
  expect(JSON.stringify(f.requests)).not.toContain('紫檀四号')
  expect(next.tailRound!.worldVersion).not.toBe(old.tailRound!.worldVersion)
  expect(readTailSelection(f.data)!.tail!.base).toBe(base)
  expect(playerViewPatch(projectPlayerView(old),projectPlayerView(next))).toHaveProperty('history')
  await regenerate(runtime)
  expect(readTailSelection(f.data)!.tail!.base).toBe(base)
  await expect(preflightSave(f.pack,f.data)).resolves.toMatchObject({kind:'resume'})
  const node=await runtime.saveNode('重新生成后的节点')
  expect(readStoryNodes(f.data).some(n=>n.id===node.id)).toBe(true)
  await runtime.close()
  const reopened=await f.create()
  expect((await reopened.state()).transcript).toEqual((await runtime.state()).transcript)
  expect(reopened.dataDirectory).toBe(runtime.dataDirectory)
  const oldId=await tail(reopened)
  await reopened.submit('继续。')
  await expect(reopened.regenerate(oldId,randomUUID())).rejects.toThrow('末端')
},30_000)

it('retains exactly the starting long-term archives while new candidate observations reach later roles',async()=>{
  const f=await fixture(true)
  await f.runtime.refreshMemory();await f.runtime.waitForMemory()
  const archiveNames=readdirSync(join(f.data,'memory-core')).filter(name=>name.endsWith('.json'))
  const starting=Object.fromEntries(archiveNames.map(name=>[name,readFileSync(join(f.data,'memory-core',name),'utf8')]))
  f.setDecision(input=>actor(input)==='character:companion'&&!input.continuation?{ decision:'publish', segments: [{ type: 'speech', text: '将被替换的旧暗号。' }] }:{decision:'abstain'})
  await f.runtime.submit('说一句话。')
  await f.runtime.refreshMemory();await f.runtime.waitForMemory() // original future cognition must not be copied
  f.requests.length=0;f.memoryRequests.length=0
  f.setDecision(input=>actor(input)==='character:companion'&&!input.continuation?{ decision:'publish', segments: [{ type: 'speech', text: '候选新暗号青松七号。' }] }:{decision:'abstain'})
  await regenerate(f.runtime)
  expect(Object.fromEntries(archiveNames.map(name=>[name,readFileSync(join(f.runtime.dataDirectory,'memory-core',name),'utf8')]))).toEqual(starting)
  expect(JSON.stringify(f.requests)).not.toContain('将被替换的旧暗号')
  const later=f.requests.filter(input=>actor(input)==='character:friend')
  expect(JSON.stringify(later)).toContain('青松七号')
  expect(f.memoryRequests.filter(i=>i.operation==='build')).toHaveLength(0)
  for(const input of f.memoryRequests.filter(i=>i.operation==='recall')) {
    expect(JSON.stringify(input.archive)).not.toContain('将被替换的旧暗号')
    expect(object(object(input.archive).scope).characterId).toBe(object(object(object(input.request).context).character).characterId)
  }
},30_000)

it('keeps a failed or cancelled candidate invisible, prevents concurrent writers and only completes after settlement',async()=>{
  const f=await fixture()
  await f.runtime.submit('原回合。')
  const before=JSON.stringify(f.events()),selection=readFileSync(join(f.data,'current-world.json'),'utf8')
  await expect(f.create()).rejects.toThrow('可写运行实例')
  f.setDecision(()=>{throw new Error('unavailable')})
  await expect(regenerate(f.runtime)).rejects.toThrow('原结果保留')
  expect(JSON.stringify(f.events())).toBe(before)
  expect(readFileSync(join(f.data,'current-world.json'),'utf8')).toBe(selection)
  let entered!:()=>void,release!:()=>void
  const waiting=new Promise<void>(done=>{entered=done}),gate=new Promise<void>(done=>{release=done})
  f.setDecision(async()=>{entered();await gate;return { decision:'publish', segments: [{ type: 'speech', text: '不得安装的候选。' }] }})
  const work=regenerate(f.runtime),outcome=work.catch(e=>e)
  await waiting
  expect((await f.runtime.state()).tailRound!.canRegenerate).toBe(false)
  expect(JSON.stringify(await f.runtime.state())).not.toContain('不得安装')
  await expect(f.runtime.submit('抢写')).rejects.toThrow('等待')
  await expect(f.runtime.saveNode('候选节点')).rejects.toThrow('等待')
  await f.runtime.cancelRegeneration();release()
  expect(await outcome).toBeInstanceOf(Error)
  expect((await outcome).message).toContain('取消')
  expect(JSON.stringify(f.events())).toBe(before)
  expect(readFileSync(join(f.data,'current-world.json'),'utf8')).toBe(selection)
},30_000)

it('replays activity initialization through permissions with identical randomness and restores variables',async()=>{
  const f=await fixture(),state=await f.runtime.state()
  const started=await f.runtime.activityAction({activityId:null,revision:0,operation:'start',parameters:{},requestId:randomUUID()})
  const activity=object(f.events().findLast(e=>e.eventType==='activity.updated')!.data).state
  const answer=object(object(object(activity).game).internal).answer
  await regenerate(f.runtime)
  const replay=object(f.events().findLast(e=>e.eventType==='activity.updated')!.data).state
  expect(object(object(object(replay).game).internal).answer).toBe(answer)
  expect((await f.runtime.state()).activity?.revision).toBe(started.activity?.revision)
  expect((await f.runtime.state()).packVariables).toEqual(state.packVariables)
  await expect(f.runtime.activityAction({activityId:null,revision:0,operation:'start',parameters:{},requestId:randomUUID()})).rejects.toThrow('失效')
},30_000)

it('rejects changed scripts and corrupt snapshots before modifying the current world',async()=>{
  const f=await fixture()
  await f.runtime.submit('世界起点。')
  const before=JSON.stringify(f.events()),file=join(f.pack,'scripts/activity.js'),script=readFileSync(file,'utf8')
  writeFileSync(file,script+'\n// changed script')
  await expect(regenerate(f.runtime)).rejects.toThrow('环境')
  writeFileSync(file,script)
  const selection=readTailSelection(f.data)!
  writeFileSync(join(f.data,'.tail','bases',selection.tail!.base,'pack-variables.json'),'{}')
  await expect(regenerate(f.runtime)).rejects.toThrow('损坏')
  expect(JSON.stringify(f.events())).toBe(before)
},20_000)

it('deduplicates regeneration and does not return an old history after a world replacement',async()=>{
  const f=await fixture(),actions=new FrontendActions(f.runtime)
  await actions.perform({requestId:'req:1',actionId:'action:original',operation:'speak',payload:{text:'原输入。'}})
  const tailId=await tail(f.runtime),requestId=randomUUID()
  const [a,b]=await Promise.all([f.runtime.regenerate(tailId,requestId),f.runtime.regenerate(tailId,requestId)])
  expect(a.tailRound).toEqual(b.tailRound)
  expect(readTailSelection(f.data)!.version).toBe(a.tailRound!.worldVersion)
  const retry=await actions.perform({requestId:'req:retry',actionId:'action:original',operation:'speak',payload:{text:'原输入。'}})
  expect(retry.tailRound!.worldVersion).toBe(a.tailRound!.worldVersion)
  for(const name of ['world.sqlite','memory.sqlite','session.sqlite','context.sqlite']) {
    const db=new DatabaseSync(join(f.runtime.dataDirectory,name),{readOnly:true})
    try{expect(db.prepare('PRAGMA integrity_check').get()).toEqual({integrity_check:'ok'})}finally{db.close()}
  }
},30_000)

it('does not install a completed background archive during a round and discards results from an expired version',async()=>{
  let releaseBuild!:()=>void, buildEntered!:()=>void
  const buildGate=new Promise<void>(done=>{releaseBuild=done}),buildStarted=new Promise<void>(done=>{buildEntered=done})
  const f=await fixture(true,async input=>{buildEntered();await buildGate;return built(input)})
  await f.runtime.refreshMemory();await buildStarted
  let releaseModel!:()=>void,modelEntered!:()=>void
  const modelGate=new Promise<void>(done=>{releaseModel=done}),modelStarted=new Promise<void>(done=>{modelEntered=done})
  f.setDecision(async()=>{modelEntered();await modelGate;return {decision:'abstain'}})
  const work=f.runtime.submit('固定长期档案。')
  await modelStarted;releaseBuild()
  await new Promise<void>(done=>setTimeout(done,30))
  expect(readdirSync(join(f.data,'memory-core')).filter(n=>n.endsWith('.json'))).toEqual([])
  releaseModel();await work;await f.runtime.waitForMemory()
  expect(readdirSync(join(f.data,'memory-core')).filter(n=>n.endsWith('.json'))).toHaveLength(2)

  const {PlaytestMemoryCore}=await import('../experiments/playtest-memory-core.ts')
  let valid=true,releaseExpired!:()=>void,expiredEntered!:()=>void
  const expiredGate=new Promise<void>(done=>{releaseExpired=done}),expiredStarted=new Promise<void>(done=>{expiredEntered=done})
  await f.runtime.submit('更新前缀。')
  const prior=readFileSync(join(f.data,'memory-core',Buffer.from('character:companion').toString('base64url')+'.json'),'utf8')
  const adapter=new PlaytestMemoryCore(f.data,f.runtime.address,async input=>{expiredEntered();await expiredGate;return built(input)},
    undefined,{worldVersion:'retired-world',versionValid:()=>valid})
  adapter.startRefresh(['character:companion']);await expiredStarted
  valid=false;releaseExpired();await adapter.waitForBackground()
  expect(readFileSync(join(f.data,'memory-core',Buffer.from('character:companion').toString('base64url')+'.json'),'utf8')).toBe(prior)
  expect(adapter.backgroundState().failed).toBe(1)
  await adapter.close()
},30_000)

for(const phase of ['candidate-copy','switch-before','switch-after','select-before','select-after']) {
  it('recovers a complete selected result after forced process termination at '+phase,async()=>{
    const f=await fixture()
    f.setDecision(()=>({ decision:'publish', segments: [{ type: 'speech', text: '原结果紫檀四号。' }] }))
    await f.runtime.submit('相同输入。')
    const original=JSON.stringify(f.events())
    f.setDecision(()=>({ decision:'publish', segments: [{ type: 'speech', text: '新结果青松七号。' }] }))
    if(phase.startsWith('select-'))await regenerate(f.runtime)
    const oldId=await tail(f.runtime),oldVersion=(await f.runtime.state()).tailRound!.worldVersion
    const candidateId=phase.startsWith('select-')?(await f.runtime.state()).tailRound!.candidateIds![0]:undefined
    await f.runtime.close()
    const child=spawn(process.execPath,['--import','tsx','tests/experiments/tail-crash-worker.ts',JSON.stringify({
      phase,dataDirectory:f.data,packPath:f.pack,endpoint:f.options.utilityEndpoint,tailId:oldId,candidateId,
    })],{cwd:resolve('.'),windowsHide:true,stdio:['ignore','pipe','pipe']})
    let output='',errors=''
    try {
      await new Promise<void>((done,reject)=>{
        const timer=setTimeout(()=>reject(new Error('fault point timeout '+output+errors)),20_000)
        child.stdout!.on('data',chunk=>{output+=String(chunk);if(output.includes('CRASH_POINT ')){clearTimeout(timer);done()}})
        child.stderr!.on('data',chunk=>{errors+=String(chunk)})
        child.once('exit',()=>{clearTimeout(timer);reject(new Error('worker ended early '+errors))})
      })
    } finally {
      if(child.exitCode===null&&child.signalCode===null) {
        const exited=new Promise<void>(done=>child.once('exit',()=>done()))
        if(process.platform==='win32'){
          const killer=spawn('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'})
          await new Promise<void>((done,reject)=>{killer.once('error',reject);killer.once('exit',code=>code===0?done():reject(new Error('taskkill failed')))})
        }else child.kill('SIGKILL')
        await exited
      }
    }
    expect(JSON.stringify(f.events(f.data))).toBe(original)
    const reopened=await f.create(),state=await reopened.state()
    expect(state.tailRound!.worldVersion===oldVersion).toBe(!phase.endsWith('after'))
    const newResult=phase==='switch-after'||phase==='select-before'
    expect(JSON.stringify(state.transcript)).toContain(newResult?'青松七号':'紫檀四号')
    expect(JSON.stringify(state.transcript)).not.toContain(newResult?'紫檀四号':'青松七号')
    for(const name of ['world.sqlite','memory.sqlite','session.sqlite','context.sqlite']){
      const db=new DatabaseSync(join(reopened.dataDirectory,name),{readOnly:true})
      try{expect(db.prepare('PRAGMA integrity_check').get()).toEqual({integrity_check:'ok'})}finally{db.close()}
    }
    await regenerate(reopened)
    expect((await reopened.state()).tailRound!.canRegenerate).toBe(true)
  },30_000)
}

it('preserves private observation boundaries in candidate contexts and refuses an unfinished critical settlement',async()=>{
  const f=await fixture(true)
  await f.runtime.submit('/act speak '+JSON.stringify({text:'私语标记银杏电台。',scope:'direct',addresseeIds:['character:companion']}))
  await f.runtime.submit('大家继续。')
  f.requests.length=0
  await regenerate(f.runtime)
  const friend=f.requests.filter(input=>actor(input)==='character:friend')
  const companion=f.requests.filter(input=>actor(input)==='character:companion')
  expect(JSON.stringify(friend)).not.toContain('银杏电台')
  expect(JSON.stringify(companion)).toContain('银杏电台')
  const {WorldApplication}=await import('@harness-world/application')
  const original=WorldApplication.prototype.deliver
  let settlements=0
  const spy=vi.spyOn(WorldApplication.prototype,'deliver').mockImplementation(function(this:InstanceType<typeof WorldApplication>,address,correlation){
    if(correlation==='tail-round:deliver'&&++settlements===3)throw new Error('critical delivery fixture failure')
    return original.call(this,address,correlation)
  })
  try{
    await expect(f.runtime.submit('结算失败。')).rejects.toThrow('critical delivery')
    expect((await f.runtime.state()).tailRound!.id).toBe(null)
  }finally{spy.mockRestore()}
},30_000)

it('keeps three full candidates, switches without model calls, survives restart and continues only the chosen future',async()=>{
  const f=await fixture(),runtime=f.runtime
  f.setDecision(input=>actor(input)==='character:companion' ? input.continuation ? { decision:'publish', segments: [{ type: 'speech', text: '原候选紫檀四号。' }] } : take() : {decision:'abstain'})
  const original=await runtime.submit('看一下钥匙。')
  f.setDecision(()=>({decision:'abstain'}));await regenerate(runtime)
  f.setDecision(input=>actor(input)==='character:companion'?{ decision:'publish', segments: [{ type: 'speech', text: '第三候选红雀石。' }] }:{decision:'abstain'})
  const third=await regenerate(runtime),ids=third.tailRound!.candidateIds!
  expect(ids).toHaveLength(3);expect(third.tailRound!.candidateIndex).toBe(3)
  const base=readTailSelection(f.data)!.tail!.base
  f.requests.length=0
  const requestId=randomUUID()
  const first=await runtime.selectCandidate(third.tailRound!.id!,ids[0]!,requestId)
  expect(first.tailRound!.candidateIndex).toBe(1)
  expect(first.tailRound!.worldVersion).not.toBe(original.tailRound!.worldVersion)
  expect(first.transcript).toEqual(original.transcript)
  expect(currentEntityState(f.events(),'entity:brass-key')?.holderId).toBe('character:companion')
  expect(f.requests).toHaveLength(0)
  expect(await runtime.selectCandidate(third.tailRound!.id!,ids[0]!,requestId)).toEqual(first)
  const second=await runtime.selectCandidate(first.tailRound!.id!,ids[1]!,randomUUID())
  expect(second.tailRound!.candidateIndex).toBe(2)
  expect(currentEntityState(f.events(),'entity:brass-key')?.holderId).toBe(null)
  expect(JSON.stringify(second.transcript)).not.toContain('紫檀四号')
  expect(f.requests).toHaveLength(0)
  await runtime.close()
  const reopened=await f.create(),saved=await reopened.state()
  expect(saved.tailRound!.candidateIds).toEqual(ids);expect(saved.tailRound!.candidateIndex).toBe(2)
  const chosen=await reopened.selectCandidate(saved.tailRound!.id!,ids[0]!,randomUUID())
  expect(readTailSelection(f.data)!.tail!.base).toBe(base)
  await regenerate(reopened)
  expect((await reopened.state()).tailRound!.candidateIds).toHaveLength(4)
  const fourth=await reopened.state()
  await reopened.selectCandidate(fourth.tailRound!.id!,ids[0]!,randomUUID())
  f.requests.length=0;f.setDecision(()=>({decision:'abstain'}))
  await reopened.submit('继续当前选择。')
  expect(JSON.stringify(f.requests)).toContain('紫檀四号')
  expect(JSON.stringify(f.requests)).not.toContain('红雀石')
  expect((await reopened.state()).tailRound!.candidateIds).toHaveLength(1)
  await expect(reopened.selectCandidate(chosen.tailRound!.id!,ids[2]!,randomUUID())).rejects.toThrow('末端')
},30_000)

it('rejects a foreign or changed candidate and preserves the selected world',async()=>{
  const f=await fixture()
  await f.runtime.submit('原输入。');await regenerate(f.runtime)
  const state=await f.runtime.state(),ids=state.tailRound!.candidateIds!
  await expect(f.runtime.selectCandidate(state.tailRound!.id!,randomUUID(),randomUUID())).rejects.toThrow('末端')
  const selection=readFileSync(join(f.data,'current-world.json'),'utf8')
  const db=new DatabaseSync(join(f.data,'world.sqlite'))
  try{db.prepare('UPDATE heads SET head_seq=head_seq+1').run()}finally{db.close()}
  await expect(f.runtime.selectCandidate(state.tailRound!.id!,ids[0]!,randomUUID())).rejects.toThrow('候选世界已改变')
  expect(readFileSync(join(f.data,'current-world.json'),'utf8')).toBe(selection)
  expect(f.runtime.dataDirectory).not.toBe(f.data)
},30_000)
