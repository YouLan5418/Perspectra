import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { brandId, type StoredWorldEvent, type WorldJsonObject, type WorldAddress } from '@harness-world/contracts'
import { currentEntityState, currentLocation } from '@harness-world/kernel'
import { acquisitionWindow, holderEvidence, publicationWindow } from './jev-shadow-window.ts'
import { createClaimClassifier, type ClaimAnswer, type ClaimQuestion } from './jev-shadow-claims-client.ts'
const directory=resolve(process.argv[2]??'')
if(!process.argv[2]||existsSync(resolve(directory,'fixture.json')))throw new Error('choose new directory')
mkdirSync(directory,{recursive:true})
const items=[{entityId:'entity:brass-key',name:'黄铜钥匙',aliases:['钥匙']},{entityId:'entity:thermos',name:'保温杯'}]
const characters=[{characterId:'character:player',name:'玩家'},{characterId:'character:companion',name:'同行者'},{characterId:'character:friend',name:'留守者'}]
const load=(root:string)=>{
  const db=new DatabaseSync(resolve(root,'world.sqlite'),{readOnly:true})
  const rows=db.prepare('SELECT * FROM events ORDER BY seq').all();db.close()
  const parts=String(rows[0]!.address_key).split('\u001f')
  const address:WorldAddress={tenantId:brandId(parts[0]!,'TenantId'),worldId:brandId(parts[1]!,'WorldId'),branchId:brandId(parts[2]!,'BranchId')}
  return rows.map(r=>({address,seq:Number(r.seq),tick:Number(r.tick),eventType:String(r.event_type),eventVersion:Number(r.event_version),data:JSON.parse(String(r.data_json)),
    transactionId:brandId(String(r.transaction_id),'TransactionId'),eventOrdinal:Number(r.event_ordinal),eventHash:String(r.event_hash) as StoredWorldEvent['eventHash'],previousHash:String(r.previous_hash) as StoredWorldEvent['previousHash']}))
}
function fixture(root:string,run:string,seq:number,item:number,conflict:boolean,group:string,draft=false){
  const events=load(root),e=events[seq-1]!
  const r=draft?readFileSync(resolve(root,'interventions.jsonl'),'utf8').trim().split('\n').map(s=>JSON.parse(s)).find(r=>r.baseHeadSeq===seq):undefined
  const d=e.data as WorldJsonObject
  const end=draft?seq:events.filter(p=>p.transactionId===e.transactionId).at(-1)!.seq,history=events.slice(0,end)
  const actorId=String(r?.actorId??d.characterId)
  const publication={seq:draft?seq+1:seq,actorId,speech:String(r?.original.speech??d.text??''),narration:String(r?.original.narration??d.narration??'')}
  const window=acquisitionWindow(history,draft?{roundId:null,fromSeq:end,toSeq:end,kind:'round'}:publicationWindow(events,seq))
  const observed=history.filter(p=>p.eventType==='observation.upsert'&&(p.data as any).value.observerId===actorId)
  const earlierPublications=history.filter(p=>p.eventType==='character.speak'&&p.seq<publication.seq&&(!draft||observed.some(o=>o.transactionId===p.transactionId&&JSON.stringify((o.data as any).value.content.speech)===JSON.stringify(p.data)))).slice(-12)
    .map(p=>{const d=p.data as WorldJsonObject;return {seq:p.seq,actorId:String(d.characterId),speech:String(d.text??''),narration:String(d.narration??'')}})
  const question:ClaimQuestion={item:items[item]!,items,characters,publication,earlierPublications,round:window}
  const state=currentEntityState(history,question.item.entityId)
  return {id:run+'-'+seq+'-'+item,source:{root,run,seq,draft},conflict,group,question,world:{state,ground:state?.holderId===null&&state.locationId===currentLocation(history,actorId),
    persons:characters.map(c=>({characterId:c.characterId,...holderEvidence(history,window,question.item.entityId,c.characterId)})),
    releases:history.slice(window.fromSeq).filter(e=>e.eventType==='entity.transferred'&&(e.data as WorldJsonObject).entityId===question.item.entityId&&(e.data as WorldJsonObject).toHolderId===null&&typeof(e.data as WorldJsonObject).fromHolderId==='string').map(e=>e.seq)}}
}
let fixtures:ReturnType<typeof fixture>[]
const fixtureIndex=process.argv.indexOf('--fixture')
if(fixtureIndex>=0)fixtures=JSON.parse(readFileSync(resolve(process.argv[fixtureIndex+1]!),'utf8')).fixtures
else {
  const source='.tmp/jev-placement-live-20260927-'
  const cases:[string,number,number,boolean,string,boolean][]=[
    ['b1',76,1,true,'positive',true],['b1',93,1,false,'contact',true],['b1',142,1,true,'positive',true],['b1',176,1,true,'positive',true],['b1',193,1,true,'positive',true],
    ['b2',209,1,true,'positive',true],['b2',214,1,false,'ambiguous',true],['b2',316,0,false,'speech_past',true],['b2',339,0,false,'speech_past',true],['b2',374,0,true,'positive',true],
    ['a2',162,1,false,'held_table',false],['b1',105,1,false,'contact',false],['a1',144,0,false,'target_absent',false],['a2',151,0,false,'target_absent',false],
  ]
  fixtures=cases.map(([run,seq,item,conflict,group,draft])=>fixture(source+run,run,seq,item,conflict,group,draft))
  const old=JSON.parse(readFileSync('experiments/jev-narrative-auditor/placement-2026-09-27/probe-new02-fixture.json','utf8')).fixtures
  for(const f of old.filter((f:any)=>f.id.startsWith('real-placement-')||['real-table-slide','real-formal-cup-take','real-formal-key-give'].includes(f.id))){
    fixtures.push(fixture('.tmp/jev-intervention-20260927-'+f.run,'old-'+f.run,f.seq,f.item,f.conflict,f.conflict?'positive':'formal_or_slide',f.draft))
  }
}
writeFileSync(resolve(directory,'fixture.json'),JSON.stringify({repeat:3,fixtures},null,2)+'\n',{flag:'wx'})
writeFileSync(resolve(directory,'classifier-source.ts'),readFileSync('tests/experiments/jev-shadow-claims-client.ts'))
const classify=createClaimClassifier(process.env.OPENROUTER_JEV_KEY??'')
const results:Array<{id:string;group:string;repeat:number;expectedConflict:boolean;actualConflict:boolean|null;match:boolean|null;personConflicts:string[];placementConflict:boolean;answer?:ClaimAnswer;error?:string}>=[]
for(const f of fixtures)for(let repeat=1;repeat<=3;repeat++){
  let answer:ClaimAnswer
  try {answer=await classify(f.question)} catch {
    const row={id:f.id,group:f.group,repeat,expectedConflict:f.conflict,actualConflict:null,match:null,personConflicts:[],placementConflict:false,error:'Jev call failed'}
    results.push(row);appendFileSync(resolve(directory,'results.jsonl'),JSON.stringify(row)+'\n');continue
  }
  const personConflicts=answer.claims.filter(c=>{
    const p=f.world.persons.find(p=>p.characterId===c.characterId)!
    return c.kind==='OBJECTIVE_NOW'?f.world.state?.holderId!==c.characterId:c.kind==='OBJECTIVE_NEW'?p.enteredSeqs.length===0:c.kind==='OBJECTIVE_DURING'?!p.heldAtWindowStart&&p.enteredSeqs.length===0:false
  }).map(c=>c.characterId)
  const kind=answer.placement.kind
  const placementConflict=kind==='OBJECTIVE_GROUND'?!f.world.ground:kind==='OBJECTIVE_RELEASE'?(!f.world.ground||f.world.releases.length===0):false
  const actualConflict=personConflicts.length>0||placementConflict
  const row={id:f.id,group:f.group,repeat,expectedConflict:f.conflict,actualConflict,match:actualConflict===f.conflict,personConflicts,placementConflict,answer}
  results.push(row);appendFileSync(resolve(directory,'results.jsonl'),JSON.stringify(row)+'\n')
}
const groups=Object.fromEntries([...new Set(results.map(r=>r.group))].map(group=>{const rows=results.filter(r=>r.group===group);return [group,{checks:rows.length,matched:rows.filter(r=>r.match).length,flagged:rows.filter(r=>r.actualConflict).length,failed:rows.filter(r=>r.error).length}]}))
const summary={checks:results.length,failed:results.filter(r=>r.error).length,matched:results.filter(r=>r.match).length,costUsd:results.reduce((s,r)=>s+(r.answer?.costUsd??0),0),groups}
writeFileSync(resolve(directory,'summary.json'),JSON.stringify(summary,null,2)+'\n')
console.log(JSON.stringify(summary))
