/** Offline UX fixture. It changes the authored launch conditions, not the official battle operations. */
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { type ContentGenerator } from '@perspectra/sdk'
import type { WorldJsonObject } from '@perspectra/sdk/contracts'
import { assembleRoleplay, officialRpgContent } from '../../apps/host/src/official-bundle.ts'
import { createHostServer, type HostState } from '../../apps/host/src/runtime/http-server.ts'
import { projectPlayerView } from '../../apps/host/src/runtime/frontend-adapter.ts'
import { loadPackWeb } from '../../apps/host/src/runtime/pack-frontend.ts'
import { openRpgFixture, type RpgFixture } from '../support/rpg-fixture.ts'

const home='location:living-room', hall='location:bedroom', cheng='character:cheng'
const key='rpg-map-living-room'
const selection={min:1,max:1,candidates:[cheng]}
const content:ContentGenerator={
  ...officialRpgContent,
  generate(raw,pack){
    const generated=officialRpgContent.generate(raw,pack)
    const launch=generated.activities?.find(entry=>entry.key===key)
    if(!launch)throw new Error('RPG fixture has no living-room battle')
    // Keep the original hook identity for the existing official battle renderer registration.
    Reflect.deleteProperty(launch.activity.definition,'npcIds')
    Object.assign(launch.activity.definition,{title:'RPG 客厅训练',opening:'客厅训练开始。',participants:{mode:'player-select',...selection}})
    delete launch.activity.autoStart
    return {
      ...generated,
      gameplay:generated.gameplay?.map(module=>({
        ...module,
        activities:module.activities?.map(activity=>{
          if(activity.key!==key||!activity.behavior)return activity
          const {autoStart: _automatic,...behavior}=activity.behavior
          return {...activity,title:'RPG 客厅训练',behavior}
        })??[],
        restrictions:[
          ...(module.restrictions??[]),
          {id:'fixture:living-room-start',operations:['activity:start'],check:({parameters,world})=>
            parameters.activityKey===key&&world?.locationId!==home
              ? {code:'FIXTURE_WRONG_LOCATION',message:'需要回客厅。'}
              : undefined},
        ],
      }))??[],
    }
  },
}

const create=()=>openRpgFixture({
  composition:assembleRoleplay({content:[content]}),
  places:{'character:player':hall,[cheng]:home,'character:aru':home},
  edit(pack){
    const path=join(pack,'locations.json'),locations=JSON.parse(readFileSync(path,'utf8'))
    locations.locations.find((row:{locationId:string})=>row.locationId===hall).name='走廊'
    writeFileSync(path,JSON.stringify(locations))
  },
  config(config){
    const training=config.maps[0]
    config.maps=[{...training,locationId:home,engage:'on-enter',exits:[],drops:[],scripted:[],
      narration:{first:'客厅训练开始。'}}]
    config.enemies.golem.hp=22
    for(const stat of config.stats)stat.locations=[home]
  },
  async decide(input){
    const context=input.context as WorldJsonObject, activity=context.activity as WorldJsonObject|undefined
    const game=activity?.game as WorldJsonObject|undefined
    if(game?.phase==='fighting'&&game.turn===cheng&&!input.continuation&&activity){
      await new Promise(resolve=>setTimeout(resolve,850))
      return {decision:'perform',actionType:'interact',parameters:{
        targetRef:{kind:'character',id:cheng},bindingId:activity.id,
        definitionRef:{id:'activity:guard',version:1},arguments:{activityId:activity.id,revision:activity.revision},
      }}
    }
    return {decision:'abstain'}
  },
})
let fixture:RpgFixture=await create(), revoked=false
// The fixture models the discovery projection of the authored restriction. The current public
// interface carries no authorized advance reason for an unavailable start, so it offers no row.
function offeredState(state:HostState):HostState{
  if(state.world.currentScene?.locationId===home&&!revoked)return state
  const activities=state.activities?.map(activity=>activity.activityKey===key?{...activity,manualStart:false}:activity)
  const activity=state.activity?.activityKey===key?{...state.activity,manualStart:false}:state.activity
  return {...state,...(activities?{activities}:{}),...(activity?{activity}:{})}
}
const art=await loadPackWeb(resolve('examples/world-packs/model-girls-sweet-days'))
if(!art)throw new Error('Missing fixture art')
const assets=new Map(art.assets)
const hallArt=assets.get('/frontend/custom/backgrounds/entrance-shop.jpg')
const chengArt=assets.get('/frontend/custom/portraits/claude.png')
if(hallArt)assets.set('/frontend/custom/backgrounds/bedroom.jpg',hallArt)
if(chengArt)assets.set('/frontend/custom/portraits/cheng.png',chengArt)
assets.set('/frontend/custom/theme.css',{contentType:'text/css; charset=utf-8',bytes:readFileSync(resolve('layout-compare/theme.css'))})
const server=createHostServer({
  state:async()=>offeredState(await fixture.runtime.state()),
  submit:async(...args)=>offeredState(await fixture.runtime.submit(...args)),
  perform:async(...args)=>offeredState(await fixture.runtime.perform(...args)),
  activityAction:async(...args)=>offeredState(await fixture.runtime.activityAction(...args)),
  escape:async()=>offeredState(await fixture.runtime.escape()),
  pause:async()=>offeredState(await fixture.runtime.pause()),
  resume:async()=>offeredState(await fixture.runtime.resume()),
  close:()=>fixture.close(),
},'f'.repeat(64),{theme:true,assets,manifest:art.manifest,digest:art.digest,stage:{characters:{}}})
server.listen(0,'127.0.0.1',()=>{const a=server.address();if(a&&typeof a==='object')console.log('Preview ready on port '+a.port)})
process.on('message',async(message:{id:number;command:string})=>{
  try{
    if(message.command==='reset'){await fixture.close();fixture=await create();revoked=false}
    if(message.command==='revoke')revoked=true
    if(message.command==='allow')revoked=false
    let refusal:string|undefined
    if(message.command==='start-in-hall'){
      try{await fixture.runtime.activityAction({activityKey:key,activityId:null,revision:0,operation:'start',parameters:{npcIds:[cheng]},requestId:'offline-hall-start'})}
      catch(error){refusal=error instanceof Error?error.message:String(error)}
    }
    const state=offeredState(await fixture.runtime.state())
    const active=state.activities?.find(activity=>activity.activityKey===key)
    process.send?.({id:message.id,view:projectPlayerView(state),active:active?{
      id:active.id,revision:active.revision,participants:active.participants,suspended:active.suspended,
      round:(active.game as WorldJsonObject|undefined)?.round,
    }:null,refusal})
  }catch(error){process.send?.({id:message.id,error:error instanceof Error?error.message:String(error)})}
})
async function close(){server.closeAllConnections();server.close();await fixture.close();process.exit(0)}
process.on('SIGTERM',close);process.on('SIGINT',close)
