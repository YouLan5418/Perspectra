import { createServer, type Server } from 'node:http'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { brandId, RECALL_KEYWORD_TOKENIZER_ID, type WorldJsonObject } from '@harness-world/contracts'
import { CognitiveMemoryService } from '@harness-world/memory'
import { CharacterViewBuilder, WorldStore } from '@harness-world/store-sqlite'
import { FrozenWorldPlaytestRuntime } from '../experiments/playtest-frozen-runtime.ts'
import { createPlaytestServer } from '../experiments/playtest-server.ts'
import type { ActivityRequest } from '../experiments/pack-activity.ts'

const roots:string[]=[],servers:Server[]=[],runtimes:FrozenWorldPlaytestRuntime[]=[]
afterEach(async()=>{
  vi.restoreAllMocks()
  for(const runtime of runtimes.splice(0))await runtime.close()
  for(const server of servers.splice(0))await new Promise<void>(done=>server.close(()=>done()))
  for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true})
})
type Decision=(input:WorldJsonObject)=>unknown|Promise<unknown>
async function fixture(decide:Decision=()=>({decision:'abstain'}),transform=(s:string)=>s,packDirectory='examples/world-packs/ai-girls-awaken-v10',provider:'ollama'|'local'='ollama') {
  const root=mkdtempSync(join(tmpdir(),'activity-test-'));roots.push(root)
  const pack=join(root,'pack'),data=join(root,'data');cpSync(resolve(packDirectory),pack,{recursive:true});mkdirSync(data)
  const file=join(pack,'scripts/activity.js')
  writeFileSync(file,transform(readFileSync(file,'utf8').replace('internal: { answer }','internal: { answer: 73 }')
    .replace('const answer = 1 + Math.floor(Math.random() * 100);','const answer = 73;')
    .replace('private: { [playerId]: {}, [npcId]: {} }',"private: { [playerId]: { secret:'player-only' }, [npcId]: { secret:'npc-only' } }")))
  const inputs:WorldJsonObject[]=[],schemas:WorldJsonObject[]=[]
  const server=createServer((req,res)=>{
    let body=''
    req.on('data',chunk=>{body+=String(chunk)})
    req.on('end',()=>{void(async()=>{
      const wire=JSON.parse(body),input=JSON.parse(wire.messages.findLast((m:{role:string})=>m.role==='user').content) as WorldJsonObject
      inputs.push(input);schemas.push(wire.format??wire.tools[0].function.parameters)
      try {const value=await decide(input);res.writeHead(200,{'content-type':'application/json'})
        res.end(JSON.stringify(provider==='local'?{choices:[{message:{tool_calls:[{function:{name:'submit_actions',arguments:JSON.stringify(value)}}]}}]}:{message:{content:JSON.stringify(value)}}))}
      catch {res.writeHead(503);res.end('fixture unavailable')}
    })()})
  })
  servers.push(server);await new Promise<void>(ready=>server.listen(0,'127.0.0.1',ready))
  const address=server.address()
  if(!address||typeof address==='string')throw new Error('no endpoint')
  const options={packPath:pack,dataDirectory:data,provider,model:'fixture',
    utilityEndpoint:'http://127.0.0.1:'+address.port+'/api/chat',timeoutMs:5000}
  const runtime=await FrozenWorldPlaytestRuntime.create(options);runtimes.push(runtime)
  const state=()=>{const store=new WorldStore(join(data,'world.sqlite'));try{return store.readEvents(runtime.address)}finally{store.close()}}
  return {runtime,options,inputs,schemas,events:state,data,pack}
}
function request(state:{activity?:WorldJsonObject},operation:string,parameters:WorldJsonObject={}):ActivityRequest {
  return {activityId:state.activity?.id as string|null,revision:Number(state.activity?.revision),
    operation,parameters,requestId:randomUUID()}
}
function action(input:WorldJsonObject,operation='guess',value=50) {
  const context=input.context as WorldJsonObject,activity=context.activity as WorldJsonObject
  return {decision:'perform',actionType:'interact',parameters:{targetRef:{kind:'character',id:'character:gpt'},
    bindingId:activity.id,definitionRef:{id:'activity:'+operation,version:1},
    arguments:{activityId:activity.id,revision:activity.revision,...(operation==='guess'?{value}:{})}}}
}
describe('creator activity and host escape',()=>{
  it.each(['ollama','local'] as const)('retries malformed activity output once with %s without executing or publishing it twice',async provider=>{
    let calls=0
    const f=await fixture(input=>input.continuation?{decision:'abstain'}:
      ++calls===1?{...action(input),speech:'未执行的猜测',parameters:{...action(input).parameters,
        definitionRef:{...action(input).parameters.definitionRef,version:'1'},
        arguments:{...action(input).parameters.arguments,revision:String(action(input).parameters.arguments.revision)}}}:action(input),s=>s,'examples/world-packs/ai-girls-awaken-v10',provider)
    const start=await f.runtime.activityAction(request(await f.runtime.state(),'start'))
    const after=await f.runtime.activityAction(request(start,'pass'))
    expect(calls).toBe(2)
    expect(after.activity?.revision).toBe(3)
    expect((after.activity!.game as WorldJsonObject).turn).toBe('character:player')
    expect(f.events().filter(e=>e.eventType==='activity.updated')).toHaveLength(3)
    expect(JSON.stringify(after.transcript)).not.toContain('未执行的猜测')
    expect(f.inputs[0]).toEqual(f.inputs[1])
    const properties=f.schemas[1]!.properties as WorldJsonObject
    expect(properties).not.toHaveProperty('speech')
    const parameters=properties.parameters as WorldJsonObject
    expect(parameters).not.toHaveProperty('oneOf')
    const fields=parameters.properties as WorldJsonObject
    expect(((fields.definitionRef as WorldJsonObject).properties as WorldJsonObject).version)
      .toEqual({type:'integer',minimum:1,maximum:1})
    expect((((fields.arguments as WorldJsonObject).properties as WorldJsonObject).revision as WorldJsonObject).const).toBeUndefined()

  })

  it('feeds an activity the newest authorized observations after a long conversation',async()=>{
    const f=await fixture()
    for(let i=0;i<10;i++)await f.runtime.submit('活动之前的第'+i+'条交流。')
    const start=await f.runtime.activityAction(request(await f.runtime.state(),'start'))
    await f.runtime.activityAction(request(start,'pass'))
    const input=f.inputs.at(-1)!,context=input.context as WorldJsonObject
    const store=new WorldStore(join(f.data,'world.sqlite'))
    try {
      const head=store.head(f.runtime.address).headSeq
      const observations=new CharacterViewBuilder(store).rebuildAt(f.runtime.address,brandId('character:gpt','CharacterId'),head).observations
      const expected=observations.toSorted((left,right)=>left.sourceSeq-right.sourceSeq).slice(-8).map(o=>o.value)
      expect(context.stimulus).toEqual(expected)
      expect(JSON.stringify(context.stimulus)).toContain('第9条交流')
    }finally{store.close()}
  })

  it('commits alternating turns, hides internal/private state, and restores original capabilities on completion',async()=>{
    const f=await fixture(input=>input.continuation?{decision:'abstain'}:action(input))
    const started=await f.runtime.activityAction(request(await f.runtime.state(),'start'))
    expect(f.inputs).toHaveLength(0)
    expect(started.availableActions?.some(a=>a.actionType==='move')).toBe(false)
    expect(JSON.stringify(started.activity)).not.toContain('answer')
    expect(JSON.stringify(started.activity)).not.toContain('npc-only')
    const first=request(started,'pass')
    const next=await f.runtime.activityAction(first)
    expect(next.activity?.revision).toBe(3)
    expect((next.activity!.game as WorldJsonObject).turn).toBe('character:player')
    expect(f.inputs).toHaveLength(2)
    expect(JSON.stringify(f.inputs)).not.toContain('player-only')
    expect(JSON.stringify(f.inputs)).not.toContain('"answer"')
    expect(JSON.stringify(f.inputs)).toContain('npc-only')
    const head=next.debug.headSeq
    expect((await f.runtime.activityAction(first)).debug.headSeq).toBe(head)
    expect(f.inputs).toHaveLength(2)
    const end=await f.runtime.activityAction(request(next,'guess',{value:73}))
    expect((end.activity!.game as WorldJsonObject).active).toBe(false)
    expect(end.availableActions?.some(a=>a.actionType==='move')).toBe(true)
    expect(end.transcript.some(l=>l.text.includes('猜中了'))).toBe(true)
    expect(f.events().filter(e=>e.eventType==='activity.updated')).toHaveLength(4)
  })
  it('keeps speech independent from action turns and rejects stale, mixed and direct bypasses without changes',async()=>{
    const f=await fixture()
    const start=await f.runtime.activityAction(request(await f.runtime.state(),'start'))
    const spoken=await f.runtime.submit('我先想一想。')
    expect(spoken.activity?.revision).toBe(start.activity?.revision)
    expect((spoken.activity!.game as WorldJsonObject).turn).toBe('character:player')
    const pending=await f.runtime.activityAction(request(spoken,'pass'))
    expect((pending.activity!.game as WorldJsonObject).turn).toBe('character:gpt')
    const before=pending.debug.headSeq
    await expect(f.runtime.activityAction(request(pending,'guess',{value:10}))).rejects.toThrow(/轮到/u)
    await expect(f.runtime.activityAction(request(start,'guess',{value:10}))).rejects.toThrow(/失效/u)
    await expect(f.runtime.submit('/vars [{"op":"replace","path":"/public/剧情/阶段","value":"绕过"}]')).rejects.toThrow()
    await expect(f.runtime.perform({actionType:'move',parameters:{locationId:'location:living-room'}})).rejects.toThrow()
    await expect(f.runtime.activityAction(request(pending,'quit',{narration:'非法'}))).rejects.toThrow(/参数/u)
    expect((await f.runtime.state()).debug.headSeq).toBe(before)
    expect(f.inputs).toHaveLength(1)
  })
  it('rejects the whole model output and keeps abstain separate from a committed pass',async()=>{
    const f=await fixture(input=>({...action(input),speech:'非法混合',narration:'顺便拿起牌'}))
    const start=await f.runtime.activityAction(request(await f.runtime.state(),'start'))
    const after=await f.runtime.activityAction(request(start,'pass'))
    expect(after.activity?.revision).toBe(2)
    expect((after.activity!.game as WorldJsonObject).turn).toBe('character:gpt')
    expect(f.events().filter(e=>e.eventType==='activity.updated')).toHaveLength(2)
    expect(JSON.stringify(after.transcript)).not.toContain('非法混合')
    expect(f.inputs).toHaveLength(2)
    const g=await fixture(input=>input.continuation?{decision:'abstain'}:action(input,'pass'))
    const gstart=await g.runtime.activityAction(request(await g.runtime.state(),'start'))
    expect((await g.runtime.activityAction(request(gstart,'pass'))).activity?.revision).toBe(3)
  })
  it('does not switch turns or publish a game result when the transaction fails',async()=>{
    const f=await fixture(),before=(await f.runtime.state()).debug.headSeq
    const original=WorldStore.prototype.commitRound
    vi.spyOn(WorldStore.prototype,'commitRound').mockImplementation(function(this: WorldStore,r){
      if(r.events.some(e=>e.eventType==='activity.updated')){
        const injected=new WorldStore(join(f.data,'world.sqlite'),{hit(point){if(point==='store.after-event-insert')throw new Error('fixture commit failed')}})
        return original.call(injected,r).finally(()=>injected.close())
      }
      return original.call(this,r)
    })
    await expect(f.runtime.activityAction(request(await f.runtime.state(),'start'))).rejects.toThrow('fixture commit failed')
    expect((await f.runtime.state()).activity?.id).toBe(null)
    expect((await f.runtime.state()).debug.headSeq).toBe(before)
  })
  it('restores the committed turn and observations before any role is awakened',async()=>{
    const f=await fixture()
    const start=await f.runtime.activityAction(request(await f.runtime.state(),'start'))
    const pending=await f.runtime.activityAction(request(start,'pass'))
    const store=new WorldStore(join(f.data,'world.sqlite'))
    try{
      const view=new CharacterViewBuilder(store).rebuildAt(f.runtime.address,brandId('character:gpt','CharacterId'),store.head(f.runtime.address).headSeq)
      expect(view.observations.some(o=>JSON.stringify(o.value).includes('主动让出'))).toBe(true)
      const other=new CharacterViewBuilder(store).rebuildAt(f.runtime.address,brandId('character:claude','CharacterId'),store.head(f.runtime.address).headSeq)
      expect(JSON.stringify(other.observations)).not.toContain('主动让出')
    }finally{store.close()}
    await f.runtime.close();runtimes.splice(runtimes.indexOf(f.runtime),1)
    const restored=await FrozenWorldPlaytestRuntime.create(f.options);runtimes.push(restored)
    expect((await restored.state()).activity).toEqual(pending.activity)
    expect(f.inputs).toHaveLength(1)
    await restored.escape()
    expect((await restored.state()).availableActions?.some(a=>a.actionType==='move')).toBe(true)
  })
  it('host escape bypasses creator policy and exit rules, works while paused, and remains idempotent',async()=>{
    const f=await fixture(()=>({decision:'abstain'}),s=>s
      .replace("operations: ['guess', 'pass', 'quit']","operations: []")
      .replace("const game = JSON.parse(JSON.stringify(state.game));","throw new Error('creator denies exit');"))
    const start=await f.runtime.activityAction(request(await f.runtime.state(),'start'))
    expect(start.activity?.options).toEqual([])
    await f.runtime.pause()
    const escaped=await f.runtime.escape()
    expect(escaped.paused).toBe(false)
    expect((escaped.activity!.game as WorldJsonObject).phase).toBe('host-aborted')
    expect(escaped.availableActions?.some(a=>a.actionType==='move')).toBe(true)
    expect((await f.runtime.escape()).debug.headSeq).toBe(escaped.debug.headSeq)
    expect(f.inputs).toHaveLength(0)
  })
  it('can escape after the creator policy itself fails without waiting on stuck work',async()=>{
    const f=await fixture(()=>({decision:'abstain'}),s=>s.replace('policy() {',"policy(view) { if (view.revision > 1) throw new Error('creator policy failed');"))
    const start=await f.runtime.activityAction(request(await f.runtime.state(),'start'))
    await expect(f.runtime.activityAction(request(start,'pass'))).rejects.toThrow(/脚本/u)
    const escaped=await f.runtime.escape()
    expect((escaped.activity!.game as WorldJsonObject).phase).toBe('host-aborted')
    expect(escaped.availableActions?.some(a=>a.actionType==='move')).toBe(true)
    expect(f.inputs).toHaveLength(0)
  })
  it('cancels a pending model call before escaping and cannot commit its late output',async()=>{
    let entered!:()=>void,release!:()=>void
    const enteredPromise=new Promise<void>(r=>{entered=r}),releasePromise=new Promise<void>(r=>{release=r})
    const f=await fixture(async input=>{entered();await releasePromise;return action(input)})
    const start=await f.runtime.activityAction(request(await f.runtime.state(),'start'))
    const pending=f.runtime.activityAction(request(start,'pass'))
    await enteredPromise
    const escaped=await f.runtime.escape()
    expect((escaped.activity!.game as WorldJsonObject).active).toBe(false)
    release();await pending
    expect(f.events().filter(e=>e.eventType==='activity.updated')).toHaveLength(3)
    expect(f.events().some(e=>e.eventType==='activity.updated'&&(e.data as WorldJsonObject).operation==='guess')).toBe(false)
  },15000)

  it('records authorized experience without waking a model and recalls it after host escape',async()=>{
    const f=await fixture(()=>({decision:'abstain'}),s=>s.replace('return view.game.active &&','return false &&'))
    const start=await f.runtime.activityAction(request(await f.runtime.state(),'start'))
    await f.runtime.activityAction(request(start,'guess',{value:10}))
    expect(f.inputs).toHaveLength(0)
    await f.runtime.escape()
    const store=new WorldStore(join(f.data,'world.sqlite'))
    const memory=new CognitiveMemoryService(join(f.data,'memory.sqlite'),store,undefined,2,RECALL_KEYWORD_TOKENIZER_ID)
    try{
      const recalled=memory.recall(f.runtime.address,brandId('character:gpt','CharacterId'),'偏小',store.head(f.runtime.address).headSeq)
      expect(recalled.some(m=>m.text.includes('猜了10')&&m.text.includes('偏小'))).toBe(true)
      expect(JSON.stringify(recalled)).not.toContain('"answer"')
      expect(memory.recall(f.runtime.address,brandId('character:claude','CharacterId'),'偏小',store.head(f.runtime.address).headSeq)).toEqual([])
    }finally{memory.close();store.close()}
  })
  it('keeps a self-only player result out of other participants authorized sources',async()=>{
    const f=await fixture(()=>({decision:'abstain'}),s=>s
      .replace("return { game, description, audience: 'participants' };", "return { game, description: '仅玩家收到的私密反馈', audience: 'self' };")
      .replace('return view.game.active &&','return false &&'))
    const start=await f.runtime.activityAction(request(await f.runtime.state(),'start'))
    await f.runtime.activityAction(request(start,'guess',{value:10}))
    expect(f.inputs).toHaveLength(0)
    const store=new WorldStore(join(f.data,'world.sqlite'))
    try{
      const head=store.head(f.runtime.address).headSeq,builder=new CharacterViewBuilder(store)
      expect(JSON.stringify(builder.rebuildAt(f.runtime.address,brandId('character:player','CharacterId'),head).observations)).toContain('仅玩家收到的私密反馈')
      expect(JSON.stringify(builder.rebuildAt(f.runtime.address,brandId('character:gpt','CharacterId'),head).observations)).not.toContain('仅玩家收到的私密反馈')
      await f.runtime.activityAction(request(await f.runtime.state(),'quit'))
      const closed=builder.rebuildAt(f.runtime.address,brandId('character:gpt','CharacterId'),store.head(f.runtime.address).headSeq)
      expect(JSON.stringify(closed.observations)).not.toContain('"active":false')
    }finally{store.close()}
  })
  it('does not turn a technical model failure into a pass',async()=>{
    const f=await fixture(()=>{throw new Error('provider unavailable')})
    const start=await f.runtime.activityAction(request(await f.runtime.state(),'start'))
    const after=await f.runtime.activityAction(request(start,'pass'))
    expect(after.error).toBe(true)
    expect(after.activity?.revision).toBe(2)
    expect((after.activity!.game as WorldJsonObject).turn).toBe('character:gpt')
    expect(f.events().filter(e=>e.eventType==='activity.updated'&&(e.data as WorldJsonObject).operation==='pass')).toHaveLength(1)
    await f.runtime.escape()
  })
  it('allows a creator-permitted world move and preserves Rulebook constraints',async()=>{
    const f=await fixture(()=>({decision:'abstain'}),s=>s.replace('narration: false, move: false','narration: false, move: true'))
    await f.runtime.activityAction(request(await f.runtime.state(),'start'))
    expect((await f.runtime.state()).availableActions?.some(a=>a.actionType==='move')).toBe(true)
    await expect(f.runtime.perform({actionType:'move',parameters:{locationId:'location:missing'}})).rejects.toThrow()
    const moved=await f.runtime.perform({actionType:'move',parameters:{locationId:'location:living-room'}})
    expect(moved.world.currentScene?.locationName).toBe('客厅')
    expect(moved.activity?.revision).toBe(1)
    expect(f.inputs).toHaveLength(0)
  })
  it('routes the public gateway through the real Core and rejects invented moves without committing facts',async()=>{
    const f=await fixture(),token='d'.repeat(64)
    const server=createPlaytestServer(f.runtime,token);servers.push(server)
    await new Promise<void>(ready=>server.listen(0,'127.0.0.1',ready))
    const address=server.address();if(!address||typeof address==='string')throw new Error('no endpoint')
    const url='http://127.0.0.1:'+address.port
    const send=(optionId:string,actionId:string)=>fetch(url+'/frontend-api/v1/action',{method:'POST',
      headers:{'x-playtest-token':token,'content-type':'application/json'},
      body:JSON.stringify({requestId:'request:'+actionId,actionId,operation:'perform',payload:{optionId}})})
    const before=f.events().length
    expect((await send('move:location:missing','invalid')).status).toBe(400)
    expect(f.events()).toHaveLength(before)
    const response=await send('move:location:living-room','move')
    expect(response.status).toBe(200)
    const view=await response.json()
    expect(view.scene.locationName).toBe('客厅')
    expect(view).not.toHaveProperty('debug')
    expect(view).not.toHaveProperty('packVariables')
    const committed=f.events().length
    expect(committed).toBeGreaterThan(before)
    expect(await (await send('move:location:living-room','move')).json()).toEqual(view)
    expect(f.events()).toHaveLength(committed)
    expect((await send('move:location:bedroom','return')).status).toBe(200)
    await f.runtime.activityAction(request(await f.runtime.state(),'start'))
    const blocked=f.events().length
    expect((await send('move:location:living-room','blocked')).status).toBe(400)
    expect(f.events()).toHaveLength(blocked)
  })

  it('serves escape in the host frame and protects the override endpoint',async()=>{
    const f=await fixture(),token='b'.repeat(64),web=await import('../experiments/playtest-pack-web.ts')
    const server=createPlaytestServer(f.runtime,token,await web.loadPackWeb(f.pack));servers.push(server)
    await new Promise<void>(ready=>server.listen(0,'127.0.0.1',ready))
    const address=server.address();if(!address||typeof address==='string')throw new Error('no endpoint')
    const url='http://127.0.0.1:'+address.port
    const outer=await fetch(url),inner=await fetch(url+'/frontend/default.html')
    expect(outer.headers.get('content-security-policy')).toContain("frame-src "+url+"/frontend/")
    expect(inner.headers.get('x-frame-options')).toBeNull()
    expect(inner.headers.get('content-security-policy')).toContain("frame-ancestors "+url)
    const page=await outer.text()
    expect(page).toContain('id="escape"')
    // Only the trusted host owns override controls and the Core token.
    expect(page).toContain('sandbox="allow-scripts"')
    expect(await inner.text()).not.toContain('id="escape"')
    const start=await f.runtime.activityAction(request(await f.runtime.state(),'start'))
    expect((await fetch(url+'/api/escape',{method:'POST'})).status).toBe(401)
    expect((await f.runtime.state()).activity?.revision).toBe(start.activity?.revision)
    const response=await fetch(url+'/api/escape',{method:'POST',headers:{'x-playtest-token':token}})
    expect(response.status).toBe(200)
    expect((await response.json()).activity.game.active).toBe(false)
  })
})

function activityOperation(input:WorldJsonObject,id:string,parameters:WorldJsonObject={}) {
  const context=input.context as WorldJsonObject,activity=context.activity as WorldJsonObject
  return {decision:'perform',actionType:'interact',parameters:{
    targetRef:{kind:'character',id:(context.character as WorldJsonObject).characterId},bindingId:activity.id,
    definitionRef:{id:'activity:'+id,version:1},arguments:{activityId:activity.id,revision:activity.revision,...parameters}}}
}
const hostedPack='examples/world-packs/ai-girls-hosted-guess'
describe('script-defined participants and moderator judgement',()=>{
  const decide=(input:WorldJsonObject)=>{
    if(input.continuation)return {decision:'abstain'}
    const game=((input.context as WorldJsonObject).activity as WorldJsonObject).game as WorldJsonObject
    if(game.phase==='opening')return activityOperation(input,'open')
    if(game.phase==='judging')return activityOperation(input,'judge',{verdict:'偏小'})
    return activityOperation(input,'guess',{value:50})
  }
  it('runs host → guesser → host without exposing the host answer to guessers or other roles',async()=>{
    const f=await fixture(decide,s=>s,hostedPack)
    const start=await f.runtime.activityAction(request(await f.runtime.state(),'start'))
    expect(start.activity?.participants).toEqual(['character:player','character:gpt','character:claude'])
    expect((start.activity!.game as WorldJsonObject).turn).toBe('character:player')
    expect(JSON.stringify(start.activity)).not.toContain('"answer"')
    expect(f.inputs).toHaveLength(2)
    const after=await f.runtime.activityAction(request(start,'guess',{value:10}))
    expect(after.activity?.revision).toBe(6)
    expect((after.activity!.game as WorldJsonObject).turn).toBe('character:player')
    expect(f.inputs.slice(2).map(i=>((i.context as WorldJsonObject).character as WorldJsonObject).characterId))
      .toEqual(['character:claude','character:claude','character:gpt','character:gpt','character:claude','character:claude'])
    for(const input of f.inputs){
      const context=input.context as WorldJsonObject,actor=(context.character as WorldJsonObject).characterId
      if(actor==='character:claude')expect(((context.activity as WorldJsonObject).game as WorldJsonObject).private).toMatchObject({answer:73})
      else expect(JSON.stringify(input)).not.toContain('"answer"')
    }
    const store=new WorldStore(join(f.data,'world.sqlite'))
    try{
      const other=new CharacterViewBuilder(store).rebuildAt(f.runtime.address,brandId('character:deepseek','CharacterId'),store.head(f.runtime.address).headSeq)
      expect(JSON.stringify(other.observations)).not.toContain('裁决为')
      const judged=f.events().filter(e=>e.eventType==='observation.upsert'&&JSON.stringify(e.data).includes('裁决为'))
      expect(judged.length).toBeGreaterThan(0)
      for(const event of judged){
        const content=((event.data as WorldJsonObject).value as WorldJsonObject).content as WorldJsonObject
        expect(content.resultMetadata).toMatchObject({activity:{id:start.activity!.id,active:true,lifecycle:'updated'}})
        expect(JSON.stringify(content.resultMetadata)).not.toContain('answer')
      }
    }finally{store.close()}
    await expect(f.runtime.activityAction(request(after,'judge',{verdict:'猜中'}))).rejects.toThrow(/允许/u)
    await f.runtime.escape()
  })
  it('records a deliberately wrong model verdict without a hidden numeric correction',async()=>{
    const f=await fixture(input=>{
      if(input.continuation)return {decision:'abstain'}
      const game=((input.context as WorldJsonObject).activity as WorldJsonObject).game as WorldJsonObject
      return activityOperation(input,game.phase==='opening'?'open':'judge',game.phase==='opening'?{}:{verdict:'猜中'})
    },s=>s,hostedPack)
    const start=await f.runtime.activityAction(request(await f.runtime.state(),'start'))
    const end=await f.runtime.activityAction(request(start,'guess',{value:10}))
    const game=end.activity!.game as WorldJsonObject
    expect(game).toMatchObject({active:false,phase:'finished',public:{winner:'character:player',history:[{value:10,verdict:'猜中'}]}})
    expect(end.transcript.some(line=>line.text.includes('猜测 10 裁决为“猜中”'))).toBe(true)
    expect(end.availableActions?.some(a=>a.actionType==='move')).toBe(true)
    const store=new WorldStore(join(f.data,'world.sqlite')),memory=new CognitiveMemoryService(join(f.data,'memory.sqlite'),store,undefined,2,RECALL_KEYWORD_TOKENIZER_ID)
    try{
      const recalled=memory.recall(f.runtime.address,brandId('character:gpt','CharacterId'),'裁决',store.head(f.runtime.address).headSeq)
      expect(recalled.some(m=>m.text.includes('猜测 10'))).toBe(true)
      expect(recalled.some(m=>m.text.includes('"active":false'))).toBe(true)
      expect(JSON.stringify(recalled)).not.toContain('answer')
      const endObservations=f.events().filter(e=>e.eventType==='observation.upsert'&&JSON.stringify(e.data).includes('裁决为'))
      expect(endObservations.length).toBeGreaterThan(0)
      for(const event of endObservations){
        const content=((event.data as WorldJsonObject).value as WorldJsonObject).content as WorldJsonObject
        expect(content.resultMetadata).toMatchObject({activity:{id:start.activity!.id,active:false,lifecycle:'ended'}})
      }
    }finally{memory.close();store.close()}
  })
  it('retains a pending host judgement across restart and can escape from that phase',async()=>{
    const f=await fixture(input=>{
      const game=((input.context as WorldJsonObject).activity as WorldJsonObject).game as WorldJsonObject
      return !input.continuation&&game.phase==='opening'?activityOperation(input,'open'):{decision:'abstain'}
    },s=>s,hostedPack)
    const start=await f.runtime.activityAction(request(await f.runtime.state(),'start'))
    const pending=await f.runtime.activityAction(request(start,'guess',{value:10}))
    expect((pending.activity!.game as WorldJsonObject)).toMatchObject({phase:'judging',turn:'character:claude',public:{pending:{value:10}}})
    await f.runtime.close();runtimes.splice(runtimes.indexOf(f.runtime),1)
    const restored=await FrozenWorldPlaytestRuntime.create(f.options);runtimes.push(restored)
    expect((await restored.state()).activity).toEqual(pending.activity)
    const escaped=await restored.escape()
    expect((escaped.activity!.game as WorldJsonObject).phase).toBe('host-aborted')
  })
  it('caps creator-requested repeated activations and rejects waking an undeclared participant',async()=>{
    const f=await fixture(()=>({decision:'abstain'}),s=>s.replace('onOutcome(result, view) {', "onOutcome(result, view) { return {kind:'activate',characterId:'character:claude'};"),hostedPack)
    const pending=await f.runtime.activityAction(request(await f.runtime.state(),'start'))
    expect(f.inputs).toHaveLength(4)
    expect(pending.notice).toContain('预算上限')
    expect(pending.activity?.revision).toBe(1)
    await f.runtime.escape()
    const g=await fixture(()=>({decision:'abstain'}),s=>s.replace('schedule(view) {',"schedule(view) { return {kind:'activate',characterId:'character:deepseek'};"),hostedPack)
    await expect(g.runtime.activityAction(request(await g.runtime.state(),'start'))).rejects.toThrow(/未授权/u)
    expect(g.inputs).toHaveLength(0)
    await g.runtime.escape()
  })
})
