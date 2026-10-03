import { brandId, type WorldAddress, type WorldEventDraft, type WorldJsonObject } from '@harness-world/contracts'
import { currentSceneStates, type CompiledWorldManifest } from '@harness-world/kernel'
import type { WorldStore, WriterLeaseService } from '@harness-world/store-sqlite'

/** Experimental lodging Host: closed meetings end; a later visit needs a new empty Scene.
 * No movement, member join, dialogue or cognition is authored here. Normal move resolution does that.
 */
export async function ensureRoomScenes(store:WorldStore,leases:WriterLeaseService,address:WorldAddress,playerTurn:number){
 const stored=store.readManifest(address)
 if(stored===undefined)throw new Error('missing experiment manifest')
 const manifest=stored.manifest as CompiledWorldManifest,history=store.readEvents(address)
 const locations=new Map<string,string>()
 for(const event of history){
  const data=event.data as WorldJsonObject
  if(event.eventType==='scene.upsert'){
   const value=data.value as WorldJsonObject
   if(typeof value.locationId==='string')locations.set(String(data.sceneId),value.locationId)
  }else if(event.eventType==='scene.created'&&typeof data.locationId==='string')locations.set(String(data.sceneId),data.locationId)
 }
 const current=currentSceneStates(history),head=store.head(address)
 const missing=manifest.locations.filter(location=>!current.some(s=>s.lifecycle!=='closed'&&locations.get(s.sceneId)===location.locationId))
 if(missing.length===0)return undefined
 const events:WorldEventDraft[]=missing.map(location=>({eventType:'scene.created',eventVersion:1,
  data:{sceneId:'scene:continuous:'+location.locationId.split(':')[1]+':'+head.headSeq,locationId:location.locationId}}))
 const key='continuous-room-scenes:'+head.headSeq
 const owner='experiment-host:'+key,lease=leases.acquire(address,owner)
 try{
 const result=await store.commitRound({address,expectedHeadSeq:head.headSeq,expectedTick:head.tick,nextTick:head.tick+1,
  transactionId:brandId('transaction:'+key,'TransactionId'),roundId:brandId('round:'+key,'InteractionRoundId'),events,outbox:[],writerFencingToken:lease.fencingToken,correlationId:key})
 return {playerTurn,reason:'closed room scenes need a new empty meeting for later visits',beforeSeq:head.headSeq,
  beforeTick:head.tick,result,events}
 }finally{leases.release(address,owner,lease.fencingToken)}
}
