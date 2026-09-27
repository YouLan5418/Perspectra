import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { currentEntityState } from '@harness-world/kernel'
import { FrozenWorldPlaytestRuntime } from './playtest-frozen-runtime.ts'
import { type ShadowRecord } from './jev-shadow.ts'
import { createClaimClassifier } from './jev-shadow-claims-client.ts'

const mode = process.argv.includes('--correct') ? 'correct' : 'baseline'
const explicit = true, probe = true
const placementScript=process.argv.includes('--placement-script')
const directory = resolve(process.argv[2] ?? '')
if (!process.argv[2] || process.argv[2]!.startsWith('--') || existsSync(resolve(directory,'jev-shadow.jsonl'))) throw new Error('choose a new output directory')
mkdirSync(directory,{recursive:true})
const classify = createClaimClassifier(process.env.OPENROUTER_JEV_KEY ?? '')
const records: ShadowRecord[] = []
const interventions: import('./jev-publication-intervention.ts').InterventionRecord[] = []
const write = async (record: ShadowRecord) => { records.push(record);appendFileSync(resolve(directory,'jev-shadow.jsonl'),JSON.stringify(record)+'\n') }
const items = [{entityId:'entity:pocket-watch',name:'铜怀表',aliases:['怀表']},{entityId:'entity:diary',name:'布面日记'}]
function rows(path: string) {
  const db=new DatabaseSync(path,{readOnly:true})
  try { return db.prepare('SELECT * FROM events ORDER BY seq').all() } finally {db.close()}
}
const digest = (input: unknown) => createHash('sha256').update(JSON.stringify(input)).digest('hex')
let evidence: Record<string,unknown>
{
  const key=process.env.DEEPSEEK_API_KEY
  if(!key)throw new Error('DEEPSEEK_API_KEY missing')
  const runtime=await FrozenWorldPlaytestRuntime.create({dataDirectory:directory,packPath:resolve('experiments/jev-narrative-auditor/holdout-2026-09-27/live-pack'),
    provider:'deepseek',model:'deepseek-flash',apiKey:key,shadowAudit:{items,classify,write},publicationAudit:{mode,items,classify,write:r=>{interventions.push(r);appendFileSync(resolve(directory,'interventions.jsonl'),JSON.stringify(r)+'\n')}}})
  const prompts=[
    "雨还没停。你们看看铜怀表和布面日记，先聊聊哪件更能找到失主，不急着动它们。",
    "陆舟，你愿意拿起铜怀表看看背面的字吗？看完暂时替大家拿着。",
    "程雨，请凑近看陆舟手上的铜怀表，只辨认刻字，不用接过来。",
    "陆舟，请把铜怀表交给程雨。程雨，你看清以后再说说想法。",
    "陆舟，回忆你第一次拿怀表时看到的字；这次不用重新拿。程雨也说说你现在的发现。",
    "程雨，请把铜怀表放回台面。陆舟看看它旁边还有没有可辨认的线索。",
    "陆舟，请拿起布面日记，看看封面，暂时不要交给别人。",
    "程雨，摸一下陆舟仍拿着的日记封皮就好，别拿走。你觉得磨损像常用的吗？",
    "陆舟，把布面日记放回台面吧。程雨只看看空出来的位置，先不要拿。",
    "程雨，现在请再拿起铜怀表看看另一面。陆舟说说，这一次和你最初查看有什么不同。",
    "程雨，把铜怀表交给陆舟。陆舟收到后再把它放回台面，让大家都能看见。",
    "你们分别回顾刚才两次看怀表、查看日记的经过，说清谁实际拿过、谁只是凑近看，现在各在谁手里或哪里。"
]
  if(placementScript){
    prompts[5]='程雨，请拿起桌上的布面日记，看看盖子有没有损坏。'
    prompts[6]='程雨，把布面日记放回桌上，给看怀表留点位置。'
    prompts[7]='如果杯子已经在桌上，就沿桌面往旁边挪一点，不用端起来。'
    prompts[8]='布面日记现在在哪里？刚才谁拿起来过，谁放下的？'
    prompts[14]='程雨，请把铜怀表放回桌上，放下以后再说说你看到了什么。'
    prompts[15]='程雨，回想刚才拿着怀表、放下的经过。这次不用再拿。'
    prompts[16]='程雨，布面日记也请放回桌上。陆舟看看，不用拿。'
    prompts[17]='陆舟，看看怀表和杯子，刚才谁放下了什么？如果没放下，也可以直接说。'
    prompts[18]='你们分别说说，现在手里拿着什么，桌上放着什么？'
    prompts[19]='程雨，说说你记得的拿起和放下的经过。'
  }
  writeFileSync(resolve(directory,'protocol.json'),JSON.stringify({mode,prompts,explicit,probe,placementScript,repairLimit:1,holdoutAcceptance:true,activationBudgetUnchanged:true},null,2)+'\n',{flag:'wx'})
  const turns: unknown[]=[]
  try {
    const startSeq=Number((await runtime.state()).debug.headSeq)
    for(const [index,input] of prompts.entries()) {
      const effectiveInput = probe && !placementScript && index === 17 ? '程雨，你接过去看一眼怀表上的划痕，再马上还给我，不用一直拿着。' : input
      const submitted = explicit ? index === 13
        ? '/act interact ' + JSON.stringify({targetRef:{kind:'entity',id:'entity:pocket-watch'},bindingId:'binding:key-give',definitionRef:{id:'base:give',version:1},arguments:{recipientId:'character:friend'}})
        : '/act speak ' + JSON.stringify({text:effectiveInput}) : effectiveInput
      const start=performance.now(),state=await runtime.submit(submitted)
      const turn={round:index+1,input:effectiveInput,submitted,elapsedMs:Math.round(performance.now()-start),state:{error:state.error,notice:state.notice,transcript:state.transcript,debug:{headSeq:state.debug.headSeq,providerCalls:state.debug.providerCalls,activationCycle:state.debug.activationCycle}}}
      turns.push(turn);appendFileSync(resolve(directory,'turns.jsonl'),JSON.stringify(turn)+'\n')
      console.log(JSON.stringify({round:index+1,error:state.error,headSeq:state.debug.headSeq,providerCalls:state.debug.providerCalls,shadow:state.debug.shadowAudit}))
    }
    const state=await runtime.state(),before=rows(resolve(directory,'world.sqlite'))
    await runtime.close()
    const after=rows(resolve(directory,'world.sqlite'))
    const expectedRecords=after.filter(r=>Number(r.seq)>startSeq&&r.event_type==='character.speak'&&(String(JSON.parse(String(r.data_json)).text??'').trim()||String(JSON.parse(String(r.data_json)).narration??'').trim())).length*items.length
    const formal=after.map(r=>({eventType:String(r.event_type),eventVersion:Number(r.event_version),data:JSON.parse(String(r.data_json))}))
    evidence={kind:'live',mode,repairCalls:interventions.filter(r=>r.repairAttempted).length,preAuditFailures:interventions.filter(r=>r.outcome==='audit_or_repair_failed_original_used').length,preAuditCostUsd:interventions.flatMap(r=>r.checks).reduce((s,c)=>s+(c.answer.costUsd??0),0),publicationsAudited:interventions.length,latencyMs:turns.map(t=>(t as {elapsedMs:number}).elapsedMs),activationTerminals:turns.map(t=>((t as {state:{debug:{activationCycle:{terminalReason:string}}}}).state.debug.activationCycle?.terminalReason)),explicitDialogue:explicit,temporaryReceiptProbe:probe,model:state.debug.model,rounds:turns.length,initialSeq:startSeq,headSeq:state.debug.headSeq,
      providerCalls:state.debug.providerCalls,failedRounds:turns.filter(t=>(t as {state:{error:boolean}}).state.error).length,
      statsBeforeDrain:state.debug.shadowAudit,expectedRecords,auditComplete:records.length===expectedRecords,unchangedDuringAuditDrain:digest(before)===digest(after),keyState:currentEntityState(formal,'entity:pocket-watch')}
  } finally {await runtime.close()}
}
const summary={...evidence,records:records.length,statuses:Object.fromEntries([...new Set(records.map(r=>r.status))].map(s=>[s,records.filter(r=>r.status===s).length])),
  jevCostUsd:records.reduce((s,r)=>s+(r.answer?.costUsd??0),0),jevModels:[...new Set(records.map(r=>r.answer?.model).filter(Boolean))],
  placementFindings:records.filter(r=>r.placement?.status==='CONFLICT').map(r=>({publicationSeq:r.publication?.seq,item:r.item?.entityId,placement:r.placement})),
  findings:records.flatMap(r=>r.claims.filter(c=>['CONFLICT','CHAIN_RECALL','SPEECH_UNBACKED','HISTORY_UNRESOLVED'].includes(c.status))
    .map(c=>({publicationSeq:r.publication!.seq,item:r.item!.entityId,actorId:r.publication!.actorId,claim:c}))),directory}
writeFileSync(resolve(directory,'summary.json'),JSON.stringify(summary,null,2)+'\n')
console.log(JSON.stringify({kind:evidence.kind,records:summary.records,statuses:summary.statuses,costUsd:summary.jevCostUsd,directory}))
