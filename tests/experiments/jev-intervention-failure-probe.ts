import { readFileSync, mkdirSync, writeFileSync, existsSync, appendFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createClaimClassifier, type ClaimQuestion } from './jev-shadow-claims-client.ts'
const directory=resolve(process.argv[2]??'')
if(!process.argv[2]||existsSync(resolve(directory,'fixture.json')))throw new Error('choose new directory')
mkdirSync(directory,{recursive:true})
const source='.tmp/jev-window-live-20260926-04/world.sqlite'
const db=new DatabaseSync(source,{readOnly:true})
const rows=db.prepare('SELECT seq,event_type,data_json FROM events ORDER BY seq').all()
db.close()
const publications=rows.filter(r=>r.event_type==='character.speak').map(r=>{const d=JSON.parse(String(r.data_json));return {seq:Number(r.seq),actorId:String(d.characterId),speech:String(d.text??''),narration:String(d.narration??'')}})
const characters=[{characterId:'character:player',name:'玩家'},{characterId:'character:companion',name:'同行者'},{characterId:'character:friend',name:'留守者'}]
const items=[{entityId:'entity:brass-key',name:'黄铜钥匙',aliases:['钥匙']},{entityId:'entity:thermos',name:'保温杯'}]
const negatives=[{seq:56,person:'character:player',item:0,kinds:['NONE']},
  {seq:144,person:'character:companion',item:0,kinds:['SPEECH_PAST']},
  {seq:117,person:'character:companion',item:0,kinds:['NONE','SPEECH_PAST']},
  {seq:133,person:'character:friend',item:1,kinds:['NONE']}]
const real=JSON.parse(readFileSync('experiments/jev-narrative-auditor/historical-replay-2026-09-26/cases.json','utf8')) as Array<{id:string;question:ClaimQuestion}>
const positive=real.find(r=>r.id==='free:139:entity:brass-key')!.question
const fixtures=negatives.map(n=>({...n,question:{items,characters,item:items[n.item]!,publication:publications.find(p=>p.seq===n.seq)!,
  earlierPublications:publications.filter(p=>p.seq<n.seq).slice(-12),round:{roundId:null,fromSeq:n.seq-1,toSeq:n.seq}} as ClaimQuestion}))
fixtures.push({seq:139,person:'character:friend',item:0,kinds:['OBJECTIVE_DURING'],question:{...positive,
  earlierPublications:[],round:{roundId:null,fromSeq:138,toSeq:139}}})
writeFileSync(resolve(directory,'fixture.json'),JSON.stringify({source,fixtures,repeat:3},null,2)+'\n',{flag:'wx'})
const classify=createClaimClassifier(process.env.OPENROUTER_JEV_KEY??'')
const results=[]
for(const f of fixtures)for(let repeat=1;repeat<=3;repeat++){
  try{const answer=await classify(f.question),kind=answer.claims.find(c=>c.characterId===f.person)!.kind
    const row={seq:f.seq,person:f.person,repeat,expected:f.kinds,kind,match:f.kinds.includes(kind),answer}
    results.push(row);appendFileSync(resolve(directory,'results.jsonl'),JSON.stringify(row)+'\n')
  }catch{results.push({seq:f.seq,repeat,match:false,error:'Jev failed',answer:null})}
}
const summary={checks:results.length,matched:results.filter(r=>r.match).length,results}
writeFileSync(resolve(directory,'summary.json'),JSON.stringify(summary,null,2)+'\n')
console.log(JSON.stringify({checks:summary.checks,matched:summary.matched,results:results.map(({answer:_answer,...r})=>r)}))
