import { once } from 'node:events'
import { mkdtemp, writeFile, mkdir, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterEach, expect, it, vi } from 'vitest'
import { createPlaytestServer, type PlaytestRuntime, type PlaytestState } from '../experiments/playtest-server.ts'
import { loadPackWeb } from '../experiments/playtest-pack-web.ts'
import { FrontendActions, projectPlayerView } from '../../packages/frontend/src/player-view.ts'

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
