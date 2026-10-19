import { once } from 'node:events'
import { mkdtemp, writeFile, mkdir, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterEach, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { brandId, type WorldJsonObject } from '@harness-world/contracts'
import type { RulebookEvent } from '@harness-world/kernel'
import type { CompiledWorldPackV5 } from '@harness-world/world-pack'
import { createPlaytestServer, type PlaytestRuntime, type PlaytestState } from '../experiments/playtest-server.ts'
import { loadPackWeb } from '../experiments/playtest-pack-web.ts'
import { PackStatus } from '../experiments/pack-status.ts'
import { FrontendActions, projectPlayerView, playerViewPatch } from '../../packages/frontend/src/player-view.ts'

const token='c'.repeat(64),servers: ReturnType<typeof createPlaytestServer>[] = [], roots:string[]=[]
const privateState = ():PlaytestState=>({
 busy:false,paused:false,error:false,phaseLabel:'PRIVATE_PHASE',notice:'PRIVATE_NOTICE',
 world:{title:'实验世界',playerName:'玩家',npcNames:['visible','PRIVATE_NPC'],currentScene:{locationName:'前室',presentNpcNames:['visible']}},
 transcript:[Object.assign({seq:1,speaker:'visible',text:'你好',player:false},{context:'PRIVATE_CONTEXT'})],
 debug:{secret:'PRIVATE_DEBUG'},
 availableActions:[{actionType:'move',actionVersion:1,destinations:[{locationId:'room-2',name:'后室'}]}],
})
async function fixture(overrides:Partial<PlaytestRuntime>={}){
 let state=privateState()
 const runtime:PlaytestRuntime={state:async()=>state,submit:vi.fn(async text=>{state={...state,transcript:[...state.transcript,{seq:2,speaker:'玩家',text,player:true}]};return state}),
 perform:vi.fn(async()=>state),pause:async()=>state,resume:async()=>state,close:async()=>{},...overrides}
 const web=await loadPackWeb(resolve('tests/fixtures/frontend-adversarial'))
 const server=createPlaytestServer(runtime,token,web);servers.push(server)
 let url=''
 // Windows may assign an ephemeral port blocked by WHATWG fetch (for example 6000).
 for(let attempt=0;attempt<8;attempt++){
  server.listen(0,'127.0.0.1');await once(server,'listening')
  url='http://127.0.0.1:'+(server.address() as AddressInfo).port
  try{await fetch(url);break}catch(error){
   if(!(error instanceof Error)||!(error.cause instanceof Error)||error.cause.message!=='bad port'||attempt===7)throw error
   await new Promise<void>(done=>server.close(()=>done()))
  }
 }
 const send=(operation:string,payload:unknown,actionId='action:test',requestId='request:test')=>fetch(url+'/frontend-api/v1/action',{method:'POST',headers:{'x-playtest-token':token,'content-type':'application/json'},body:JSON.stringify({operation,payload,actionId,requestId})})
 return {runtime,url,send,setState:(s:PlaytestState)=>{state=s}}
}
afterEach(async()=>{
 for(const server of servers.splice(0)){server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()))}
 for(const root of roots.splice(0))await rm(root,{recursive:true,force:true})
})
it('projects only player-visible fields and never falls back to the full NPC roster',()=>{
 const projected=JSON.stringify(projectPlayerView(privateState()))
 expect(projected).not.toContain('PRIVATE_')
 expect(projectPlayerView(privateState()).scene?.visibleCharacters).toEqual(['visible'])
})
it('projects speaker identity and audio preferences with explicit field selection in HTTP and SSE patches',async()=>{
 const state=privateState(),speakerId=brandId('character:remote','CharacterId')
 const audio={volume:35,muted:true,voiceEnabled:true,privateToken:'PRIVATE_AUDIO'}
 const next={...state,playerSettings:{inputCharacters:2000,reading:{fontSize:17,lineHeight:1.9,autoFollow:true},audio},
  transcript:[Object.assign({seq:2,speaker:'visible（电话）',speakerId,text:'远处的问候',player:false},{privateContext:'PRIVATE_CONTEXT'})]}
 const view=projectPlayerView(next)
 expect(view.history[0]?.speakerId).toBe(speakerId)
 expect(view.scene?.recipients).toEqual([])
 expect(view.settings?.audio).toEqual({volume:35,muted:true,voiceEnabled:true})
 expect(JSON.stringify(view)).not.toContain('PRIVATE_')
 expect(playerViewPatch(projectPlayerView(state),view)).toMatchObject({settings:{audio:{volume:35}},history:[{speakerId}]})
 const changed=projectPlayerView({...next,playerSettings:{...next.playerSettings,audio:{...audio,volume:60}}})
 expect(playerViewPatch(view,changed)).toMatchObject({settings:{audio:{volume:60}}})
 const {url}=await fixture({state:async()=>next})
 const publicView=await(await fetch(url+'/frontend-api/v1/view',{headers:{'x-playtest-token':token}})).json()
 expect(publicView).toEqual(view)
})
it('includes interrupt availability in player-view updates',()=>{
 const before=projectPlayerView(privateState())
 const state=privateState()
 const after=projectPlayerView({...state,busy:true,canInterrupt:true,transcript:[...state.transcript,{seq:2,speaker:'玩家',text:'继续说',player:true}]})
 expect(after.canInterrupt).toBe(true)
 expect(playerViewPatch(before,after)).toMatchObject({status:'busy',canInterrupt:true,historyAppend:[{speaker:'玩家',text:'继续说',player:true}]})
})
it('offers foreground pause or independent starts/resumes without exposing private activity state',()=>{
 let state=privateState()
 const activity=(key:string,active:boolean,suspended:boolean)=>({activityKey:key,title:key,id:key,revision:3,participants:['player','npc'],suspended,
  game:{active,turn:'player',phase:'playing',public:{score:2},private:{secret:'PRIVATE_ACTIVITY'},internal:{secret:'PRIVATE_INTERNAL'}}})
 state={...state,activities:[activity('guess',false,true),activity('cards',false,false)]}
 let view=projectPlayerView(state)
 expect(view.actions.map(action=>action.label)).toContain('继续 guess')
 expect(view.actions.map(action=>action.label)).toContain('开始 cards')
 expect(JSON.stringify(view)).not.toContain('PRIVATE_')
 state={...state,activities:[activity('guess',false,true),activity('cards',true,false)]}
 view=projectPlayerView(state)
 expect(view.actions.filter(action=>String((action.action.parameters.definitionRef as {id?:string}|undefined)?.id).startsWith('host:activity-')).map(action=>action.label)).toEqual(['暂停 cards'])
 const paused=projectPlayerView({...state,activities:[activity('guess',false,true),activity('cards',false,true)]})
 expect(playerViewPatch(view,paused)).toHaveProperty('activities')
})
it('blocks unauthenticated/opaque-origin access, grants no admin capability and serves sandboxed assets',async()=>{
 const {url}=await fixture()
 expect((await fetch(url+'/frontend-api/v1/view')).status).toBe(401)
 expect((await fetch(url+'/frontend-api/v1/view',{headers:{'x-playtest-token':token,origin:'null'}})).status).toBe(403)
 expect((await fetch(url+'/api/state',{headers:{'x-playtest-token':token,origin:'null'}})).status).toBe(403)
 const init=await (await fetch(url+'/frontend-api/v1/init',{headers:{'x-playtest-token':token}})).json()
 expect(init.apiVersion).toBe(1);expect(init.capabilities).not.toContain('admin');expect(init.capabilities).not.toContain('external-network')
 expect(JSON.stringify(init)).not.toContain('PRIVATE_')
 const page=await fetch(url+'/frontend/custom/index.html')
 expect(page.headers.get('content-security-policy')).toContain("sandbox allow-scripts")
 expect(page.headers.get('content-security-policy')).toContain("connect-src 'none'")
 expect((await fetch(url)).headers.get('content-security-policy')).toContain('/frontend/')
 const portrait=await fetch(url+'/frontend/assets/gpt-6.png')
 expect(portrait.status).toBe(200)
 expect(portrait.headers.get('content-type')).toBe('image/png')
 expect(Buffer.from(await portrait.arrayBuffer()).subarray(0,8).toString('hex')).toBe('89504e470d0a1a0a')
})
it('deduplicates concurrent submissions and rejects same-ID payload changes',async()=>{
 let release!:()=>void
 const block=new Promise<void>(done=>{release=done})
 const submit=vi.fn(async()=>{await block;return privateState()})
 const {send}=await fixture({submit})
 const first=send('speak',{text:'hello'})
 await vi.waitFor(()=>expect(submit).toHaveBeenCalledOnce())
 const duplicate=send('speak',{text:'hello'},'action:test','request:retry')
 const conflict=await send('speak',{text:'different'},'action:test','request:conflict')
 expect(conflict.status).toBe(400)
 release()
 const [a,b]=await Promise.all([first,duplicate])
 expect(a.status).toBe(200);expect(await a.json()).toEqual(await b.json());expect(submit).toHaveBeenCalledOnce()
})
it('retains failed action IDs and does not execute a failed request again',async()=>{
 const submit=vi.fn(async()=>{throw new Error('PRIVATE_MODEL_BODY')})
 const {send}=await fixture({submit})
 const first=await send('speak',{text:'hello'}),duplicate=await send('speak',{text:'hello'})
 expect(first.status).toBe(500);expect(duplicate.status).toBe(500)
 expect(JSON.stringify(await first.json())).not.toContain('PRIVATE_MODEL_BODY')
 expect(submit).toHaveBeenCalledOnce()
})
it('accepts only current Core-provided options, rejects fabricated actions, parameters and admin operations',async()=>{
 const {send,runtime}=await fixture()
 expect((await send('perform',{optionId:'move:secret'},'fake')).status).toBe(400)
 expect((await send('perform',{optionId:'move:room-2',parameters:{locationId:'secret'}},'tampered')).status).toBe(400)
 expect((await send('writeEvent',{event:'taken'},'admin')).status).toBe(400)
 expect(runtime.perform).not.toHaveBeenCalled()
 expect((await send('perform',{optionId:'move:room-2'},'valid')).status).toBe(200)
 expect(runtime.perform).toHaveBeenCalledWith({actionType:'move',parameters:{locationId:'room-2'}})
})
it('accepts participant choices only on a current dynamic activity start and rejects unavailable or changed candidates',async()=>{
 const {send,runtime,setState}=await fixture()
 const state={...privateState(),activities:[{activityKey:'invite',title:'邀请',id:null,revision:0,
  participantSelection:{min:1,max:1,candidates:[{id:'visible',name:'可见角色'}]}}]}
 setState(state)
 const option=projectPlayerView(state).actions.find(action=>action.label==='开始 邀请')!
 for(const [id,npcIds] of [['missing',['hidden']],['many',['visible','hidden']],['duplicate',['visible','visible']]] as const)
  expect((await send('perform',{optionId:option.id,npcIds},id)).status).toBe(400)
 expect((await send('perform',{optionId:'move:room-2',npcIds:['visible']},'fixed')).status).toBe(400)
 expect(runtime.perform).not.toHaveBeenCalled()
 expect((await send('perform',{optionId:option.id,npcIds:['visible']},'selected')).status).toBe(200)
 expect(runtime.perform).toHaveBeenCalledWith({...option.action,parameters:{...option.action.parameters,startParameters:{npcIds:['visible']}}})
 setState({...state,activities:[{...state.activities[0]!,participantSelection:{min:1,max:1,candidates:[]}}]})
 expect((await send('perform',{optionId:option.id,npcIds:['visible']},'stale')).status).toBe(400)
 expect(runtime.perform).toHaveBeenCalledOnce()
})
it('serves only the selected pack resource map and rejects path traversal',async()=>{
 const {url}=await fixture()
 const resource=(path:string)=>fetch(url+'/frontend-api/v1/resource',{method:'POST',headers:{'x-playtest-token':token,'content-type':'application/json'},body:JSON.stringify({path})})
 expect((await resource('assets/banner.svg')).status).toBe(200)
 for(const path of ['../launcher.json','../../world.sqlite','/absolute','C:/secret','assets/%2e%2e/secret','assets/../secret','assets\\secret'])expect((await resource(path)).status).toBe(400)
 expect((await resource('other-pack.json')).status).toBe(404)
 expect((await fetch(url+'/frontend/custom/%2e%2e/%2e%2e/world.sqlite')).status).not.toBe(200)
})
it('streams only public changes and appended history',async()=>{
 const {url,setState}=await fixture()
 const controller=new AbortController()
 const stream=await fetch(url+'/frontend-api/v1/events',{headers:{'x-playtest-token':token},signal:controller.signal})
 const reader=stream.body!.getReader(),decoder=new TextDecoder()
 const initial=decoder.decode((await reader.read()).value)
 expect(initial).toContain('"type":"snapshot"');expect(initial).not.toContain('PRIVATE_')
 const next=privateState();setState({...next,transcript:[...next.transcript,{seq:2,speaker:'玩家',text:'增量',player:true}]})
 const changed=decoder.decode((await reader.read()).value)
 expect(changed).toContain('"historyAppend"');expect(changed).not.toContain('"game"');expect(changed).not.toContain('PRIVATE_')
 controller.abort()
})
it('rejects source-tree symlink escapes instead of serving arbitrary local files',async()=>{
 const root=await mkdtemp(join(tmpdir(),'perspectra-frontend-'));roots.push(root)
 const outside=await mkdtemp(join(tmpdir(),'perspectra-outside-'));roots.push(outside)
 await mkdir(join(root,'frontend'))
 await writeFile(join(root,'frontend','index.html'),'<p>test</p>')
 await writeFile(join(root,'frontend','manifest.json'),'{"apiVersion":1,"capabilities":["view"]}')
 await symlink(outside,join(root,'frontend','escape'),'junction')
 await expect(loadPackWeb(root)).rejects.toThrow('符号链接')
})

it('canonicalizes full options, distinguishes recipients and executes the selected recipient',async()=>{
 const make=(recipient:string,reverse=false,version=1)=>({targetRef:{kind:'entity',id:'entity:brass-key'},
  definitionRef:{id:'base:give',version},bindingId:'binding:key-give',
  arguments:reverse?{nested:{b:2,a:1},recipientId:recipient}:{recipientId:recipient,nested:{a:1,b:2}}})
 const state:PlaytestState={...privateState(),actionNames:{'character:a':'艾莉','character:b':'莉娜','entity:brass-key':'黄铜钥匙'},
  availableActions:[{actionType:'interact',actionVersion:2,interactions:[make('character:a'),make('character:b')]}]}
 const options=projectPlayerView(state).actions
 expect(options[0]!.id).toMatch(/^opt:[a-f0-9]{64}$/u)
 expect(options[0]!.id).not.toBe(options[1]!.id)
 expect(options.map(a=>a.label)).toEqual(['把 黄铜钥匙 交给 艾莉','把 黄铜钥匙 交给 莉娜'])
 const equivalent={...state,availableActions:[{actionType:'interact' as const,actionVersion:2,interactions:[make('character:a',true)]}]}
 expect(projectPlayerView(equivalent).actions[0]!.id).toBe(options[0]!.id)
 equivalent.availableActions[0]!.interactions=[make('character:a',false,2)]
 expect(projectPlayerView(equivalent).actions[0]!.id).not.toBe(options[0]!.id)
 const perform=vi.fn(async(_action:unknown)=>state)
 const runtime={state:async()=>state,perform} as unknown as PlaytestRuntime
 const actions=new FrontendActions(runtime)
 await actions.perform({requestId:'req:second',actionId:'act:second',operation:'perform',payload:{optionId:options[1]!.id}})
 expect(perform.mock.calls[0]![0]).toEqual(options[1]!.action)
 runtime.state=async()=>({...state,availableActions:[]})
 await expect(actions.perform({requestId:'req:stale',actionId:'act:stale',operation:'perform',payload:{optionId:options[1]!.id}})).rejects.toThrow('当前可用')
 expect(perform).toHaveBeenCalledOnce()
})

it('validates candidate selection and cancellation through the public API, with deduplication and no private paths',async()=>{
 const selected=vi.fn(async()=>privateState()),cancelled=vi.fn(async()=>privateState())
 const {send,runtime,url}=await fixture({regenerate:async()=>privateState(),selectCandidate:selected,cancelRegeneration:cancelled})
 const tailId='11111111-1111-4111-8111-111111111111',candidateId='22222222-2222-4222-8222-222222222222'
 expect((await send('selectCandidate',{tailId,candidateId},'select:first')).status).toBe(200)
 expect((await send('selectCandidate',{tailId,candidateId},'select:first','retry')).status).toBe(200)
 expect(selected).toHaveBeenCalledExactlyOnceWith(tailId,candidateId,'select:first')
 expect((await send('selectCandidate',{tailId,candidateId,path:'.tail/results/secret'},'select:bad')).status).toBe(400)
 expect((await send('selectCandidate',{tailId,candidateId:'invented'},'select:fake')).status).toBe(400)
 expect((await send('cancelRegeneration',{},'cancel')).status).toBe(200)
 expect(cancelled).toHaveBeenCalledOnce()
 const state={...privateState(),tailRound:{id:tailId,worldVersion:'public-version',candidateIds:[candidateId],candidateIndex:1,canRegenerate:true,regenerating:false}}
 const view=projectPlayerView(state)
 expect(view.tailRound?.candidateIndex).toBe(1);expect(JSON.stringify(view)).not.toContain('PRIVATE_')
 expect((await fetch(url+'/frontend-api/v1/action',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({requestId:'r',actionId:'a',operation:'selectCandidate',payload:{tailId,candidateId}})})).status).toBe(401)
 expect(runtime.selectCandidate).toBe(selected)
})

it('submits dialogue and multiline narration once, retaining both in the retry identity',async()=>{
 const {send,runtime}=await fixture()
 const payload={text:'你好',narration:'我轻轻笑了笑。\n放缓语气。'}
 expect((await send('speak',payload)).status).toBe(200)
 expect((await send('speak',payload,'action:test','request:retry')).status).toBe(200)
 expect(runtime.submit).toHaveBeenCalledOnce()
 expect(runtime.submit).toHaveBeenCalledWith('/act speak '+JSON.stringify(payload))
 expect((await send('speak',{...payload,narration:'不同描写'})).status).toBe(400)
 expect((await send('speak',{text:'',narration:'纯描写'},'action:narration')).status).toBe(200)
 expect((await send('speak',{text:'',narration:''},'action:empty')).status).toBe(400)
 expect((await send('speak',{text:'a'.repeat(1500),narration:'b'.repeat(501)},'action:long')).status).toBe(400)
 expect((await send('speak',{text:'你好',narration:42},'action:type')).status).toBe(400)
})

it('enforces configured combined input length through the public API and handles larger UTF-8 bodies',async()=>{
 const state={...privateState(),playerSettings:{inputCharacters:4000,reading:{fontSize:22,lineHeight:2,autoFollow:false}}}
 const submit=vi.fn(async()=>state)
 const {send,url}=await fixture({state:async()=>state,submit})
 const body={text:'你'.repeat(2500),narration:'描'.repeat(1000)}
 expect((await send('speak',body,'large:valid')).status).toBe(200)
 expect(submit).toHaveBeenCalledOnce()
 expect((await send('speak',{text:'你'.repeat(3500),narration:'描'.repeat(501)},'large:invalid')).status).toBe(400)
 expect(submit).toHaveBeenCalledOnce()
 const view=await (await fetch(url+'/frontend-api/v1/view',{headers:{'x-playtest-token':token}})).json()
 expect(view.settings).toEqual(state.playerSettings)
 expect(JSON.stringify(view)).not.toContain('PRIVATE_')
})


it.each(['scene_public', 'direct', 'private', 'self'])('submits %s speech with the selected audience and deduplicates retries',async scope=>{
 const {send,runtime,setState}=await fixture()
 const state=privateState()
 setState({...state,world:{...state.world,currentScene:{locationName:'前室',presentNpcNames:['visible'],recipients:[{id:'character:visible',name:'visible'}]}}})
 const payload={text:'只按选定范围投递',narration:'轻声说。',scope,addresseeIds:scope==='direct'||scope==='private'?['character:visible']:[]}
 expect((await send('speak',payload)).status).toBe(200)
 expect(runtime.submit).toHaveBeenCalledExactlyOnceWith('/act speak '+JSON.stringify(payload))
 expect((await send('speak',payload,'action:test','request:retry')).status).toBe(200)
 expect(runtime.submit).toHaveBeenCalledOnce()
 expect((await send('speak',{...payload,scope:scope==='self'?'scene_public':'self',addresseeIds:[]})).status).toBe(400)
})
it('rejects hidden, stale and invalid speech recipients without submitting',async()=>{
 const {send,runtime,setState}=await fixture()
 const state=privateState()
 const current={...state,world:{...state.world,currentScene:{locationName:'前室',presentNpcNames:['visible'],recipients:[{id:'character:visible',name:'visible'}]}}}
 setState(current)
 for(const [index,payload] of [
  {text:'secret',scope:'direct',addresseeIds:['character:hidden']},
  {text:'secret',scope:'private',addresseeIds:[]},
  {text:'secret',scope:'self',addresseeIds:['character:visible']},
  {text:'secret',scope:'scene_public',addresseeIds:['character:visible']},
  {text:'secret',scope:'direct',addresseeIds:['character:visible','character:visible']},
  {text:'secret',scope:'unknown'},
 ].entries()) expect((await send('speak',payload,'invalid:'+index)).status).toBe(400)
 setState({...current,world:{...current.world,currentScene:{locationName:'后室',presentNpcNames:[],recipients:[]}}})
 expect((await send('speak',{text:'secret',scope:'direct',addresseeIds:['character:visible']},'stale')).status).toBe(400)
 expect(runtime.submit).not.toHaveBeenCalled()
 expect(projectPlayerView(privateState()).scene?.recipients).toEqual([])
})

it('delivers explicit player feedback and pushes changes even while busy remains unchanged',()=>{
 const state={...privateState(),busy:true,playerFeedback:{phase:'角色正在处理场景与行动结果',message:''}};
 const first=projectPlayerView(state);expect(first.feedback).toEqual(state.playerFeedback);
 const after=projectPlayerView({...state,playerFeedback:{phase:'正在提交回应',message:''}});
 expect(playerViewPatch(first,after)).toEqual({feedback:after.feedback});
 const end=projectPlayerView({...state,busy:false,error:true,playerFeedback:{phase:'可以输入',message:'玩家输入已提交；已经发表的回应保留，无需重发。'}});
 expect(end).toMatchObject({status:'error',feedback:{phase:'可以输入',message:expect.stringContaining('无需重发')}});
 expect(JSON.stringify(end)).not.toContain('PRIVATE_');
})
const PLAYER='character:player',THIEF='character:companion'
function theft(){
 const status=PackStatus.parse(readFileSync(resolve('tests/prototype/fixtures/status-market.js'),'utf8'),
  {content:{characters:[{characterId:PLAYER},{characterId:THIEF}]}} as unknown as CompiledWorldPackV5)
 // The thief takes 30 and only it learns the new balances; the player still holds the initial 100.
 const stolen={eventType:'status.updated',eventVersion:1,data:{source:{kind:'operation',operation:'steal',actorId:THIEF},
  changes:[{holderId:PLAYER,key:'money',value:70},{holderId:THIEF,key:'money',value:130}],
  reveals:[{observerId:THIEF,holderId:THIEF,key:'money',value:130}],description:'偷到了30'}}
 const events=[status.initialEvent(),stolen] as unknown as RulebookEvent[]
 const names:Record<string,string>={[PLAYER]:'玩家',[THIEF]:'阿七'}
 return status.known(events,PLAYER).map(entry=>({...entry,...(entry.holderId===null?{}:{holderName:names[entry.holderId]!}),...(entry.holderId===PLAYER?{self:true}:{})}))
}
it("player view carries only the player's known status, never truth",()=>{
 const view=projectPlayerView({...privateState(),statusBar:theft()})
 expect(view.statusBar).toContainEqual({key:'money',label:'余额',holderId:PLAYER,holderName:'玩家',self:true,value:100,current:false})
 expect(view.statusBar).toContainEqual({key:'time',label:'时间',holderId:null,value:0,current:true})
 // Neither the player's true balance nor anything about the thief's purse reaches the player.
 expect(view.statusBar?.some(entry=>entry.holderId===THIEF)).toBe(false)
 expect(JSON.stringify(view)).not.toMatch(/"value":(70|130)\b/u)
 expect(JSON.stringify(view)).not.toContain('PRIVATE_')
})
it('statusTruth is projected only when the runtime provides it, with whitelisted fields',()=>{
 expect(projectPlayerView({...privateState(),statusBar:theft()})).not.toHaveProperty('statusTruth')
 const truth=[{key:'money',label:'余额',holderId:PLAYER,holderName:'玩家',self:true,value:70},{key:'money',label:'余额',holderId:THIEF,holderName:'阿七',value:130}]
 const view=projectPlayerView({...privateState(),statusBar:theft(),statusTruth:truth.map(row=>({...row,extra:'PRIVATE_FIELD'}))} as never)
 expect(view.statusTruth).toEqual(truth)
 expect(JSON.stringify(view.statusTruth)).not.toContain('PRIVATE_')
 const before=projectPlayerView({...privateState(),statusTruth:truth})
 const after=projectPlayerView({...privateState(),statusTruth:[{...truth[0]!,value:40},truth[1]!]})
 expect(playerViewPatch(before,after)).toEqual({statusTruth:after.statusTruth})
})
it('statusBar changes appear in playerViewPatch',()=>{
 const before=projectPlayerView({...privateState(),statusBar:theft()})
 const known=theft().map(entry=>entry.key==='money'&&entry.holderId===PLAYER?{...entry,value:70,current:true}:entry)
 const after=projectPlayerView({...privateState(),statusBar:known})
 expect(playerViewPatch(before,after)).toEqual({statusBar:after.statusBar})
 expect(playerViewPatch(after,projectPlayerView({...privateState(),statusBar:known}))).toBeNull()
})
it('offers parameterless status operations as performable actions and leaves parameterised ones out',()=>{
 const option=(id:string,properties:WorldJsonObject)=>({label:id==='check-purse'?'查看钱包':'购买',targetRef:{kind:'character',id:PLAYER},bindingId:'status',
  definitionRef:{id:'status:'+id,version:1},arguments:{},argumentSchema:{type:'object',additionalProperties:false,properties}})
 const view=projectPlayerView({...privateState(),availableActions:[{actionType:'interact',actionVersion:2,
  interactions:[option('check-purse',{}),option('buy',{price:{type:'integer'}})]}]})
 const status=view.actions.filter(action=>String((action.action.parameters.definitionRef as {id?:string}).id).startsWith('status:'))
 expect(status).toEqual([expect.objectContaining({label:'查看钱包',action:{actionType:'interact',parameters:{targetRef:{kind:'character',id:PLAYER},
  definitionRef:{id:'status:check-purse',version:1},bindingId:'status',arguments:{}}}})])
})
