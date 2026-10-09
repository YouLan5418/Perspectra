import assert from 'node:assert/strict'
import type { WorldJsonObject } from '@harness-world/contracts'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { FrozenWorldRuntimeCore } from './playtest-frozen-runtime.ts'
import { WorldStore } from '@harness-world/store-sqlite'
import { projectPlayerView } from '../../packages/frontend/src/player-view.ts'
const root=resolve('.tmp/official-demo-'+Date.now());mkdirSync(root,{recursive:true})
const runtime=await FrozenWorldRuntimeCore.create({packPath:resolve('examples/world-packs/model-girls-official'),dataDirectory:root,
  provider:'ollama',model:'unused',utilityEndpoint:'http://127.0.0.1:1/api/chat',timeoutMs:1000})
try{
 let state=await runtime.state();const start=projectPlayerView(state).actions.find(a=>a.label.startsWith('开始 '));
 assert.ok(start);state=await runtime.perform(start.action);
 let steps=0;
 while((state.activity?.game as Record<string,unknown>)?.active){
  const next=projectPlayerView(state).actions.find(a=>a.label==='继续');assert.ok(next,'必须有可用的继续操作');state=await runtime.perform(next.action);assert.equal(state.error,false);steps++;assert.ok(steps<=112);
 }
 const store=new WorldStore(resolve(root,'world.sqlite'))
 const events=store.readEvents(runtime.address);store.close()
 const speech=events.filter(e=>e.eventType==='character.speak'),player=speech.filter(e=>(e.data as WorldJsonObject).characterId==='character:player');
 assert.equal(speech.length,112);assert.equal(player.length,5);assert.ok(speech.every(e=>(e.data as WorldJsonObject).scope==='scene_public'));
 assert.equal(state.debug.providerCalls,0);assert.equal((state.activity!.game as Record<string,unknown>).phase,'free');
 assert.equal(state.transcript.filter(l=>l.player).length,5);assert.equal(state.transcript.at(-1)?.text,'你愿意让我们暂时留下来吗？');
 assert.equal(events.filter(e=>e.eventType==='entity.transferred').length,0);
 assert.equal(events.filter(e=>e.eventType==='activity.updated'&&(e.data as WorldJsonObject).scriptedPlayerExpression).length,5);
 writeFileSync(resolve(root,'events.json'),JSON.stringify(events,null,2));writeFileSync(resolve(root,'transcript.json'),JSON.stringify(state.transcript,null,2));
 const summary={root,steps,speech:speech.length,playerExpressions:player.length,providerCalls:state.debug.providerCalls,phase:'free'};
 writeFileSync(resolve(root,'summary.json'),JSON.stringify(summary,null,2));console.log(JSON.stringify(summary));
}finally{await runtime.close()}
