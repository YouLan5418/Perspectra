import { readFileSync, mkdirSync, writeFileSync, appendFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { brandId, type StoredWorldEvent, type WorldAddress, type WorldJsonObject } from '@harness-world/contracts'
import { JevShadow, type ShadowRecord, type Publication, type HolderQuestion } from './jev-shadow.ts'
import { createClaimClassifier } from './jev-shadow-claims-client.ts'

// Constructed event history, using verbatim publications from the frozen real incident.
// This tests the temporal counterfactual; it is not a new real playtest or real stored history.
const samples=JSON.parse(readFileSync(resolve('experiments/jev-narrative-auditor/historical-replay-2026-09-26/cases.json'),'utf8')) as Array<{id:string;question:HolderQuestion}>
const sample=(seq:number)=>samples.find(s=>s.id===`free:${seq}:entity:brass-key`)!.question
const directory=resolve(process.argv[2]??'')
if(!process.argv[2]||existsSync(resolve(directory,'jev-shadow.jsonl')))throw new Error('choose new directory')
mkdirSync(directory,{recursive:true})
const address:WorldAddress={tenantId:brandId('probe','TenantId'),worldId:brandId('temporal','WorldId'),branchId:brandId('main','BranchId')}
const events:StoredWorldEvent[]=[]
function add(eventType:string,data:WorldJsonObject,tx:number) {
  events.push({address,seq:events.length+1,eventType,data,eventVersion:1,tick:tx,previousHash:'genesis',eventHash:`sha256:${'0'.repeat(64)}`,
    transactionId:brandId(`tx:${tx}`,'TransactionId'),eventOrdinal:0})
}
const characters=sample(139).characters
for(const c of characters)add('character.created',{...c,locationId:'room'},1)
add('entity.upsert',{entityId:'entity:brass-key',kind:'key',locationId:'room'},1)
function transfer(from:string|null,to:string,tx:number) {add('entity.transferred',{entityId:'entity:brass-key',fromHolderId:from,fromLocationId:from===null?'room':null,toHolderId:to,toLocationId:null,characterId:from??to,interactionId:'give'},tx)}
transfer(null,'character:player',1)
const initialSeq=events.length
function input(text:string,tx:number) {
  add('character.speak',{characterId:'character:player',text,narration:''},tx)
  add('action.resolved',{sourceRole:'player',actorId:'character:player',participantId:'player',roundId:`round:${tx}`},tx)
  add('world.tick-advanced',{roundId:`round:${tx}`},tx)
}
function publish(original:Publication,tx:number) {
  add('character.speak',{characterId:original.actorId,text:original.speech,narration:original.narration},tx)
  const seq=events.length
  add('action.resolved',{sourceRole:'agent',actorId:original.actorId,participantId:`turn:${tx}`,roundId:`round:${tx}`},tx)
  add('world.tick-advanced',{roundId:`round:${tx}`},tx)
  return seq
}
input('我把钥匙给留守者看，摸完请还给我。',2)
transfer('character:player','character:friend',3)
transfer('character:friend','character:player',3)
const formal=publish(sample(139).publication,3) // Same atomic round: genuine intermediate hold and return.
input('回想刚才那一次摸钥匙的经历。现在钥匙仍在我手里，不用再拿。',4)
const memory=publish(sample(156).publication,5)
input('过了一会儿。留守者，这一次再凑近看看钥匙，我仍拿在手里。',6)
const imaginary=publish(sample(139).publication,7)
input('只说这一次刚发生的查看经过，不是第一次正式交接那次。',8)
const spread=publish(sample(221).publication,9)
const expected=[{seq:formal,person:'character:friend',status:'SUPPORTED',root:null},
  {seq:memory,person:'character:friend',status:'HISTORICAL_SUPPORTED',root:null},
  {seq:imaginary,person:'character:friend',status:'CONFLICT',root:imaginary},
  {seq:spread,person:'character:friend',status:'CHAIN_RECALL',root:imaginary}]
writeFileSync(resolve(directory,'fixture.json'),JSON.stringify({constructed:true,sourceIds:[139,156,139,221],events,expected},null,2)+'\n',{flag:'wx'})
const records:ShadowRecord[]=[]
const shadow=new JevShadow({address,characters,items:[sample(139).item],initialSeq,readEvents:seq=>events.slice(0,seq),
  classify:createClaimClassifier(process.env.OPENROUTER_JEV_KEY??''),write:async r=>{records.push(r);appendFileSync(resolve(directory,'jev-shadow.jsonl'),JSON.stringify(r)+'\n')}})
shadow.observe(events.length);await shadow.close()
const checks=expected.map(e=>{const c=records.find(r=>r.publication?.seq===e.seq)!.claims.find(c=>c.characterId===e.person)!
  return {...e,actual:c.status,actualRoot:c.rootPublicationSeq,kind:c.kind,referenceSeq:c.referenceSeq,match:c.status===e.status&&c.rootPublicationSeq===e.root}})
const summary={constructed:true,checks,costUsd:records.reduce((s,r)=>s+(r.answer?.costUsd??0),0),stats:shadow.stats()}
writeFileSync(resolve(directory,'summary.json'),JSON.stringify(summary,null,2)+'\n')
console.log(JSON.stringify(summary))
