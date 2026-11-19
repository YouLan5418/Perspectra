/** Isolated UX fixture: official Core + author status rules + local deterministic provider.
 * No user saves, external model or private-world reads. All assertions use PlayerView. */
import { mkdtempSync, cpSync, readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createRoleplayCore } from '../support/roleplay-runtime.ts'
import { fakeModels, startFakeProvider } from '../support/fake-provider.ts'
import { createHostServer, type HostRuntime } from '../../apps/host/src/runtime/http-server.ts'
import { projectPlayerView } from '../../apps/host/src/runtime/frontend-adapter.ts'
import { loadPackWeb } from '../../apps/host/src/runtime/pack-frontend.ts'

mkdirSync(resolve('.tmp'), { recursive: true })
const root=mkdtempSync(resolve('.tmp/ux-cup-')),pack=join(root,'pack')
cpSync(resolve('examples/world-packs/status-market'),pack,{recursive:true})
function replaceFixtureText(directory:string){
  for(const entry of readdirSync(directory,{withFileTypes:true})){
    const path=join(directory,entry.name)
    if(entry.isDirectory())replaceFixtureText(path)
    else if(/\.(json|js|cjs|md)$/.test(entry.name))writeFileSync(path,readFileSync(path,'utf8').replaceAll('entity:thermos','entity:cup').replaceAll('保温杯','茶杯').replaceAll('character:companion','character:gpt').replaceAll('同行者','GPT-6').replaceAll('location:front-room','location:living-room').replaceAll('scene:front-room','scene:living-room').replaceAll('集市摊位','客厅'))
  }
}
replaceFixtureText(pack)
const world=JSON.parse(readFileSync(join(pack,'world.json'),'utf8'));world.title='客厅物品纵切 · 隔离夹具';writeFileSync(join(pack,'world.json'),JSON.stringify(world))
const entities=JSON.parse(readFileSync(join(pack,'entities.json'),'utf8'));entities.entities[0].kind='白瓷茶杯';entities.entities.push({entityId:'entity:lamp',locationId:'location:living-room',kind:'固定照明设备',name:'固定台灯'});writeFileSync(join(pack,'entities.json'),JSON.stringify(entities))
const characters=JSON.parse(readFileSync(join(pack,'characters.json'),'utf8'));characters.characters.find((c:{characterId:string})=>c.characterId==='character:friend').initialLocationId='location:back-room';writeFileSync(join(pack,'characters.json'),JSON.stringify(characters))
const scenes=JSON.parse(readFileSync(join(pack,'scenes.json'),'utf8'));scenes.scenes[0].participantIds=scenes.scenes[0].participantIds.filter((id:string)=>id!=='character:friend');scenes.scenes[1].lifecycle='active';scenes.scenes[1].participantIds=['character:friend'];writeFileSync(join(pack,'scenes.json'),JSON.stringify(scenes))
// Public, fixture-authored lamp toggle. No take option or invented refusal reason for the lamp.
const script=join(pack,'scripts/status.js')
writeFileSync(script,readFileSync(script,'utf8')+`
;statusScript.definition.statuses.push({key:'lamp-on',label:'台灯',type:'boolean',owner:'public',alwaysKnown:true,bar:false});
statusScript.definition.operations.push({id:'lamp-toggle',label:'开关台灯',targets:['entity:lamp'],schema:{type:'object',additionalProperties:false,properties:{}}});
const oldInit=statusScript.initialize,oldPolicy=statusScript.policy,oldResolve=statusScript.resolve;
statusScript.initialize=(ids)=>{const value=oldInit(ids);value.public['lamp-on']=false;return value};
statusScript.policy=(known,actor,place)=>{const value=oldPolicy(known,actor,place);value.operations.push('lamp-toggle');value.targets['lamp-toggle']=place.items.filter(item=>item.entityId==='entity:lamp'&&item.holderId===null).map(item=>item.entityId);return value};
statusScript.resolve=(truth,actor,operation,args,world,target)=>operation==='lamp-toggle'?{changes:[{holderId:null,key:'lamp-on',value:!truth.public['lamp-on']}],reveals:[],description:truth.public['lamp-on']?'关闭了台灯。':'打开了台灯。',audience:'scene'}:oldResolve(truth,actor,operation,args,world,target);
`)
let npcTake=false,providerCalls=0,accepted=0,run=0
const provider=await startFakeProvider('openai',call=>{
  providerCalls++
  const input=JSON.parse(call.userText),actor=input.context?.character?.characterId
  if(npcTake&&actor==='character:gpt'){
    npcTake=false
    return {tool:{decision:'perform',actionType:'interact',parameters:{targetRef:{kind:'entity',id:'entity:cup'},bindingId:'status',definitionRef:{id:'status:take',version:1},arguments:{}}}}
  }
  return {tool:{decision:'abstain'}}
})
const create=()=>createRoleplayCore({packPath:pack,dataDirectory:join(root,'data-'+(++run)),models:fakeModels(provider.endpoint),timeoutMs:5000,serialScheduling:true})
let core=await create()
const runtime:HostRuntime={
  state:()=>core.state(),submit:(...args)=>core.submit(...args),
  perform:async(...args)=>{const result=await core.perform(...args);accepted++;return result},
  pause:()=>core.pause(),resume:()=>core.resume(),close:()=>core.close(),
}
const art=await loadPackWeb(resolve('examples/world-packs/model-girls-sweet-days'))
if(!art)throw new Error('Public artwork unavailable')
const assets=new Map(art.assets);assets.set('/frontend/custom/theme.css',{contentType:'text/css; charset=utf-8',bytes:readFileSync(resolve('layout-compare/theme.css'))})
const server=createHostServer(runtime,'f'.repeat(64),{theme:true,assets,manifest:art.manifest,digest:art.digest,stage:{characters:art.stage?.characters??{}}})
server.listen(0,'127.0.0.1',()=>{const address=server.address();if(address&&typeof address==='object')console.log('Preview ready on port '+address.port)})
process.on('message',async(message:{id?:number;command?:string})=>{
  try{
    let refusal:string|null=null
    if(message.command==='forged-lamp-take'){try{await core.perform({actionType:'interact',parameters:{targetRef:{kind:'entity',id:'entity:lamp'},bindingId:'status',definitionRef:{id:'status:take',version:1},arguments:{}}})}catch(error){refusal=error instanceof Error?error.message:String(error)}}
    if(message.command==='reset'){await core.close();accepted=0;npcTake=false;core=await create()}
    if(message.command==='npc-take'){npcTake=true;await core.submit('你可以看看桌上的茶杯。')}
    const view=projectPlayerView(await core.state())
    process.send?.({id:message.id,accepted,providerCalls,view,refusal})
  }catch(error){process.send?.({id:message.id,error:error instanceof Error?error.message:String(error)})}
})
const close=async()=>{server.closeAllConnections();server.close();await core.close();await provider.close();process.exit(0)}
process.on('SIGTERM',close);process.on('SIGINT',close)
