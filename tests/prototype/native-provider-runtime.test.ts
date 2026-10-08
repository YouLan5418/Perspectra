import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { FrozenWorldPlaytestRuntime } from '../experiments/playtest-frozen-runtime.ts'
import { WorldStore } from '@harness-world/store-sqlite'
import { currentEntityState } from '@harness-world/kernel'

for (const protocol of ['anthropic','google'] as const) {
 it(`${protocol}: real HTTP carries executed results into continuation; private world effects still commit through Rulebook`, async () => {
  const root=await mkdtemp(join(tmpdir(),'native-runtime-'))
  let calls=0
  const server=createServer((request,response)=>{
   let body=''
   request.on('data',chunk=>{body+=String(chunk)})
   request.on('end',()=>{
    const wire=JSON.parse(body)
    const input=JSON.parse(protocol==='anthropic'?wire.messages.at(-1).content:wire.contents.at(-1).parts[0].text)
    let answer:unknown={decision:'abstain'}
    if(input.context.character.characterId==='character:companion') {
     calls++
     if(calls<=2) {
      expect(input.canPerform).toBe(true)
      if(calls===2)expect(input.result.status).toBe('accepted')
      const operation=calls===1?'take':'drop'
      answer={decision:'perform',actionType:'interact',parameters:{targetRef:{kind:'entity',id:'entity:brass-key'},
       bindingId:'binding:key-'+operation,definitionRef:{id:'base:'+operation,version:1},arguments:{}}}
     } else {
      expect(input.canPerform).toBe(false)
      expect(input.result.status).toBe('accepted')
      answer={decision:'publish',segments:[{type:'speech',text:'钥匙已放回。'}]}
     }
    }
    response.writeHead(200,{'content-type':'application/json'})
    response.end(JSON.stringify(protocol==='anthropic'?{content:[{type:'tool_use',name:'submit_actions',input:answer}]}:
     {candidates:[{content:{parts:[{functionCall:{name:'submit_actions',args:answer}}]}}]}))
   })
  })
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',done))
  const address=server.address() as {port:number}
  let runtime:FrozenWorldPlaytestRuntime|undefined
  try {
   runtime=await FrozenWorldPlaytestRuntime.create({dataDirectory:root,packPath:resolve('examples/world-packs/prototype-g1'),
    provider:'local',protocol,model:'fixture',utilityEndpoint:`http://127.0.0.1:${address.port}/${protocol==='google'?'v1beta/models/fixture:generateContent':'v1/messages'}`})
   const result=await runtime.submit('请看看钥匙。')
   expect(result.error).toBe(false)
   expect(calls).toBe(3)
   expect(result.transcript.some(line=>line.text.includes('钥匙已放回'))).toBe(true)
   const store=new WorldStore(join(root,'world.sqlite'))
   try {
    const events=store.readEvents(runtime.address)
    expect(events.filter(event=>event.eventType==='entity.transferred')).toHaveLength(2)
    expect(currentEntityState(events,'entity:brass-key')?.holderId).toBeNull()
   } finally {store.close()}
  } finally {
   await runtime?.close()
   await new Promise<void>(done=>server.close(()=>done()))
   await rm(root,{recursive:true,force:true})
  }
 },30_000)
}
