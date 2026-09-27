import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { brandId, type StoredWorldEvent, type WorldAddress, type WorldJsonObject } from '@harness-world/contracts'
import { currentEntityState } from '@harness-world/kernel'
import { createClaimClassifier } from './jev-shadow-claims-client.ts'
import { JevShadow, type AuditCharacter, type AuditItem, type ShadowRecord } from './jev-shadow.ts'

interface Expected { seq:number; conflict:boolean; status?:string; references?:number[]; root?:number|null }
interface Fixture { id:string; group:'positive'|'negative'|'temporal'; items:AuditItem[]; characters:AuditCharacter[]; events:StoredWorldEvent[]; initialSeq:number; expected:Expected[] }
const address:WorldAddress={tenantId:brandId('holdout','TenantId'),worldId:brandId('acceptance07','WorldId'),branchId:brandId('fixture','BranchId')}
const sources=['tests/experiments/jev-shadow-claims-client.ts','tests/experiments/jev-shadow.ts','tests/experiments/jev-shadow-window.ts','tests/experiments/jev-publication-intervention.ts']
const sha=(s:string)=>createHash('sha256').update(s).digest('hex')
const directory=resolve(process.argv[2]??'')
if(!process.argv[2])throw new Error('provide fresh evidence directory')

function buildFixtures():Fixture[]{
  const fixtures:Fixture[]=[]
  for(const setting of [
    {id:'workshop',a:'叶岚',b:'周衡',c:'来访者',item:'铜哨',other:'检修册',room:'维修间',clue1:'哨口的焊缝',clue2:'底部的编号'},
    {id:'archive',a:'顾宁',b:'沈砚',c:'访客',item:'银质书签',other:'蓝封账簿',room:'档案室',clue1:'顶端的花纹',clue2:'背面的刻字'},
  ]){
    const {a,b,c,item,other,room,clue1,clue2}=setting
    const characters=[{characterId:'character:a',name:a},{characterId:'character:b',name:b},{characterId:'character:c',name:c}]
    const items=[{entityId:`entity:${setting.id}-target`,name:item},{entityId:`entity:${setting.id}-other`,name:other}]
    const target=items[0]!.entityId
    function world(holder:string|null){
      const events:StoredWorldEvent[]=[]
      const add=(eventType:string,data:WorldJsonObject,tx=events.length+1)=>{
        const seq=events.length+1
        events.push({address,seq,tick:tx,eventType,eventVersion:1,data,transactionId:brandId(`tx:${tx}`,'TransactionId'),eventOrdinal:events.filter(e=>e.transactionId===`tx:${tx}`).length,previousHash:'genesis',eventHash:`sha256:${'0'.repeat(64)}`})
        return seq
      }
      for(const person of characters)add('character.created',{...person,locationId:room})
      for(const object of items)add('entity.upsert',{entityId:object.entityId,kind:'prop',locationId:room})
      const transfer=(from:string|null,to:string|null,tx=events.length+1)=>add('entity.transferred',{entityId:target,fromHolderId:from,fromLocationId:from===null?room:null,toHolderId:to,toLocationId:to===null?room:null,characterId:from??to!,interactionId:'give'},tx)
      if(holder)transfer(null,holder)
      const player=()=>add('action.resolved',{sourceRole:'player',actorId:'character:c',participantId:'player'})
      const speak=(narration:string,speech='',actorId='character:a',tx=events.length+1)=>add('character.speak',{characterId:actorId,text:speech,narration},tx)
      return {events,add,transfer,player,speak}
    }
    const positives=setting.id==='workshop'?[
      `${a}把${item}从柜台上捡起，塞进自己的衣袋。`,
      `${a}从${b}手中接走${item}，攥在掌心没有还回去。`,
      `${a}摊开掌心，${item}正躺在她手里。`,
      `${a}将${item}搁在柜台，松开五指，双手插回衣袋。`,
      `${a}没有触碰柜台上的${item}，只向门口偏了偏头。`,
      `柜台上的${item}反着灯光；${a}把视线移向${b}。`,
      `${a}接过${b}的${item}，看了眼${clue2}，随即交还${b}。`,
      `${a}拿着${other}；旁边桌面的${item}挡住了那道光。`,
    ]:[
      `${a}伸手取走案头的${item}，把它收进袖袋。`,
      `${b}把${item}递来，${a}接稳后一直拿着。`,
      `${a}手中的${item}随着她转身轻轻晃动。`,
      `${a}把${item}从手里放到桌面，撒开手，十指交叠在胸前。`,
      `${a}避开桌上的${item}，并未伸手碰它。`,
      `灯光照亮案头的${item}，${a}却在看墙上的挂画。`,
      `${a}从${b}那里取来${item}，翻看${clue1}，然后还到了${b}手中。`,
      `${a}怀里是${other}，桌面上的${item}在它投下的阴影里。`,
    ]
    const negatives=setting.id==='workshop'?[
      `${a}用指尖把柜台上的${item}平推了一厘米，全程没有拿离台面。`,
      `${a}摸了摸${b}握着的${item}，随即缩回手。`,
      `${a}仍攥着${item}，让它的底端碰了碰桌沿，手指没有松开。`,
      `${a}看向柜台上原先搁${item}的那块空白，那里现在什么也没有。`,
      `${a}始终握着${item}，只低头端详表面的划痕。`,
      `${a}从${b}手里接过${item}，留在掌中。`,
      `${a}眼睛望着窗外。`,
      `${a}还握着${item}，她没碰桌上的${other}。`,
    ]:[
      `${a}沿着桌面推了推${item}，它一直贴着桌面滑动。`,
      `${item}一直由${b}捏着，${a}只用指腹轻触边缘便收手。`,
      `${a}捏紧${item}，把末端抵在桌上，另一端仍牢牢夹在指间。`,
      `${a}望着${item}之前留下的灰尘轮廓，轮廓中已没有东西。`,
      `${a}将一直拿在手里的${item}转了半圈，没有交给任何人。`,
      `${b}将${item}交给${a}，${a}拿稳了。`,
      `${a}把目光投向窗外。`,
      `桌上摊着${other}，${item}却依然捏在${a}指间。`,
    ]
    for(const [group,texts]of [['positive',positives],['negative',negatives]]as const){
      for(const [index,narration]of texts.entries()){
        const positive=group==='positive'
        const holder=positive?(index===0?null:index===3?'character:a':'character:b'):(index===0?null:[2,4,7].includes(index)?'character:a':'character:b')
        const w=world(holder),initialSeq=w.events.length
        w.player();const tx=w.events.length+1
        if(!positive&&index===5)w.transfer('character:b','character:a',tx)
        const speech=!positive&&index===6?`我昨天把${item}放在桌上了，那是昨天的事。`:''
        const seq=w.speak(narration,speech,'character:a',tx)
        fixtures.push({id:`${setting.id}-${group}-${index+1}`,group,items,characters,events:w.events,initialSeq,expected:[{seq,conflict:positive}]})
      }
    }
    for(const oldReal of [true,false])for(const recallOld of [true,false]){
      const w=world('character:b'),initialSeq=w.events.length
      const occurrence=(real:boolean,when:string,clue:string)=>{
        w.player();const tx=w.events.length+1
        if(real){w.transfer('character:b','character:a',tx);w.transfer('character:a','character:b',tx)}
        return w.speak(`${when}，${a}从${b}手里接过${item}，托在掌中仔细看了${clue}，看完立即交还${b}。`,'','character:a',tx)
      }
      const old=occurrence(oldReal,`清晨第一次在${room}检查时`,clue1)
      const recent=occurrence(!oldReal,`午后钟声响起后第二次检查时`,clue2)
      const selected=recallOld?old:recent,real=recallOld?oldReal:!oldReal
      const when=recallOld?'清晨第一次检查':'午后钟声后第二次检查',clue=recallOld?clue1:clue2
      w.player()
      const recall=w.speak(`${b}把椅子转向${c}。`,`${a}在${when}接过去看的，是${clue}；看完她就还给我了。我只说那一次。`,'character:b')
      w.player()
      const echo=w.speak(`${c}点了点头。`,`你刚才说的${when}我记住了：${a}拿在手里看${clue}，之后还给了${b}。`,'character:c')
      fixtures.push({id:`${setting.id}-temporal-${oldReal?'real-first':'false-first'}-${recallOld?'old':'recent'}`,group:'temporal',items,characters,events:w.events,initialSeq,expected:[
        {seq:old,conflict:!oldReal,status:oldReal?'SUPPORTED':'CONFLICT',root:oldReal?null:old},
        {seq:recent,conflict:oldReal,status:oldReal?'CONFLICT':'SUPPORTED',root:oldReal?recent:null},
        {seq:recall,conflict:false,status:real?'HISTORICAL_SUPPORTED':'CHAIN_RECALL',references:[selected],root:real?null:selected},
        {seq:echo,conflict:false,status:real?'HISTORICAL_SUPPORTED':'CHAIN_RECALL',references:[selected,recall],root:real?null:selected},
      ]})
    }
  }
  return fixtures
}

if(process.argv.includes('--prepare')){
  if(existsSync(directory))throw new Error('choose new directory')
  mkdirSync(directory,{recursive:true})
  const fixtures=buildFixtures()
  for(const f of fixtures){
    if(!currentEntityState(f.events,f.items[0]!.entityId))throw new Error('invalid fixture state')
    if(f.events.some((e,i)=>e.seq!==i+1))throw new Error('noncontiguous fixture')
  }
  const serialized=JSON.stringify(fixtures,null,2)+'\n'
  writeFileSync(resolve(directory,'fixtures.json'),serialized,{flag:'wx'})
  const sourceHashes=Object.fromEntries(sources.map(path=>[path,sha(readFileSync(path,'utf8'))]))
  writeFileSync(resolve(directory,'protocol.json'),JSON.stringify({baseline:'176afd1fc911458bd48908bdc226ce39f3adb425',createdAt:new Date().toISOString(),sourceHashes,fixtureHash:sha(serialized),fixtures:fixtures.length,requests:fixtures.reduce((n,f)=>n+f.expected.length,0),attemptsPerPublication:1,retry:false,synthetic:true,reviewer:'Codex author; no independent human review',gate:{positiveMinimum:15,positiveTotal:16,negativeFalsePositiveMaximum:0,negativeTotal:16,temporalCompleteMinimum:8,temporalTotal:8,apiFailureMaximum:0},stop:'Any failed gate stops escalation to live play; no prompt tuning in this experiment.'},null,2)+'\n',{flag:'wx'})
  for(const path of sources)writeFileSync(resolve(directory,path.split('/').at(-1)!),readFileSync(path),{flag:'wx'})
  console.log(JSON.stringify({prepared:directory,fixtures:fixtures.length,requests:64}))
}else{
  if(existsSync(resolve(directory,'results.jsonl')))throw new Error('run already attempted; no automatic retry')
  const protocol=JSON.parse(readFileSync(resolve(directory,'protocol.json'),'utf8'))
  const fixtureText=readFileSync(resolve(directory,'fixtures.json'),'utf8')
  if(sha(fixtureText)!==protocol.fixtureHash||sources.some(path=>sha(readFileSync(path,'utf8'))!==protocol.sourceHashes[path]))throw new Error('frozen inputs changed')
  const fixtures:Fixture[]=JSON.parse(fixtureText),classify=createClaimClassifier(process.env.OPENROUTER_JEV_KEY??'')
  const results:Array<{id:string;group:string;passed:boolean;flagged:number;failures:number;checks:unknown[];records:ShadowRecord[]}>=[]
  for(const f of fixtures){
    const records:ShadowRecord[]=[]
    const shadow=new JevShadow({address,characters:f.characters,items:[f.items[0]!],initialSeq:f.initialSeq,readEvents:seq=>f.events.slice(0,seq),classify:async q=>{
      const question={...q,items:f.items}
      appendFileSync(resolve(directory,'requests.jsonl'),JSON.stringify({id:f.id,question})+'\n')
      return classify(question)
    },write:async record=>{records.push(record);appendFileSync(resolve(directory,'shadow.jsonl'),JSON.stringify({id:f.id,...record})+'\n')}})
    shadow.observe(f.events.length);await shadow.close()
    const checks=f.expected.map(expected=>{
      const record=records.find(r=>r.publication?.seq===expected.seq),claim=record?.claims.find(c=>c.characterId==='character:a')
      const failed=!record||['CALL_FAILED','AUDIT_FAILED','QUEUE_SKIPPED'].includes(record.status)
      const conflict=record?.status==='CONFLICT'
      const match=!failed&&conflict===expected.conflict&&(expected.status===undefined||claim?.status===expected.status)&&(expected.references===undefined||expected.references.includes(claim?.referenceSeq??-1))&&(expected.root===undefined||claim?.rootPublicationSeq===expected.root)
      return {expected,actual:{status:record?.status,personStatus:claim?.status,reference:claim?.referenceSeq,root:claim?.rootPublicationSeq},failed,match}
    })
    const row={id:f.id,group:f.group,passed:checks.every(c=>c.match),flagged:records.filter(r=>r.status==='CONFLICT').length,failures:checks.filter(c=>c.failed).length,checks,records}
    results.push(row);appendFileSync(resolve(directory,'results.jsonl'),JSON.stringify(row)+'\n');console.log(JSON.stringify({id:f.id,passed:row.passed,failures:row.failures}))
  }
  const positive=results.filter(r=>r.group==='positive'),negative=results.filter(r=>r.group==='negative'),temporal=results.filter(r=>r.group==='temporal')
  const records=results.flatMap(r=>r.records),latencies=records.map(r=>r.latencyMs).sort((a,b)=>a-b)
  const metrics={positiveDetected:positive.filter(r=>r.passed).length,negativeFalseFlags:negative.filter(r=>r.flagged>0).length,temporalComplete:temporal.filter(r=>r.passed).length,failures:results.reduce((n,r)=>n+r.failures,0),records:records.length,costUsd:records.reduce((n,r)=>n+(r.answer?.costUsd??0),0),models:[...new Set(records.flatMap(r=>r.answer?[r.answer.model]:[]))],medianAuditMs:latencies[Math.floor(latencies.length/2)],p90AuditMs:latencies[Math.ceil(latencies.length*.9)-1]}
  const gate=protocol.gate
  const pass=metrics.positiveDetected>=gate.positiveMinimum&&metrics.negativeFalseFlags<=gate.negativeFalsePositiveMaximum&&metrics.temporalComplete>=gate.temporalCompleteMinimum&&metrics.failures<=gate.apiFailureMaximum&&metrics.records===protocol.requests
  writeFileSync(resolve(directory,'summary.json'),JSON.stringify({metrics,gate,pass,finishedAt:new Date().toISOString(),failedFixtures:results.filter(r=>!r.passed).map(r=>r.id)},null,2)+'\n',{flag:'wx'})
  console.log(JSON.stringify({metrics,pass}))
}
