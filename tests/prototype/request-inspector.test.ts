import { expect, it } from 'vitest'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { RequestInspector } from '../../packages/provider-chat/src/request-inspector.ts'
import { createChatProvider } from '../../packages/provider-chat/src/provider.ts'
import { presetCall } from '../../packages/provider-chat/src/preset-runtime.ts'
import { createPlaytestServer, type PlaytestRuntime } from '../experiments/playtest-server.ts'
const info = { characterId: 'npc:a', continuation: false, sources: [{source:'core',name:'Core'}] }
const body = {model:'test',messages:[{role:'system',content:'契约'}]}
it('is opt-in, bounded, detached, and clears private requests on disable', () => {
 const inspector = new RequestInspector()
 expect(inspector.begin(body, info)).toBeUndefined()
 inspector.configure(true)
 for(let i=0;i<6;i++) inspector.begin(body, info)
 const snapshot=inspector.snapshot()
 expect(snapshot.requests.map(r=>r.id)).toEqual([3,4,5,6])
 snapshot.requests[0]!.messages[0]!.content='changed'
 expect(inspector.snapshot().requests[0]!.messages[0]!.content).toBe('契约')
 expect(inspector.configure(false)).toEqual({enabled:false,requests:[]})
 inspector.finish(6,'ok',1,{usage:{prompt_tokens:10}})
 expect(inspector.snapshot().requests).toEqual([])
})
it('captures the exact transport body after generation overrides and prompt injection, without headers or response text', async () => {
 const inspector=new RequestInspector();inspector.configure(true)
 let sent:unknown
 const provider=createChatProvider({endpoint:new URL('http://localhost/test'),model:'m',apiKey:'TEST_SECRET',inspector,
 preset:{prompt:'附加规则',temperature:0.8,maxOutputTokens:333},
 fetch:async(_input,init)=>{sent=JSON.parse(String(init?.body));return new Response(JSON.stringify({usage:{prompt_tokens:101,completion_tokens:9,total_tokens:110},choices:[{message:{tool_calls:[{function:{arguments:'{"decision":"abstain"}'}}],content:'RESPONSE_PRIVATE'}}]}))}})
 const call=presetCall({messages:[{role:'system',content:'契约'},{role:'user',content:JSON.stringify({context:{character:{characterId:'npc:a'},memories:['PRIVATE_MEMORY']}})}],schema:{type:'object'},description:'决策'},
 {nodes:[{id:'style',name:'文风',enabled:true,role:'assistant',position:'afterContext',content:'{{char}}简洁'}]}, {context:{character:{characterId:'npc:a'}},continuation:true},'玩家')
 await expect(provider.decide(call,new AbortController().signal)).resolves.toEqual({decision:'abstain'})
 const capture=inspector.snapshot().requests[0]!
 expect(capture.body).toEqual(sent)
 expect(capture.body).toMatchObject({temperature:0.8,max_tokens:333})
 expect(capture.messages.map(m=>m.source.name)).toEqual(['Core 固定契约','附加角色提示','当前角色授权上下文','文风'])
 expect(capture.messages.at(-1)).toMatchObject({role:'assistant',content:'npc:a简洁',source:{original:'{{char}}简洁',macroExpanded:true}})
 expect(capture.contextParts.find(p=>p.name==='memories')?.content).toBe('["PRIVATE_MEMORY"]')
 expect(capture).toMatchObject({continuation:true,status:'ok',usage:{inputTokens:101,outputTokens:9,totalTokens:110}})
 expect(JSON.stringify(capture)).not.toContain('TEST_SECRET')
 expect(JSON.stringify(capture)).not.toContain('RESPONSE_PRIVATE')
})
it('records transport failure without copying the endpoint error body', async () => {
 const inspector=new RequestInspector();inspector.configure(true)
 const provider=createChatProvider({endpoint:new URL('http://localhost/test'),model:'m',inspector,fetch:async()=>new Response('PRIVATE_ERROR',{status:500})})
 await expect(provider.decide({messages:body.messages,schema:{},description:'x',inspection:info},new AbortController().signal)).rejects.toThrow('500')
 expect(inspector.snapshot().requests[0]?.status).toBe('failed')
 expect(JSON.stringify(inspector.snapshot())).not.toContain('PRIVATE_ERROR')
})
it('omits oversized bodies explicitly', () => {
 const inspector=new RequestInspector();inspector.configure(true)
 inspector.begin({...body,messages:[{role:'user',content:'x'.repeat(1_000_001)}]},info)
 expect(inspector.snapshot().requests[0]).toMatchObject({body:null,messages:[],omitted:expect.any(String)})
})
it('requires the host token and exposes no Inspector in Frontend API', async () => {
 const inspector=new RequestInspector();inspector.configure(true);inspector.begin(body,info)
 const runtime={requestInspection:(enabled?:boolean)=>enabled===undefined?inspector.snapshot():inspector.configure(enabled)} as PlaytestRuntime
 const token='a'.repeat(64),server=createPlaytestServer(runtime,token)
 server.listen(0,'127.0.0.1');await once(server,'listening')
 const url='http://127.0.0.1:'+(server.address() as AddressInfo).port
 try {
  expect((await fetch(url+'/api/request-inspector')).status).toBe(401)
  expect((await fetch(url+'/api/request-inspector',{headers:{'x-playtest-token':token,origin:'null'}})).status).toBe(403)
  expect((await fetch(url+'/frontend-api/v1/request-inspector',{headers:{'x-playtest-token':token}})).status).toBe(404)
  const response=await fetch(url+'/api/request-inspector',{headers:{'x-playtest-token':token}})
  expect(await response.json()).toMatchObject({enabled:true,requests:[{characterId:'npc:a'}]})
  const cleared=await fetch(url+'/api/request-inspector',{method:'POST',headers:{'x-playtest-token':token,'content-type':'application/json'},body:'{"enabled":false}'})
  expect(await cleared.json()).toEqual({enabled:false,requests:[]})
 } finally {server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()))}
})
