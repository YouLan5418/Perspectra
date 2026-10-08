import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { WorldJsonObject } from '@harness-world/contracts'
import { WorldStore } from '@harness-world/store-sqlite'
import { FrozenWorldPlaytestRuntime } from './playtest-frozen-runtime.ts'
import type { PlaytestState } from './playtest-server.ts'

// No real model service: an accidental provider call fails the experiment.
const root=resolve(process.argv[2]??`.tmp/scripted-performance-${Date.now()}`)
if(existsSync(root))throw new Error('实验目录已存在，请使用新目录。')
mkdirSync(root,{recursive:true})
const results:WorldJsonObject[]=[]
for(const choice of ['hear','leave']){
  const dataDirectory=resolve(root,choice)
  const runtime=await FrozenWorldPlaytestRuntime.create({dataDirectory,
    packPath:resolve('examples/world-packs/scripted-performance'),provider:'ollama',model:'unused',
    utilityEndpoint:'http://127.0.0.1:1/api/chat',timeoutMs:1000})
  const operation=(state:PlaytestState,id:string,parameters:WorldJsonObject={})=>({
    activityId:typeof state.activity?.id==='string'?state.activity.id:null,revision:Number(state.activity?.revision),
    operation:id,parameters,requestId:randomUUID()})
  try{
    const start=await runtime.activityAction(operation(await runtime.state(),'start'))
    assert.equal(start.error,false)
    assert.equal((start.activity!.game as WorldJsonObject).phase,'choice')
    const end=await runtime.activityAction(operation(start,'choose',{choice}))
    assert.equal(end.error,false)
    assert.equal((end.activity!.game as WorldJsonObject).active,false)
    assert.equal(end.debug.providerCalls,0)
    const store=new WorldStore(resolve(dataDirectory,'world.sqlite'))
    const events=(()=>{try{return store.readEvents(runtime.address)}finally{store.close()}})()
    const speech=events.filter(e=>e.eventType==='character.speak')
    assert.equal(speech.length,3)
    const resolutions=events.filter(e=>e.eventType==='action.resolved'&&(e.data as WorldJsonObject).actorId!=='character:player')
    assert.equal(resolutions.length,6)
    assert.ok(resolutions.every(e=>(e.data as WorldJsonObject).accepted===true))
    const activityUpdates=events.filter(e=>e.eventType==='activity.updated')
    assert.equal(activityUpdates.length,5)
    const serialized=JSON.stringify(end.transcript)
    assert.ok(serialized.includes(choice==='hear'?'如果你还记得，明晚请来':'好，今天到这里'))
    writeFileSync(resolve(dataDirectory,'transcript.json'),JSON.stringify(end.transcript,null,2)+'\n')
    writeFileSync(resolve(dataDirectory,'events.json'),JSON.stringify(events,null,2)+'\n')
    const transcript=end.transcript.map(row=>`**${row.speaker}**\n\n${row.text}`).join('\n\n')
    writeFileSync(resolve(dataDirectory,'transcript.md'),`# 雨夜来信：${choice}\n\n${transcript}\n`)
    results.push({choice,providerCalls:0,characterPublications:speech.length,acceptedCharacterActions:resolutions.length,
      activityUpdates:activityUpdates.length,finalPhase:(end.activity!.game as WorldJsonObject).phase!,dataDirectory})
  }finally{await runtime.close()}
}
writeFileSync(resolve(root,'summary.json'),JSON.stringify(results,null,2)+'\n')
console.log(JSON.stringify({root,results},null,2))
