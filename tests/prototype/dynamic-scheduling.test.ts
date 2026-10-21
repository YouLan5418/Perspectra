import { createServer, type Server } from 'node:http'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { currentLocation } from '@harness-world/kernel'
import { WorldStore } from '@harness-world/store-sqlite'
import type { WorldJsonObject } from '@harness-world/contracts'
import { runPrototypeActivations } from '../../packages/application/src/prototype-activation-cycle.ts'
import { WorldHostRuntime } from '../../desktop/host/world-runtime.ts'
import { readTailSelection } from '../../desktop/tail-storage.ts'
import { FrontendActions, projectPlayerView } from '../../desktop/host/frontend-adapter.ts'
import { statusMarketWithoutRoundHook } from './fixtures/status-market-no-hook.ts'

const roots:string[]=[], servers:Server[]=[], runtimes:WorldHostRuntime[]=[], releases:(()=>void)[]=[]
afterEach(async()=>{
  for(const release of releases.splice(0))release()
  for(const runtime of runtimes.splice(0))await runtime.close()
  for(const server of servers.splice(0)){server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()))}
  for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true})
  vi.restoreAllMocks()
})
const object=(value:unknown)=>value as WorldJsonObject
const actor=(input:WorldJsonObject)=>String(object(object(input.context).character).characterId)
const publish=(text:string)=>({decision:'publish',segments:[{type:'speech',text}]})
const move=(locationId:string)=>({decision:'perform',actionType:'move',parameters:{locationId}})
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done});releases.push(resolve);return {promise,resolve}}
async function fixture(witness=false, serialScheduling=false, continueAfterPublish=false, status=false){
  const root=mkdtempSync(join(tmpdir(),'dynamic-scheduling-'));roots.push(root)
  const pack=join(root,'pack'),data=join(root,'data')
  cpSync(resolve('examples/world-packs/prototype-g1'),pack,{recursive:true})
  const characters=JSON.parse(readFileSync(join(pack,'characters.json'),'utf8'))
  for(const character of characters.characters)character.initialLocationId=character.characterId==='character:companion'?'location:front-room':'location:back-room'
  if(witness)characters.characters.push({...characters.characters[1],characterId:'character:witness',displayName:'目击者',interactionBindings:[]})
  writeFileSync(join(pack,'characters.json'),JSON.stringify(characters))
  const scenes=JSON.parse(readFileSync(join(pack,'scenes.json'),'utf8'))
  scenes.scenes[0].participantIds=['character:companion',...(witness?['character:witness']:[])]
  scenes.scenes[1].lifecycle='active';scenes.scenes[1].participantIds=['character:player','character:friend']
  writeFileSync(join(pack,'scenes.json'),JSON.stringify(scenes))
  if(status){
    mkdirSync(join(pack,'scripts'),{recursive:true});writeFileSync(join(pack,'scripts/status.js'),statusMarketWithoutRoundHook())
    const source=JSON.parse(readFileSync(join(pack,'worldpack.source.json'),'utf8'));source.assetFiles=['scripts/status.js']
    writeFileSync(join(pack,'worldpack.source.json'),JSON.stringify(source))
  }
  let decide:(input:WorldJsonObject)=>unknown|Promise<unknown>=()=>({decision:'abstain'})
  const requests:WorldJsonObject[]=[]
  const server=createServer((request,response)=>{
    let body='';request.on('data',chunk=>{body+=String(chunk)})
    request.on('end',()=>{void(async()=>{
      const wire=JSON.parse(body),input=JSON.parse(wire.messages.findLast((message:{role:string})=>message.role==='user').content) as WorldJsonObject
      requests.push(input)
      try{const output=await decide(input);if(!response.destroyed){response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify({message:{content:JSON.stringify(output)}}))}}
      catch{if(!response.destroyed){response.writeHead(503);response.end('fixture unavailable')}}
    })()})
  });servers.push(server);await new Promise<void>(done=>server.listen(0,'127.0.0.1',done))
  const runtime=await WorldHostRuntime.create({dataDirectory:data,packPath:pack,provider:'ollama',model:'fixture',
    utilityEndpoint:`http://127.0.0.1:${(server.address() as {port:number}).port}/api/chat`,timeoutMs:10000,serialScheduling,continueAfterPublish,
    tuning:{maximumWaves:3,maximumNpcCalls:12,maximumCallsPerCharacter:2,reactionDeadlineSeconds:30,recentObservations:16,recentSelfObservations:8}})
  runtimes.push(runtime)
  const events=()=>{const store=new WorldStore(join(runtime.dataDirectory,'world.sqlite'));try{return store.readEvents(runtime.address)}finally{store.close()}}
  return {root,data,runtime,requests,events,setDecision:(fn:typeof decide)=>{decide=fn}}
}
const enterFront='/act move {"locationId":"location:front-room"}'

it('continues the same host activation after speaking, refreshes its scene and counts every HTTP call',async()=>{
 const f=await fixture(false,false,true)
 let started=false
 f.setDecision(input=>{
  if(actor(input)!=='character:companion')return {decision:'abstain'}
  if(!started){started=true;return publish('我去后室看看。')}
  if(input.afterPublication)return move('location:back-room')
  return {decision:'abstain'}
 })
 const state=await f.runtime.submit(enterFront)
 expect(state.error).toBe(false)
 expect(currentLocation(f.events(),'character:companion')).toBe('location:back-room')
 expect(f.requests.some(input=>input.afterPublication===true)).toBe(true)
 expect(object(state.debug.activationCycle).calls).toBe(f.requests.length)
 expect(Number(object(state.debug.activationCycle).calls)).toBeLessThanOrEqual(12)
})

it.each([false,true])('repairs a normal role through the host with counted calls (serial=%s)',async serial=>{
  const f=await fixture(false,serial)
  let companionCalls=0
  f.setDecision(input=>actor(input)==='character:companion'
    ? ++companionCalls===1?{...publish('非法受众不应发表'),scope:'direct'}
      : companionCalls===2?publish('正常修正的回复'):{decision:'abstain'}
    : {decision:'abstain'})
  const state=await f.runtime.submit(enterFront)
  expect(state.error).toBe(false)
  expect(state.transcript.some(line=>line.text.includes('正常修正的回复'))).toBe(true)
  expect(state.transcript.some(line=>line.text.includes('非法受众不应发表'))).toBe(false)
  const cycle=object(state.debug.activationCycle)
  expect(cycle.calls).toBe(f.requests.length)
  expect(Number(cycle.calls)).toBeLessThanOrEqual(12)
})

it('dispatches a new foreground reaction before a slow off-scene decision finishes, without exposing its reply',async()=>{
  vi.spyOn(Math,'random').mockReturnValue(0.5)
  const f=await fixture(true),slow=deferred(),entered=deferred(),foreground=deferred()
  let companionCalls=0,witnessSawReply=false
  f.setDecision(async input=>{
    if(actor(input)==='character:friend'){entered.resolve();await slow.promise;return publish('后室私密回复紫竹')}
    if(actor(input)==='character:companion')return ++companionCalls===1?publish('前台第一句'): {decision:'abstain'}
    witnessSawReply=JSON.stringify(input).includes('前台第一句');foreground.resolve();return {decision:'abstain'}
  })
  const turn=f.runtime.submit(enterFront)
  await entered.promise;await foreground.promise
  expect(witnessSawReply).toBe(true)
  const interim=await f.runtime.state()
  expect(interim.busy).toBe(true);expect(interim.canInterrupt).toBe(true)
  expect(interim.transcript.some(line=>line.text.includes('前台第一句'))).toBe(true)
  slow.resolve();const result=await turn
  expect(result.error).toBe(false)
  expect(f.requests.filter(input=>actor(input)==='character:friend')).toHaveLength(1)
  expect(JSON.stringify(result)).not.toContain('后室私密回复紫竹')
  expect(f.events().filter(event=>event.eventType==='character.speak'&&object(event.data).characterId==='character:friend')).toHaveLength(1)
},60000)

it('discards and replans a background answer when another character enters its scene',async()=>{
  const f=await fixture(),entered=deferred(),slow=deferred()
  let friendCalls=0,companionCalls=0
  f.setDecision(async input=>{
    if(actor(input)==='character:friend'){
      if(++friendCalls===1){entered.resolve();await slow.promise;return publish('过期的后室答复')}
      expect(JSON.stringify(input)).toContain('同行者');return publish('更新后的后室答复')
    }
    if(input.continuation)return publish('我已来到后室')
    if(++companionCalls>1)return {decision:'abstain'}
    await entered.promise;return move('location:back-room')
  })
  const turn=f.runtime.submit(enterFront)
  await entered.promise
  await vi.waitFor(()=>expect(currentLocation(f.events(),'character:companion')).toBe('location:back-room'),{timeout:10000})
  await vi.waitFor(()=>expect(f.events().some(event=>event.eventType==='character.speak'&&JSON.stringify(event.data).includes('我已来到后室'))).toBe(true),{timeout:10000})
  slow.resolve();const result=await turn
  expect(friendCalls).toBe(2);expect(result.error).toBe(false)
  expect(f.events().some(event=>JSON.stringify(event.data).includes('过期的后室答复'))).toBe(false)
  expect(f.events().some(event=>JSON.stringify(event.data).includes('更新后的后室答复'))).toBe(true)
},60000)

it('accepts a new player input through the frontend before the off-scene model returns, then settles both tail boundaries',async()=>{
  const f=await fixture(),entered=deferred(),slow=deferred()
  f.setDecision(async input=>{if(actor(input)==='character:friend'){entered.resolve();await slow.promise;return publish('不能迟到提交的回复')}return {decision:'abstain'}})
  const actions=new FrontendActions(f.runtime)
  const first=actions.perform({operation:'speak',payload:{text:'先在后室说一句'},actionId:'first',requestId:'first'})
  await entered.promise
  expect(projectPlayerView(await f.runtime.state()).canInterrupt).toBe(true)
  f.setDecision(()=>({decision:'abstain'}))
  const second=actions.perform({operation:'speak',payload:{text:'现在听我这句'},actionId:'second',requestId:'second'})
  await vi.waitFor(async()=>expect((await f.runtime.state()).transcript.some(line=>line.player&&line.text==='现在听我这句')).toBe(true),{timeout:10000})
  await second;await first
  const selection=readTailSelection(f.data)!
  expect(selection.tail?.input).toEqual({text:'现在听我这句'})
  expect(f.events().some(event=>JSON.stringify(event.data).includes('不能迟到提交的回复'))).toBe(false)
  slow.resolve()
  const view=await f.runtime.state()
  expect(view.busy).toBe(false);expect(view.transcript.filter(line=>line.player&&line.text==='现在听我这句')).toHaveLength(1)
  const regenerated=await f.runtime.regenerate(view.tailRound!.id!,'regen-after-interrupt')
  expect(regenerated.tailRound?.candidateIds).toHaveLength(2)
  expect(regenerated.transcript.filter(line=>line.player&&line.text==='现在听我这句')).toHaveLength(1)
},60000)

it('presents off-scene work as idle and lets a move button cancel it',async()=>{
  const f=await fixture(),entered=deferred(),slow=deferred()
  f.setDecision(async input=>{if(actor(input)==='character:friend'){entered.resolve();await slow.promise;return publish('玩家走后的场外嘀咕')}return {decision:'abstain'}})
  const first=f.runtime.submit(enterFront)
  await entered.promise
  await vi.waitFor(async()=>expect((await f.runtime.state()).background).toBe(true),{timeout:10000})
  const state=await f.runtime.state()
  expect(state.busy).toBe(true);expect(state.responders).toEqual([])
  const view=projectPlayerView(state)
  expect(view.status).toBe('ready');expect(view.canInterrupt).toBeUndefined();expect(view.responders).toBeUndefined()
  expect(JSON.stringify(view)).not.toContain('留守者 正在')
  const second=await f.runtime.perform({actionType:'move',parameters:{locationId:'location:back-room'}})
  await first
  expect(second.busy).toBe(false)
  expect(currentLocation(f.events(),'character:player')).toBe('location:back-room')
  expect(f.events().some(event=>JSON.stringify(event.data).includes('玩家走后的场外嘀咕'))).toBe(false)
},60000)

it('names only in-scene roles that are forming a response',async()=>{
  const f=await fixture(),entered=deferred(),slow=deferred()
  f.setDecision(async input=>{if(actor(input)==='character:friend'){entered.resolve();await slow.promise}return {decision:'abstain'}})
  const turn=f.runtime.submit('先在后室说一句')
  await entered.promise
  const state=await f.runtime.state()
  expect(state.background).toBe(false);expect(state.responders).toEqual(['留守者'])
  expect(projectPlayerView(state)).toMatchObject({status:'busy',responders:['留守者']})
  slow.resolve();await turn
  expect((await f.runtime.state()).responders).toEqual([])
},60000)

it('replans the second move when two in-flight roles choose to exchange rooms',async()=>{
  const f=await fixture(),started=deferred(),release=deferred()
  let friendDecisions=0,companionDecisions=0
  f.setDecision(async input=>{
    if(input.continuation)return {decision:'abstain'}
    if(actor(input)==='character:friend'){
      if(++friendDecisions===1){started.resolve();await release.promise}
      else expect(JSON.stringify(input)).toContain('同行者')
      return move('location:front-room')
    }
    if(++companionDecisions>1)return {decision:'abstain'}
    await started.promise;return move('location:back-room')
  })
  const done=f.runtime.submit(enterFront)
  await started.promise
  await vi.waitFor(()=>expect(currentLocation(f.events(),'character:companion')).toBe('location:back-room'),{timeout:10000})
  expect(currentLocation(f.events(),'character:friend')).toBe('location:back-room')
  release.resolve();const state=await done
  expect(state.error).toBe(false);expect(friendDecisions).toBe(2)
  expect(currentLocation(f.events(),'character:friend')).toBe('location:front-room')
  const moved=f.events().filter(event=>event.eventType==='character.moved'&&object(event.data).characterId!=='character:player')
  expect(moved.map(event=>object(event.data).characterId)).toEqual(['character:companion','character:friend'])
  expect(f.requests.filter(input=>actor(input)==='character:friend'&&input.continuation)).toHaveLength(1)
},60000)

it('preserves a committed move when its result-aware continuation is interrupted',async()=>{
  const f=await fixture(),continuation=deferred(),slow=deferred()
  f.setDecision(async input=>{
    if(actor(input)!=='character:friend')return {decision:'abstain'}
    if(!input.continuation)return move('location:front-room')
    continuation.resolve();await slow.promise;return publish('未完成的行动续写')
  })
  const first=f.runtime.submit('请处理一下自己的安排')
  await continuation.promise
  expect(currentLocation(f.events(),'character:friend')).toBe('location:front-room')
  f.setDecision(()=>({decision:'abstain'}))
  const second=await f.runtime.submit('我已经看到你过去了')
  await first;slow.resolve()
  expect(second.busy).toBe(false)
  expect(currentLocation(f.events(),'character:friend')).toBe('location:front-room')
  expect(f.events().filter(event=>event.eventType==='character.moved'&&object(event.data).characterId==='character:friend')).toHaveLength(1)
  expect(f.events().some(event=>JSON.stringify(event.data).includes('未完成的行动续写'))).toBe(false)
},60000)

it('keeps the serial comparison path and does not overlap same-scene requests',async()=>{
  const f=await fixture(true,true)
  let active=0,peak=0
  f.setDecision(async()=>{active++;peak=Math.max(peak,active);await new Promise<void>(done=>setTimeout(done,5));active--;return {decision:'abstain'}})
  await f.runtime.submit(enterFront)
  expect(peak).toBe(1)
},60000)

it('still runs both scenes concurrently in a pack with a status script',async()=>{
  const f=await fixture(false,false,false,true),friend=deferred(),companion=deferred()
  let active=0,peak=0
  // Each first decision waits for the other role's to arrive: only concurrent dispatch can finish this round.
  f.setDecision(async input=>{
    if(input.continuation)return {decision:'abstain'}
    active++;peak=Math.max(peak,active)
    if(actor(input)==='character:friend'){friend.resolve();await companion.promise}
    else if(actor(input)==='character:companion'){companion.resolve();await friend.promise}
    active--;return {decision:'abstain'}
  })
  const state=await f.runtime.submit(enterFront)
  expect(state.error).toBe(false)
  expect(peak).toBe(2)
  const activated=(object(state.debug.activationCycle).activations as WorldJsonObject[]).map(activation=>activation.characterId)
  expect(activated).toEqual(expect.arrayContaining(['character:companion','character:friend']))
},60000)

it('bounds repeated stale replanning for one character',async()=>{
  const actorId='character:stale' as never
  const event={seq:1,eventType:'observation.upsert',data:{value:{observerId:actorId,content:{actorId:'character:other',status:'accepted'}}}}
  const store={head:()=>({headSeq:1}),readEventsRange:(_address:unknown,after:number,head:number)=>[event].filter(event=>event.seq>after&&event.seq<=head)} as never
  let attempts=0
  const turn={run:async()=>{attempts++;return {status:'stale',calls:1,asOfWorldSeq:1}}} as never
  const result=await runPrototypeActivations({store,address:{} as never,turn,afterSeq:0,characterIds:[actorId],
    signal:new AbortController().signal,locationId:()=> 'location:room',
    limits:{maximumWaves:3,maximumNpcCalls:8,maximumCallsPerCharacter:1,reactionDeadlineSeconds:5}})
  expect(attempts).toBe(2)
  expect(result.calls).toBe(2)
  expect(result.terminalReason).toBe('character_limit')
},10000)

it('keeps the deepest causal depth when observations for one actor arrive at different depths',async()=>{
  const deepRoot='character:deep-root',shallowRoot='character:shallow-root',middle='character:middle'
  const target='character:target',tail='character:tail'
  const event=(seq:number,observerId:string)=>({seq,eventType:'observation.upsert',data:{value:{observerId,
    content:{actorId:'character:source',status:'accepted'}}}})
  const events=[event(1,deepRoot),event(2,shallowRoot)]
  const store={head:()=>({headSeq:events.at(-1)!.seq}),readEventsRange:(_address:unknown,after:number,head:number)=>events.filter(event=>event.seq>after&&event.seq<=head)} as never
  const deepCommitted=deferred(),calls:string[]=[]
  const turn={run:async(id:string,options:{readonly onCommitted?:(asOf:number,head:number)=>void})=>{
    calls.push(id)
    const asOf=events.at(-1)!.seq
    const commit=(observerId:string)=>{
      const next=events.at(-1)!.seq+1
      events.push(event(next,observerId))
      options.onCommitted?.(asOf,next)
    }
    if(id===deepRoot)commit(middle)
    else if(id===middle){commit(target);deepCommitted.resolve()}
    else if(id===shallowRoot){await deepCommitted.promise;commit(target)}
    else if(id===target)commit(tail)
    return {status:'published',calls:1,asOfWorldSeq:asOf}
  }} as never
  const locations=new Map([[deepRoot,'location:deep'],[middle,'location:middle'],
    [shallowRoot,'location:target'],[target,'location:target'],[tail,'location:tail']])
  const result=await runPrototypeActivations({store,address:{} as never,turn,afterSeq:0,
    characterIds:[deepRoot,shallowRoot,middle,target,tail] as never,signal:new AbortController().signal,
    locationId:id=>locations.get(String(id))!,maximumConcurrent:2,
    limits:{maximumWaves:3,maximumNpcCalls:12,maximumCallsPerCharacter:1,reactionDeadlineSeconds:5}})
  expect(calls.filter(id=>id===target)).toHaveLength(1)
  expect(calls).not.toContain(tail)
  expect(result.terminalReason).toBe('wave_limit')
},10000)

it('continues a foreground response after an independent character fails',async()=>{
  const f=await fixture(),failed=deferred()
  f.setDecision(async input=>{
    if(actor(input)==='character:friend'){failed.resolve();throw new Error('fixture provider failure')}
    if(actor(input)==='character:companion'){await failed.promise;return publish('前台仍然完成回应')}
    return {decision:'abstain'}
  })
  const result=await f.runtime.submit(enterFront)
  expect(f.events().some(event=>event.eventType==='character.speak'
    &&object(event.data).characterId==='character:companion'&&JSON.stringify(event.data).includes('前台仍然完成回应'))).toBe(true)
  expect(result.error).toBe(true)
  expect(result.notice).toContain('角色模型服务未完成请求')
},60000)

it('charges new autonomous observations to their reaction budget after older ordinary observations are consumed',async()=>{
  const foreground='character:foreground',other='character:other',autonomous='character:autonomous'
  const event=(seq:number,observerId:string)=>({seq,eventType:'observation.upsert',data:{value:{observerId,
    content:{actorId:'character:source',status:'accepted',marker:seq}}}})
  const events=[event(1,foreground),event(2,other)]
  const store={head:()=>({headSeq:events.at(-1)!.seq}),readEventsRange:(_address:unknown,after:number,head:number)=>events.filter(event=>event.seq>after&&event.seq<=head)} as never
  const foregroundStarted=deferred(),ordinaryCommitted=deferred(),autonomousCommitted=deferred()
  let foregroundCalls=0
  const turn={run:async(id:string,options:{stimulus:WorldJsonObject[];onCommitted:(through:number,head:number)=>void})=>{
    if(id===other){await foregroundStarted.promise;events.push(event(3,foreground));options.onCommitted(2,3);ordinaryCommitted.resolve()}
    else if(++foregroundCalls===1){foregroundStarted.resolve();await ordinaryCommitted.promise;await autonomousCommitted.promise;return {status:'abstained',calls:1,asOfWorldSeq:3}}
    else expect(options.stimulus.map(value=>object(value.content).marker)).toEqual([4])
    return {status:'abstained',calls:1,asOfWorldSeq:events.at(-1)!.seq}
  }} as never
  const autonomousTurn={run:async(_id:string,options:{onCommitted:(through:number,head:number)=>void})=>{
    events.push(event(4,foreground));options.onCommitted(3,4);autonomousCommitted.resolve()
    return {status:'abstained',calls:1,asOfWorldSeq:3}
  }} as never
  const result=await runPrototypeActivations({store,address:{} as never,turn,afterSeq:0,characterIds:[foreground,other] as never,
    signal:new AbortController().signal,locationId:id=>String(id),
    limits:{maximumWaves:3,maximumNpcCalls:6,maximumCallsPerCharacter:2,reactionDeadlineSeconds:2},
    autonomy:{turn:autonomousTurn,roles:[{characterId:autonomous as never,opportunities:1}],maximumNpcCalls:2,deadlineSeconds:2,
      reactionLimits:{maximumWaves:1,maximumNpcCalls:2,maximumCallsPerCharacter:2}}})
  expect(result.calls).toBe(2)
  expect(result.autonomy).toMatchObject({autonomousCalls:1,reactionCalls:1,terminalReason:'quiescent'})
  expect(foregroundCalls).toBe(2)
},10000)

it.each(['ordinary','autonomous'])('keeps the %s deadline separate from the other dispatch budget',async(expiring)=>{
  const foreground='character:foreground',autonomous='character:autonomous',expired=deferred()
  const events=[{seq:1,eventType:'observation.upsert',data:{value:{observerId:foreground,content:{actorId:'character:player',status:'accepted'}}}}]
  const store={head:()=>({headSeq:1}),readEventsRange:(_address:unknown,after:number,head:number)=>events.filter(event=>event.seq>after&&event.seq<=head)} as never
  const run=(kind:string)=>async(_id:string,options:{signal:AbortSignal})=>{
    if(kind===expiring){
      if(!options.signal.aborted)await new Promise<void>(done=>options.signal.addEventListener('abort',()=>done(),{once:true}))
      expired.resolve();return {status:'interrupted',calls:1,asOfWorldSeq:1}
    }
    await expired.promise;expect(options.signal.aborted).toBe(false)
    return {status:'abstained',calls:1,asOfWorldSeq:1}
  }
  const controller=new AbortController()
  const result=await runPrototypeActivations({store,address:{} as never,turn:{run:run('ordinary')} as never,
    afterSeq:0,characterIds:[foreground] as never,signal:controller.signal,locationId:id=>String(id),
    limits:{maximumWaves:1,maximumNpcCalls:2,maximumCallsPerCharacter:1,reactionDeadlineSeconds:expiring==='ordinary'?0.05:1},
    autonomy:{turn:{run:run('autonomous')} as never,roles:[{characterId:autonomous as never,opportunities:1}],
      maximumNpcCalls:2,deadlineSeconds:expiring==='autonomous'?0.05:1,
      reactionLimits:{maximumWaves:1,maximumNpcCalls:2,maximumCallsPerCharacter:1}}})
  expect(controller.signal.aborted).toBe(false)
  expect(result.terminalReason).toBe(expiring==='ordinary'?'interrupted':'quiescent')
  expect(result.autonomy?.terminalReason).toBe(expiring==='autonomous'?'interrupted':'quiescent')
},10000)
