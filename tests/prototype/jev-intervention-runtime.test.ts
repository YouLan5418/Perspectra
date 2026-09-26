import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect,it } from 'vitest'
import { WorldStore } from '@harness-world/store-sqlite'
import { currentEntityState } from '@harness-world/kernel'
import { FrozenWorldPlaytestRuntime } from '../experiments/playtest-frozen-runtime.ts'
import type { InterventionRecord } from '../experiments/jev-publication-intervention.ts'

it('real runtime commits a performed take once, repairs false recipient hold before observations, and keeps recipient scope',async()=>{
  const root=mkdtempSync(join(tmpdir(),'jev-correct-runtime-')),records:InterventionRecord[]=[]
  let performed=false,published=false,repairs=0
  const server=createServer((req,res)=>{
    let body='';req.on('data',c=>body+=String(c));req.on('end',()=>{
      const request=JSON.parse(JSON.parse(body).messages.at(-1).content)
      let output:unknown={decision:'abstain'}
      if(request.context.publicationCorrection){repairs++;output={decision:'publish',speech:'请靠近看。',narration:'同行者仍握着黄铜钥匙，留守者凑近观察。',addresseeIds:['character:friend']}}
      else if(request.context.character.characterId==='character:companion'&&!published){
        if(!performed){performed=true;output={decision:'perform',actionType:'interact',parameters:{targetRef:{kind:'entity',id:'entity:brass-key'},bindingId:'binding:key-take',definitionRef:{id:'base:take',version:1},arguments:{}}}}
        else {published=true;output={decision:'publish',speech:'请靠近看。',narration:'留守者接过黄铜钥匙，翻看后还给同行者。',addresseeIds:['character:friend']}}
      }
      res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({message:{content:JSON.stringify(output)}}))
    })
  })
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',done))
  let runtime:FrozenWorldPlaytestRuntime|undefined
  try{
    runtime=await FrozenWorldPlaytestRuntime.create({dataDirectory:root,packPath:resolve('examples/world-packs/prototype-g1'),provider:'ollama',model:'fixture',utilityEndpoint:`http://127.0.0.1:${(server.address() as {port:number}).port}/api/chat`,
      publicationAudit:{mode:'correct',items:[{entityId:'entity:brass-key',name:'黄铜钥匙'}],write:r=>records.push(r),classify:async q=>({model:'fixture',inputTokens:1,outputTokens:1,costUsd:0,
        claims:q.characters.map(c=>({characterId:c.characterId,kind:c.characterId==='character:friend'?'OBJECTIVE_DURING':'NONE',referenceSeq:null,probabilities:{NONE:1},referenceProbabilities:{NONE:1},confidence:1}))})}})
    await runtime.submit('/act speak {"text":"请拿钥匙，再请留守者看看。"}')
    const store=new WorldStore(resolve(root,'world.sqlite'))
    try{
      const events=store.readEvents(runtime.address)
      expect(events.filter(e=>e.eventType==='entity.transferred')).toHaveLength(1)
      expect(currentEntityState(events,'entity:brass-key')?.holderId).toBe('character:companion')
      expect(JSON.stringify(events)).not.toContain('翻看后还给同行者')
      expect(events.find(e=>e.eventType==='character.speak'&&(e.data as {characterId?:string}).characterId==='character:companion')?.data).toMatchObject({narration:'同行者仍握着黄铜钥匙，留守者凑近观察。',addresseeIds:['character:friend']})
      expect(repairs).toBe(1);expect(records[0]?.repaired).toBe(true)
    }finally{store.close()}
  }finally{await runtime?.close();await new Promise<void>((done,reject)=>server.close(e=>e?reject(e):done()));rmSync(root,{recursive:true,force:true})}
},30_000)
