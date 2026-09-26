import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { brandId, type StoredWorldEvent, type WorldJsonObject, type WorldAddress } from '@harness-world/contracts'
import { currentEntityState } from '@harness-world/kernel'
import { acquisitionWindow, holderEvidence, publicationWindow } from './jev-shadow-window.ts'
import { createClaimClassifier, type ClaimQuestion } from './jev-shadow-claims-client.ts'
const directory=resolve(process.argv[2]??'')
if(!process.argv[2]||existsSync(resolve(directory,'fixture.json')))throw new Error('choose new directory')
mkdirSync(directory,{recursive:true})
const repeat=process.argv.includes('--once')?1:3
const itemList=[{entityId:'entity:brass-key',name:'黄铜钥匙',aliases:['钥匙']},{entityId:'entity:thermos',name:'保温杯'}]
const sourceRoot='.tmp/jev-intervention-20260927-'
function load(name:string){
  const db=new DatabaseSync(resolve(sourceRoot+name,'world.sqlite'),{readOnly:true})
  const rows=db.prepare('SELECT * FROM events ORDER BY seq').all();db.close()
  const parts=String(rows[0]!.address_key).split('\u001f')
  const address:WorldAddress={tenantId:brandId(parts[0]!,'TenantId'),worldId:brandId(parts[1]!,'WorldId'),branchId:brandId(parts[2]!,'BranchId')}
  return rows.map(r=>({address,seq:Number(r.seq),tick:Number(r.tick),eventType:String(r.event_type),eventVersion:Number(r.event_version),data:JSON.parse(String(r.data_json)),
    transactionId:brandId(String(r.transaction_id),'TransactionId'),eventOrdinal:Number(r.event_ordinal),eventHash:String(r.event_hash) as StoredWorldEvent['eventHash'],previousHash:String(r.previous_hash) as StoredWorldEvent['previousHash']}))
}
const characters=[{characterId:'character:player',name:'玩家'},{characterId:'character:companion',name:'同行者'},{characterId:'character:friend',name:'留守者'}]
const cases=[{run:'b1',seq:95,draft:true,item:1,conflict:false,id:'real-table-slide'},
  {run:'b2',seq:176,draft:true,item:1,conflict:true,id:'real-uncommitted-cup-take'},
  {run:'b3',seq:37,draft:true,item:0,conflict:true,id:'real-uncommitted-key-take'},
  ...[365,370,407,413,430,436].map(seq=>({run:'b2',seq,draft:false,item:seq<400?1:0,conflict:true,id:'real-placement-'+seq})),
  {run:'b2',seq:194,draft:false,item:1,conflict:false,id:'real-formal-cup-take'},
  {run:'b1',seq:119,draft:false,item:0,conflict:false,id:'real-formal-key-give'}]
const fixtures=cases.map(c=>{
  const events=load(c.run), at=c.seq, event=events[at-1]!
  const draft=c.draft?readFileSync(resolve(sourceRoot+c.run,'interventions.jsonl'),'utf8').trim().split('\n').map(s=>JSON.parse(s)).find(r=>r.baseHeadSeq===at).original:undefined
  const d=event.data as WorldJsonObject
  const publication={seq:c.draft?at+1:at,actorId:c.draft?String(readFileSync(resolve(sourceRoot+c.run,'interventions.jsonl'),'utf8').trim().split('\n').map(s=>JSON.parse(s)).find(r=>r.baseHeadSeq===at).actorId):String(d.characterId),
    speech:String(draft?.speech??d.text??''),narration:String(draft?.narration??d.narration??'')}
  const end=c.draft?at:events.filter(e=>e.transactionId===event.transactionId).at(-1)!.seq
  const history=events.slice(0,end)
  const window=acquisitionWindow(history,c.draft?{roundId:null,fromSeq:at,toSeq:at,kind:'round'}:publicationWindow(events,at))
  const prior=history.filter(e=>e.eventType==='character.speak'&&e.seq<publication.seq).slice(-12).map(e=>{const d=e.data as WorldJsonObject;return {seq:e.seq,actorId:String(d.characterId),speech:String(d.text??''),narration:String(d.narration??'')}})
  const question:ClaimQuestion={items:itemList,item:itemList[c.item]!,characters,publication,earlierPublications:prior,round:window}
  return {...c,question,world:{state:currentEntityState(history,question.item.entityId),window,persons:characters.map(person=>({characterId:person.characterId,...holderEvidence(history,window,question.item.entityId,person.characterId)})),
    releases:history.slice(window.fromSeq).filter(e=>e.eventType==='entity.transferred'&&(e.data as WorldJsonObject).entityId===question.item.entityId&&(e.data as WorldJsonObject).toHolderId===null).map(e=>e.seq)}}
})
// Constructed negative controls complement, but do not inflate, the real-source case count.
for(const [id,narration,speech] of [
  ['slide-explicit','留守者把桌上的保温杯沿桌面往旁边推了半寸，杯底没有离开桌面。',''],
  ['future-release','留守者仍握着黄铜钥匙，想了想，没有松手。','等你准备好了，我再把钥匙放下。'],
  ['speech-release','','我已经把钥匙放桌上了。'],
  ['past-release','留守者回想昨天把黄铜钥匙放在桌上的经历，今天没有动它。',''],
] as const){
  const base=fixtures.find(f=>f.id==='real-placement-407')!
  const item=id==='slide-explicit'?itemList[1]!:itemList[0]!
  fixtures.push({...base,id,conflict:false,question:{...base.question,item,publication:{...base.question.publication,narration,speech}},world:{...base.world,
    state:id==='slide-explicit'?{...base.world.state!,entityId:item.entityId,holderId:null,locationId:'location:front-room'}:base.world.state}})
}
writeFileSync(resolve(directory,'fixture.json'),JSON.stringify({classifier:'placement-final',repeat,fixtures},null,2)+'\n',{flag:'wx'})
const classify=createClaimClassifier(process.env.OPENROUTER_JEV_KEY??'')
const results=[]
for(const f of fixtures)for(let n=1;n<=repeat;n++){
  const answer=await classify(f.question)
  const personConflicts=answer.claims.filter(c=>{
    const p=f.world.persons.find(p=>p.characterId===c.characterId)!
    return c.kind==='OBJECTIVE_NOW'?f.world.state?.holderId!==c.characterId:c.kind==='OBJECTIVE_NEW'?p.enteredSeqs.length===0:c.kind==='OBJECTIVE_DURING'?!p.heldAtWindowStart&&p.enteredSeqs.length===0:false
  }).map(c=>c.characterId)
  const placement=(answer as typeof answer & {placement?:{kind:string}}).placement
  const placementConflict=placement?.kind==='OBJECTIVE_GROUND'?f.world.state?.holderId!==null:
    placement?.kind==='OBJECTIVE_RELEASE'?(f.world.state?.holderId!==null||f.world.releases.length===0):false
  const actual=personConflicts.length>0||placementConflict
  const row={id:f.id,repeat:n,expectedConflict:f.conflict,actualConflict:actual,match:actual===f.conflict,personConflicts,placementConflict,answer}
  results.push(row);appendFileSync(resolve(directory,'results.jsonl'),JSON.stringify(row)+'\n')
}
const summary={classifier:'placement-final',checks:results.length,matched:results.filter(r=>r.match).length,costUsd:results.reduce((s,r)=>s+(r.answer.costUsd??0),0),results}
writeFileSync(resolve(directory,'summary.json'),JSON.stringify(summary,null,2)+'\n')
console.log(JSON.stringify({...summary,results:results.map(({answer:_answer,...r})=>r)}))
