/** Isolated UX fixture: official Core + author status rules + local deterministic provider.
 * No user saves or external model. The queue diagnostic checks only synthetic events in its own temporary fixture. */
import { mkdtempSync, cpSync, readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createRoleplayCore } from '../support/roleplay-runtime.ts'
import { fakeModels, startFakeProvider } from '../support/fake-provider.ts'
import { createHostServer, type HostRuntime, type HostState } from '../../apps/host/src/runtime/http-server.ts'
import { projectPlayerView } from '../../apps/host/src/runtime/frontend-adapter.ts'
import { WorldStore } from '@perspectra/core/store'
import { loadPackWeb } from '../../apps/host/src/runtime/pack-frontend.ts'

mkdirSync(resolve('.tmp'), { recursive: true })
const root=mkdtempSync(resolve('.tmp/ux-move-')),pack=join(root,'pack')
cpSync(resolve('examples/world-packs/status-market'),pack,{recursive:true})
function replaceFixtureText(directory:string){
  for(const entry of readdirSync(directory,{withFileTypes:true})){
    const path=join(directory,entry.name)
    if(entry.isDirectory())replaceFixtureText(path)
    else if(/\.(json|js|cjs|md)$/.test(entry.name))writeFileSync(path,readFileSync(path,'utf8').replaceAll('entity:thermos','entity:cup').replaceAll('保温杯','茶杯').replaceAll('character:companion','character:gpt').replaceAll('同行者','GPT-6').replaceAll('location:front-room','location:living-room').replaceAll('scene:front-room','scene:living-room').replaceAll('集市摊位','客厅').replaceAll('location:back-room','location:hallway').replaceAll('scene:back-room','scene:hallway').replaceAll('后巷','走廊').replaceAll('留守者','Claude'))
  }
}
replaceFixtureText(pack)
const world=JSON.parse(readFileSync(join(pack,'world.json'),'utf8'));world.title='客厅与走廊 · 隔离夹具';writeFileSync(join(pack,'world.json'),JSON.stringify(world))
const entities=JSON.parse(readFileSync(join(pack,'entities.json'),'utf8'));entities.entities[0].kind='白瓷茶杯';entities.entities.push({entityId:'entity:lamp',locationId:'location:living-room',kind:'固定照明设备',name:'固定台灯'});entities.entities.push({entityId:'entity:umbrella',locationId:'location:hallway',kind:'雨具',name:'长柄伞'});writeFileSync(join(pack,'entities.json'),JSON.stringify(entities))
const locations=JSON.parse(readFileSync(join(pack,'locations.json'),'utf8'));locations.locations.push({locationId:'location:hidden',name:'未发现的储藏室'});writeFileSync(join(pack,'locations.json'),JSON.stringify(locations))
const characters=JSON.parse(readFileSync(join(pack,'characters.json'),'utf8'));characters.characters.find((c:{characterId:string})=>c.characterId==='character:friend').initialLocationId='location:hallway';writeFileSync(join(pack,'characters.json'),JSON.stringify(characters))
const scenes=JSON.parse(readFileSync(join(pack,'scenes.json'),'utf8'));scenes.scenes[0].participantIds=scenes.scenes[0].participantIds.filter((id:string)=>id!=='character:friend');scenes.scenes[1].lifecycle='active';scenes.scenes[1].participantIds=['character:friend'];writeFileSync(join(pack,'scenes.json'),JSON.stringify(scenes))
// Public, fixture-authored lamp toggle. No take option or invented refusal reason for the lamp.
// Browser queue verification only. The real pacing plugin commits an authored event each turn.
const queueFixture=process.env.PERSPECTRA_QUEUE_PACING==='1'
if(queueFixture){
  const manifest=join(pack,'worldpack.source.json')
  const declared=JSON.parse(readFileSync(manifest,'utf8'))
  declared.assetFiles.push('scripts/pacing.js')
  declared.plugins={...declared.plugins,'official-pacing':{}}
  writeFileSync(manifest,JSON.stringify(declared))
  writeFileSync(join(pack,'scripts/pacing.js'),`
globalThis.pacingScript = {
  definition: { cycleRounds:16, chance:1, cooldownRounds:{low:0,medium:0,high:0}, recoveryRounds:0,
    beats:{window:{intensity:'low'}} },
  beats:{window:{when:()=>[['始终',true]],apply:()=>({
    sceneNotice:'窗外传来两下轻轻的敲击声。',
    stimuli:[{characterId:'character:friend',kind:'thought',text:'留守者独有的夹具暗号。'}]
  })}}
};
`)
}
const script=join(pack,'scripts/status.js')
writeFileSync(script,readFileSync(script,'utf8')+`
;statusScript.definition.statuses.push({key:'lamp-on',label:'台灯',type:'boolean',owner:'public',alwaysKnown:true,bar:false});
statusScript.definition.operations.push({id:'lamp-toggle',label:'开关台灯',targets:['entity:lamp'],schema:{type:'object',additionalProperties:false,properties:{}}});
const oldInit=statusScript.initialize,oldPolicy=statusScript.policy,oldResolve=statusScript.resolve;
statusScript.initialize=(ids)=>{const value=oldInit(ids);value.public['lamp-on']=false;return value};
statusScript.policy=(known,actor,place)=>{const value=oldPolicy(known,actor,place);value.operations.push('lamp-toggle');value.targets['lamp-toggle']=place.items.filter(item=>item.entityId==='entity:lamp'&&item.holderId===null).map(item=>item.entityId);return value};
statusScript.resolve=(truth,actor,operation,args,world,target)=>operation==='lamp-toggle'?{changes:[{holderId:null,key:'lamp-on',value:!truth.public['lamp-on']}],reveals:[],description:truth.public['lamp-on']?'关闭了台灯。':'打开了台灯。',audience:'scene'}:oldResolve(truth,actor,operation,args,world,target);
`)
let providerCalls=0,accepted=0,run=0,revoked=false,holdMove=false,moveEntered=false;
let releaseMove:(()=>void)|undefined
// The feedback browser test holds only the loopback provider response after the real player input commits.
let holdReply=false,replyEntered=false,replyNext=false,queueBatch=0
let releaseReply:(()=>void)|undefined
const provider=await startFakeProvider('openai',async()=>{
  providerCalls++;
  if(holdReply&&!replyEntered){
    replyEntered=true
    await new Promise<void>(resolve=>{releaseReply=resolve})
  }
  if(replyNext){
    replyNext=false;
    const text=queueFixture?'我听到了，第 '+queueBatch+' 批。':'我记下这笔账了。';
    return {tool:{decision:'publish',segments:[{type:'speech',text}]}};
  }
  return {tool:{decision:'abstain'}}
})
const create=()=>createRoleplayCore({packPath:pack,dataDirectory:join(root,'data-'+(++run)),models:fakeModels(provider.endpoint),timeoutMs:5000,serialScheduling:true})
let core=await create()
// This fixture narrows the host's authorized output both in polling and in action responses.
// The test can revoke the offer just before dispatch; successful moves use the actual rulebook.
function authorizedFixtureState(state:HostState):HostState{
  return {
    ...state,
    availableActions:(state.availableActions??[]).map(offer=>offer.actionType==='move'
      ? {...offer,destinations:(offer.destinations??[]).filter(place=>
          place.locationId!=='location:hidden'&&(!revoked||place.locationId!=='location:hallway'))}
      :offer),
  }
}
const runtime:HostRuntime={
  state:async()=>authorizedFixtureState(await core.state()),
  submit:async(...args)=>authorizedFixtureState(await core.submit(...args)),
  perform:async(...args)=>{
    if(holdMove&&args[0].actionType==='move'){
      moveEntered=true
      await new Promise<void>(resolve=>{releaseMove=resolve})
    }
    const result=await core.perform(...args);accepted++;
    return authorizedFixtureState(result)
  },
  pause:async()=>authorizedFixtureState(await core.pause()),
  resume:async()=>authorizedFixtureState(await core.resume()),
  close:()=>core.close(),
}
const art=await loadPackWeb(resolve('examples/world-packs/model-girls-sweet-days'))
if(!art)throw new Error('Public artwork unavailable')
const assets=new Map(art.assets)
const hallArt=assets.get('/frontend/custom/backgrounds/entrance-shop.jpg')
const hallPortrait=assets.get('/frontend/custom/portraits/claude.png')
if(!hallArt||!hallPortrait)throw new Error('Fixture hallway artwork unavailable')
assets.set('/frontend/custom/backgrounds/hallway.jpg',hallArt)
assets.set('/frontend/custom/portraits/friend.png',hallPortrait)
assets.set('/frontend/custom/theme.css',{contentType:'text/css; charset=utf-8',bytes:readFileSync(resolve('layout-compare/theme.css'))})
const server=createHostServer(runtime,'f'.repeat(64),{theme:true,assets,manifest:art.manifest,digest:art.digest,stage:{characters:art.stage?.characters??{}}})
server.listen(0,'127.0.0.1',()=>{const address=server.address();if(address&&typeof address==='object')console.log('Preview ready on port '+address.port)})
process.on('message',async(message:{id?:number;command?:string})=>{
  try{
    if(message.command==='reset'){
      releaseMove?.();releaseReply?.();holdReply=false;replyEntered=false;replyNext=false;queueBatch=0;await core.close();accepted=0;holdMove=false;moveEntered=false;revoked=false;core=await create()
    }
    if(message.command==='reply-once')replyNext=true
    if(message.command==='hold-reply'){holdReply=true;replyEntered=false}
    if(message.command==='release-reply'){holdReply=false;releaseReply?.();releaseReply=undefined}
    if(message.command==='pause')await core.pause()
    if(message.command==='resume')await core.resume()
    if(message.command==='hold')holdMove=true
    if(message.command==='release'){holdMove=false;releaseMove?.();releaseMove=undefined}
    if(message.command==='revoke')revoked=true
    if(message.command==='queue-batch'&&queueFixture){
      queueBatch++;replyNext=true
      await core.submit('/act speak '+JSON.stringify({text:'第 '+queueBatch+' 批日常内容。',scope:'scene_public',addresseeIds:[]}))
    }
    let privateStimulusRecords:number|undefined
    if(message.command==='queue-proof'&&queueFixture){
      const store=new WorldStore(join(root,'data-'+run,'world.sqlite'))
      try{privateStimulusRecords=store.readEvents(core.address).filter(event=>
        event.eventType==='observation.upsert'&&JSON.stringify(event.data).includes('留守者独有的夹具暗号。')).length}
      finally{store.close()}
    }
    if(message.command==='narrate-and-revoke'){await core.submit('我先看看客厅。');revoked=true}
    const view=projectPlayerView(await runtime.state())
    process.send?.({id:message.id,accepted,providerCalls,view,moveEntered,replyEntered,privateStimulusRecords})
  }catch(error){process.send?.({id:message.id,error:error instanceof Error?error.message:String(error)})}
})
const close=async()=>{releaseMove?.();releaseReply?.();server.closeAllConnections();server.close();await core.close();await provider.close();process.exit(0)}
process.on('SIGTERM',close);process.on('SIGINT',close)
