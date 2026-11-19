/** Isolated UX fixture: official Core + author status rules + local deterministic provider.
 * Uses PlayerView and one boolean from the NPC’s authorized decision context. */
import { mkdtempSync, cpSync, readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createRoleplayCore } from '../support/roleplay-runtime.ts'
import { fakeModels, startFakeProvider } from '../support/fake-provider.ts'
import { createHostServer, type HostRuntime, type HostState } from '../../apps/host/src/runtime/http-server.ts'
import { projectPlayerView } from '../../apps/host/src/runtime/frontend-adapter.ts'
import { loadPackWeb } from '../../apps/host/src/runtime/pack-frontend.ts'

mkdirSync(resolve('.tmp'), { recursive: true })
const root=mkdtempSync(resolve('.tmp/ux-character-')),pack=join(root,'pack')
cpSync(resolve('examples/world-packs/status-market'),pack,{recursive:true})
function replaceFixtureText(directory:string){
  for(const entry of readdirSync(directory,{withFileTypes:true})){
    const path=join(directory,entry.name)
    if(entry.isDirectory())replaceFixtureText(path)
    else if(/\.(json|js|cjs|md)$/.test(entry.name))writeFileSync(path,readFileSync(path,'utf8').replaceAll('entity:thermos','entity:cup').replaceAll('保温杯','茶杯').replaceAll('character:companion','character:gpt').replaceAll('同行者','GPT-6').replaceAll('location:front-room','location:living-room').replaceAll('scene:front-room','scene:living-room').replaceAll('集市摊位','客厅').replaceAll('location:back-room','location:hallway').replaceAll('scene:back-room','scene:hallway').replaceAll('后巷','走廊').replaceAll('留守者','Claude'))
  }
}
replaceFixtureText(pack)
const world=JSON.parse(readFileSync(join(pack,'world.json'),'utf8'));world.title='角色详情 · 隔离夹具';writeFileSync(join(pack,'world.json'),JSON.stringify(world))
const entities=JSON.parse(readFileSync(join(pack,'entities.json'),'utf8'));entities.entities[0].kind='白瓷茶杯';entities.entities.push({entityId:'entity:lamp',locationId:'location:living-room',kind:'固定照明设备',name:'固定台灯'});entities.entities.push({entityId:'entity:private-notebook',locationId:'location:living-room',kind:'私密随身记录',name:'密封笔记'});entities.entities.push({entityId:'entity:umbrella',locationId:'location:hallway',kind:'雨具',name:'长柄伞'});writeFileSync(join(pack,'entities.json'),JSON.stringify(entities))
const locations=JSON.parse(readFileSync(join(pack,'locations.json'),'utf8'));locations.locations.push({locationId:'location:hidden',name:'未发现的储藏室'});writeFileSync(join(pack,'locations.json'),JSON.stringify(locations))
const characters=JSON.parse(readFileSync(join(pack,'characters.json'),'utf8'));characters.characters.find((c:{characterId:string})=>c.characterId==='character:friend').initialLocationId='location:hallway';writeFileSync(join(pack,'characters.json'),JSON.stringify(characters))
const scenes=JSON.parse(readFileSync(join(pack,'scenes.json'),'utf8'));scenes.scenes[0].participantIds=scenes.scenes[0].participantIds.filter((id:string)=>id!=='character:friend');scenes.scenes[1].lifecycle='active';scenes.scenes[1].participantIds=['character:friend'];writeFileSync(join(pack,'scenes.json'),JSON.stringify(scenes))
// Public, fixture-authored lamp toggle. No take option or invented refusal reason for the lamp.
const script=join(pack,'scripts/status.js')
writeFileSync(script,readFileSync(script,'utf8')+`
;statusScript.definition.statuses.push({key:'lamp-on',label:'台灯',type:'boolean',owner:'public',alwaysKnown:true,bar:false});
statusScript.definition.operations.push({id:'lamp-toggle',label:'开关台灯',targets:['entity:lamp'],schema:{type:'object',additionalProperties:false,properties:{}}});
const oldInit=statusScript.initialize,oldPolicy=statusScript.policy,oldResolve=statusScript.resolve;
statusScript.initialize=(ids)=>{const value=oldInit(ids);value.public['lamp-on']=false;return value};
statusScript.policy=(known,actor,place)=>{const value=oldPolicy(known,actor,place);value.operations.push('lamp-toggle');value.targets['lamp-toggle']=place.items.filter(item=>item.entityId==='entity:lamp'&&item.holderId===null).map(item=>item.entityId);return value};
const lampResolve=(truth,actor,operation,args,world,target)=>operation==='lamp-toggle'?{changes:[{holderId:null,key:'lamp-on',value:!truth.public['lamp-on']}],reveals:[],description:truth.public['lamp-on']?'关闭了台灯。':'打开了台灯。',audience:'scene'}:oldResolve(truth,actor,operation,args,world,target);
statusScript.definition.operations.find(operation=>operation.id==='take').targets.push('entity:private-notebook');
const lampPolicy=statusScript.policy;
statusScript.policy=(known,actor,place)=>{
  const value=lampPolicy(known,actor,place);
  if(actor!=='character:gpt')value.targets.take=value.targets.take.filter(id=>id!=='entity:private-notebook');
  return value;
};
statusScript.resolve=(truth,actor,operation,args,world,target)=>{
  if(operation==='take'&&target==='entity:private-notebook'){
    if(actor!=='character:gpt')return {rejectReason:'操作不可用。'};
    return {changes:[],reveals:[],items:[{entityId:target,to:{holderId:actor}}],description:'收好了随身记录。',audience:'self'};
  }
  return lampResolve(truth,actor,operation,args,world,target);
};

`)
type FixtureStep = 'private' | 'cup' | 'leave'
let providerCalls=0,run=0,step:FixtureStep|null=null,privateHeld=false
const provider=await startFakeProvider('openai',call=>{
  providerCalls++
  const {context}=JSON.parse(call.userText)
  if(context?.character?.characterId!=='character:gpt')return {tool:{decision:'abstain'}}
  privateHeld ||= (context.items?.current??[]).some((item:{entityId:string;holderId:string})=>
    item.entityId==='entity:private-notebook'&&item.holderId==='character:gpt')
  const next=step
  step=null
  if(next==='leave')return {tool:{decision:'perform',actionType:'move',parameters:{locationId:'location:hallway'}}}
  if(next==='private'||next==='cup')return {tool:{decision:'perform',actionType:'interact',parameters:{
    targetRef:{kind:'entity',id:next==='private'?'entity:private-notebook':'entity:cup'},
    bindingId:'status',definitionRef:{id:'status:take',version:1},arguments:{},
  }}}
  return {tool:{decision:'abstain'}}
})
async function create(){
  const runtime=await createRoleplayCore({
    packPath:pack,dataDirectory:join(root,'data-'+(++run)),
    models:fakeModels(provider.endpoint),timeoutMs:5000,serialScheduling:true,
  })
  privateHeld=false
  step='private'
  await runtime.submit('我在客厅稍坐一会儿。')
  if(!privateHeld)await runtime.submit('我们慢慢聊。')
  if(!privateHeld)throw new Error('Fixture NPC could not confirm private custody in its own authorized view')
  return runtime
}
let core=await create()
// Applies the same fixture-only location filter to state updates and action results.
function authorizedFixtureState(state:HostState):HostState{
  return {
    ...state,
    availableActions:(state.availableActions??[]).map(offer=>offer.actionType==='move'
      ? {...offer,destinations:(offer.destinations??[]).filter(place=>place.locationId!=='location:hidden')}
      :offer),
  }
}
const runtime:HostRuntime={
  state:async()=>authorizedFixtureState(await core.state()),
  submit:async(...args)=>authorizedFixtureState(await core.submit(...args)),
  perform:async(...args)=>authorizedFixtureState(await core.perform(...args)),
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
    if(message.command==='reset'){await core.close();core=await create()}
    if(message.command==='npc-take'){
      step='cup';await core.submit('你可以看看桌上的茶杯。')
    }
    if(message.command==='npc-leave'){
      step='leave';await core.submit('你可以先去走廊。')
    }
    if(message.command==='player-move'){
      const option=projectPlayerView(await runtime.state()).actions.find(action=>action.id==='move:location:hallway');
      if(!option)throw new Error('No move offer');
      await core.perform(option.action);
    }
    const view=projectPlayerView(await runtime.state())
    process.send?.({id:message.id,providerCalls,view,privateHeld})
  }catch(error){process.send?.({id:message.id,error:error instanceof Error?error.message:String(error)})}
})
const close=async()=>{server.closeAllConnections();server.close();await core.close();await provider.close();process.exit(0)}
process.on('SIGTERM',close);process.on('SIGINT',close)
