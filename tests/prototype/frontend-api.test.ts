import { once } from 'node:events'
import { mkdtemp, writeFile, mkdir, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterEach, expect, it, vi } from 'vitest'
import { createPlaytestServer, type PlaytestRuntime, type PlaytestState } from '../experiments/playtest-server.ts'
import { loadPackWeb } from '../experiments/playtest-pack-web.ts'
import { FrontendActions, projectPlayerView, playerViewPatch } from '../../packages/frontend/src/player-view.ts'

const token='c'.repeat(64),servers: ReturnType<typeof createPlaytestServer>[] = [], roots:string[]=[]
const privateState = ():PlaytestState=>({
 busy:false,paused:false,error:false,phaseLabel:'PRIVATE_PHASE',notice:'PRIVATE_NOTICE',
 world:{title:'实验世界',playerName:'玩家',npcNames:['visible','PRIVATE_NPC'],currentScene:{locationName:'前室',presentNpcNames:['visible']}},
 transcript:[Object.assign({seq:1,speaker:'visible',text:'你好',player:false},{context:'PRIVATE_CONTEXT'})],
 packVariables:{public:{safe:1},private:{secret:'PRIVATE_VARIABLE'}},debug:{secret:'PRIVATE_DEBUG'},
 availableActions:[{actionType:'move',actionVersion:1,destinations:[{locationId:'room-2',name:'后室'}]}],
})
async function fixture(overrides:Partial<PlaytestRuntime>={}){
 let state=privateState()
 const runtime:PlaytestRuntime={state:async()=>state,submit:vi.fn(async text=>{state={...state,transcript:[...state.transcript,{seq:2,speaker:'玩家',text,player:true}]};return state}),
 perform:vi.fn(async()=>state),pause:async()=>state,resume:async()=>state,close:async()=>{},...overrides}
 const web=await loadPackWeb(resolve('tests/fixtures/frontend-adversarial'))
 const server=createPlaytestServer(runtime,token,web);servers.push(server);server.listen(0,'127.0.0.1');await once(server,'listening')
 const url='http://127.0.0.1:'+(server.address() as AddressInfo).port
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
