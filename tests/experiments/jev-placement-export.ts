import { readFileSync, writeFileSync, copyFileSync, mkdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
const output=resolve(process.argv[2]??'')
if(!process.argv[2])throw new Error('choose output directory')
mkdirSync(output,{recursive:true})
const prepare=process.argv.includes('--prepare')
const names=['a1','a2','b1','b2']
const argument=(flag:string,fallback:string)=>{const i=process.argv.indexOf(flag);return i<0?fallback:process.argv[i+1]??fallback}
const sourcePrefix=argument('--source-prefix','.tmp/jev-placement-live-20260927-')
const reviewRoot=argument('--review-root','.tmp/jev-placement-review')
const boundary=process.argv.includes('--boundary')
const read=(p:string)=>JSON.parse(readFileSync(p,'utf8'))
const lines=(p:string):Record<string,any>[]=>readFileSync(p,'utf8').trim().split('\n').filter(Boolean).map(s=>JSON.parse(s))
const save=(file:string,v:unknown)=>writeFileSync(resolve(output,file),JSON.stringify(v,null,2)+'\n',{flag:'wx'})
const runs=names.map(name=>{
  const root=resolve(sourcePrefix+name)
  const db=new DatabaseSync(resolve(root,'world.sqlite'),{readOnly:true})
  const raw=db.prepare('SELECT * FROM events ORDER BY seq').all();db.close()
  const events=raw.map(r=>({seq:Number(r.seq),eventType:String(r.event_type),data:JSON.parse(String(r.data_json))}))
  return {name,root,raw,events,summary:read(resolve(root,'summary.json')),turns:lines(resolve(root,'turns.jsonl')),drafts:lines(resolve(root,'interventions.jsonl'))}
})
if(prepare){
  const cases:Record<string,unknown>[]=[],mapping:Record<string,unknown>[]=[]
  for(const run of runs)for(const e of run.events.filter(e=>e.eventType==='character.speak'&&e.data.characterId!=='character:player')){
    const id=createHash('sha256').update(sourcePrefix+':'+run.name+':'+e.seq).digest('hex').slice(0,12)
    const prefix=run.events.filter(p=>p.seq<=e.seq)
    const holders:Record<string,string|null>={}
    for(const p of prefix){
      const d=p.data
      if(p.eventType==='entity.upsert')holders[d.entityId]=d.holderId??null
      if(p.eventType==='entity.transferred'||p.eventType==='entity.taken')holders[d.entityId]=Object.hasOwn(d,'toHolderId')?d.toHolderId:d.characterId
    }
    cases.push({id,actorId:e.data.characterId,speech:e.data.text??'',narration:e.data.narration??'',holders,
      formal:prefix.filter(p=>['entity.upsert','entity.transferred','entity.taken'].includes(p.eventType)),
      observedPrior:prefix.filter(p=>p.eventType==='character.speak'&&p.seq<e.seq).slice(-4)})
    mapping.push({id,run:run.name,seq:e.seq})
  }
  cases.sort((a,b)=>String(a.id).localeCompare(String(b.id)))
  writeFileSync(resolve(output,'cases.jsonl'),cases.map(c=>JSON.stringify(c)).join('\n')+'\n',{flag:'wx'})
  save('mapping.json',mapping)
  console.log(JSON.stringify({cases:cases.length,output}));process.exit(0)
}
if(existsSync(resolve(output,'verification.json')))throw new Error('choose new artifact directory')
const mapping=read(resolve(reviewRoot,'mapping.json')) as {id:string;run:string;seq:number}[]
const review=read(resolve(reviewRoot,'judgments.json')) as {reviewer:string;scope:string;judgments:{id:string;personConflict:boolean;groundConflict:boolean}[]}
if(review.judgments.length!==mapping.length||new Set(review.judgments.map(j=>j.id)).size!==mapping.length||mapping.some(m=>!review.judgments.some(j=>j.id===m.id)))throw new Error('incomplete review')
let sameInputs:string|undefined
const verification=[]
for(const run of runs){
  const inputs=JSON.stringify(run.turns.map(t=>t.submitted))
  if(sameInputs!==undefined&&sameInputs!==inputs)throw new Error('inputs differ')
  sameInputs=inputs
  const ids=new Set(mapping.filter(m=>m.run===run.name).map(m=>m.id))
  const judgments=review.judgments.filter(j=>ids.has(j.id))
  const personConflicts=judgments.filter(j=>j.personConflict).length,groundConflicts=judgments.filter(j=>j.groundConflict).length
  let unpublishedFinals=0
  for(const r of run.drafts){
    const next=run.events.find(e=>e.seq>r.baseHeadSeq&&e.eventType==='character.speak')
    if(r.final.decision==='publish'&&!(next&&next.data.characterId===r.actorId&&(next.data.text??'')===(r.final.speech??'')&&(next.data.narration??'')===(r.final.narration??'')))unpublishedFinals++
  }
  if(unpublishedFinals)throw new Error('final expression verification failed')
  const {findings:_findings,placementFindings:_placement,...compact}=run.summary
  save(run.name+'-summary.json',{...compact,npcPublications:ids.size,personConflicts,groundConflicts,unpublishedFinals,
    sourceEventsDigest:createHash('sha256').update(JSON.stringify(run.raw)).digest('hex')})
  for(const file of ['jev-shadow.jsonl','interventions.jsonl','turns.jsonl','protocol.json'])copyFileSync(resolve(run.root,file),resolve(output,run.name+'-'+file))
  save(run.name+'-formal-items.json',run.events.filter(e=>['entity.upsert','entity.transferred','entity.taken'].includes(e.eventType)))
  verification.push({name:run.name,mode:run.summary.mode,rounds:run.summary.rounds,npcPublications:ids.size,personConflicts,groundConflicts,
    repairs:run.summary.repairCalls,modelCalls:run.summary.providerCalls,latencyMs:run.summary.latencyMs,jevCostUsd:run.summary.jevCostUsd,
    preAuditCostUsd:run.summary.preAuditCostUsd,errors:run.summary.failedRounds,auditComplete:run.summary.auditComplete,worldUnchanged:run.summary.unchangedDuringAuditDrain,
    preAuditFailures:run.summary.preAuditFailures,unpublishedFinals})
}
for(const file of ['cases.jsonl','mapping.json','judgments.json'])copyFileSync(resolve(reviewRoot,file),resolve(output,'review-'+file))
const probes=boundary?[['old','.tmp/jev-boundary-old-20260927'],['new','.tmp/jev-boundary-new-20260927'],['new02','.tmp/jev-boundary-new02-20260927']]:[['old','.tmp/jev-placement-old-20260927'],['new01','.tmp/jev-placement-new-20260927'],['new02','.tmp/jev-placement-new02-20260927']]
for(const [label,root] of probes){
  for(const file of ['fixture.json','results.jsonl','summary.json',...(boundary?['classifier-source.ts']:[])])copyFileSync(resolve(root!,file),resolve(output,'probe-'+label+'-'+file))
}
save('verification.json',{runs:verification,inputsIdentical:true,reviewer:review.reviewer,reviewScope:review.scope,automaticMemoryCorrection:false,
  groundPastSourceLinking:false,broadEffectivenessAccepted:false})
console.log(JSON.stringify({output,runs:verification.map(({latencyMs:_latency,...r})=>r)}))
