import { readFileSync, writeFileSync, copyFileSync, mkdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
const output=resolve(process.argv[2]??'')
if(!process.argv[2]||existsSync(resolve(output,'verification.json')))throw new Error('choose new artifact directory')
mkdirSync(output,{recursive:true})
const read=(p:string)=>JSON.parse(readFileSync(p,'utf8'))
const lines=(p:string):Record<string,any>[]=>readFileSync(p,'utf8').trim().split('\n').map(s=>JSON.parse(s))
const save=(file:string,v:unknown)=>writeFileSync(resolve(output,file),JSON.stringify(v,null,2)+'\n',{flag:'wx'})
const mapping=read('.tmp/jev-intervention-review/mapping.json') as {id:string;run:string;seq:number}[]
const review=read('.tmp/jev-intervention-review/judgments.json') as {reviewer:string;scope:string;judgments:{id:string;status:string}[]}
const runs=[]
let sameInputs:string|undefined
for(const name of ['a1','a2','a3','b1','b2','b3']){
  const root=resolve('.tmp/jev-intervention-20260927-'+name),summary=read(resolve(root,'summary.json'))
  const turns=lines(resolve(root,'turns.jsonl')),drafts=lines(resolve(root,'interventions.jsonl'))
  const inputs=JSON.stringify(turns.map(t=>t.submitted))
  if(sameInputs!==undefined&&sameInputs!==inputs)throw new Error('inputs differ')
  sameInputs=inputs
  const db=new DatabaseSync(resolve(root,'world.sqlite'),{readOnly:true})
  const raw=db.prepare('SELECT * FROM events ORDER BY seq').all();db.close()
  const events=raw.map(r=>({seq:Number(r.seq),transactionId:String(r.transaction_id),eventType:String(r.event_type),data:JSON.parse(String(r.data_json))}))
  let changedPublicationContexts=0,unpublishedFinals=0
  for(const r of drafts){
    const past=events.filter(e=>e.seq<=r.baseHeadSeq)
    const observed=past.filter(e=>e.eventType==='observation.upsert'&&e.data.value.observerId===r.actorId&&e.data.value.content.speech!==undefined)
    const tx=new Set(observed.map(o=>o.transactionId))
    const old=past.filter(e=>e.eventType==='character.speak'&&tx.has(e.transactionId)).slice(-12).map(e=>e.seq)
    const current=past.filter(e=>e.eventType==='character.speak'&&observed.some(o=>o.transactionId===e.transactionId&&JSON.stringify(o.data.value.content.speech)===JSON.stringify(e.data))).slice(-12).map(e=>e.seq)
    if(JSON.stringify(old)!==JSON.stringify(current))changedPublicationContexts++
    const next=events.find(e=>e.seq>r.baseHeadSeq&&e.eventType==='character.speak')
    if(r.final.decision==='publish'&&!(next&&next.data.characterId===r.actorId&&(next.data.text??'')===(r.final.speech??'')&&(next.data.narration??'')===(r.final.narration??'')))unpublishedFinals++
  }
  if(changedPublicationContexts||unpublishedFinals)throw new Error('publication verification failed')
  const ids=new Set(mapping.filter(m=>m.run===name).map(m=>m.id))
  const judgments=review.judgments.filter(j=>ids.has(j.id))
  const personConflicts=judgments.filter(j=>j.status==='objective_unsupported_person_hold').length
  const groundConflicts=judgments.filter(j=>j.status==='objective_unsupported_ground').length
  const {findings:_findings,...compact}=summary
  save(name+'-summary.json',{...compact,npcPublications:ids.size,personConflicts,groundConflicts,
    sourceEventsDigest:createHash('sha256').update(JSON.stringify(raw)).digest('hex'),changedPublicationContexts,unpublishedFinals})
  for(const file of ['jev-shadow.jsonl','interventions.jsonl','turns.jsonl','protocol.json'])copyFileSync(resolve(root,file),resolve(output,name+'-'+file))
  save(name+'-formal-items.json',events.filter(e=>['entity.upsert','entity.transferred','entity.taken'].includes(e.eventType)))
  runs.push({name,mode:summary.mode,rounds:summary.rounds,npcPublications:ids.size,personConflicts,groundConflicts,repairs:summary.repairCalls,
    modelCalls:summary.providerCalls,latencyMs:summary.latencyMs,jevCostUsd:summary.jevCostUsd,preAuditCostUsd:summary.preAuditCostUsd,
    errors:summary.failedRounds,auditComplete:summary.auditComplete,worldUnchanged:summary.unchangedDuringAuditDrain})
}
for(const file of ['cases.jsonl','mapping.json','judgments.json'])copyFileSync(resolve('.tmp/jev-intervention-review',file),resolve(output,'review-'+file))
for(const file of ['fixture.json','results.jsonl','summary.json'])copyFileSync(resolve('.tmp/jev-intervention-failures-20260927',file),resolve(output,'failure-probe-'+file))
for(const file of ['fixture.json','jev-shadow.jsonl','summary.json'])copyFileSync(resolve('.tmp/jev-intervention-temporal-20260927',file),resolve(output,'temporal-'+file))
save('verification.json',{runs,inputsIdentical:true,reviewer:review.reviewer,reviewScope:review.scope,
  targetedRepairSupported:true,broadEffectivenessAccepted:false,reason:'One false repair; ground placement undetected; later unsupported recalls; only three independent worlds per arm, with baseline conflicts concentrated in one world.'})
console.log(JSON.stringify({output,runs:runs.map(({latencyMs:_latency,...r})=>r)}))
