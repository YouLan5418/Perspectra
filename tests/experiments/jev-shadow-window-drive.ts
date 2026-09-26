import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { brandId, type StoredWorldEvent, type WorldAddress, type WorldJsonObject } from '@harness-world/contracts'
import { currentEntityState } from '@harness-world/kernel'
import { FrozenWorldPlaytestRuntime } from './playtest-frozen-runtime.ts'
import { JevShadow, type ShadowRecord } from './jev-shadow.ts'
import { createClaimClassifier } from './jev-shadow-claims-client.ts'

const replay = process.argv.includes('--replay')
const explicit = process.argv.includes('--explicit')
const probe = process.argv.includes('--probe')
const sourceIndex = process.argv.indexOf('--source')
const sourcePath = sourceIndex < 0 ? undefined : process.argv[sourceIndex+1]
if (sourceIndex >= 0 && (!sourcePath || sourcePath.startsWith('--'))) throw new Error('--source requires a SQLite path')
const directory = resolve(process.argv[2] ?? '')
if (!process.argv[2] || process.argv[2]!.startsWith('--') || existsSync(resolve(directory,'jev-shadow.jsonl'))) throw new Error('choose a new output directory')
mkdirSync(directory,{recursive:true})
const classify = createClaimClassifier(process.env.OPENROUTER_JEV_KEY ?? '')
const records: ShadowRecord[] = []
const write = async (record: ShadowRecord) => { records.push(record);appendFileSync(resolve(directory,'jev-shadow.jsonl'),JSON.stringify(record)+'\n') }
const items = [{entityId:'entity:brass-key',name:'黄铜钥匙',aliases:['钥匙']},{entityId:'entity:thermos',name:'保温杯'}]
function rows(path: string) {
  const db=new DatabaseSync(path,{readOnly:true})
  try { return db.prepare('SELECT * FROM events ORDER BY seq').all() } finally {db.close()}
}
const digest = (input: unknown) => createHash('sha256').update(JSON.stringify(input)).digest('hex')
let evidence: Record<string,unknown>
if (replay) {
  const source=sourcePath ? resolve(sourcePath) : 'D:/DeepSeek Harness/harness-cordis-world-prototype/.tmp/g3-free-20260923/world.sqlite'
  const raw=rows(source), before=digest(raw), latest = sourcePath ? raw.at(-1)! : raw.find(r=>Number(r.seq)===247)!
  const end=Number(raw.filter(r=>r.transaction_id===latest.transaction_id).at(-1)!.seq)
  const prefix=raw.filter(r=>Number(r.seq)<=end)
  const keys=[...new Set(prefix.map(r=>String(r.address_key)))]
  if(keys.length!==1)throw new Error('choose a branch')
  const parts=keys[0]!.split('\u001f')
  const address:WorldAddress={tenantId:brandId(parts[0]!,'TenantId'),worldId:brandId(parts[1]!,'WorldId'),branchId:brandId(parts[2]!,'BranchId')}
  const events:StoredWorldEvent[]=prefix.map(r=>({address,seq:Number(r.seq),tick:Number(r.tick),eventType:String(r.event_type),eventVersion:Number(r.event_version),
    data:JSON.parse(String(r.data_json)),previousHash:String(r.previous_hash) as StoredWorldEvent['previousHash'],eventHash:String(r.event_hash) as StoredWorldEvent['eventHash'],transactionId:brandId(String(r.transaction_id),'TransactionId'),eventOrdinal:Number(r.event_ordinal)}))
  const initialSeq=prefix.filter(r=>r.transaction_id===prefix[0]!.transaction_id).length
  const characters=events.filter(e=>e.eventType==='character.created').map(e=>{const d=e.data as WorldJsonObject;return {characterId:String(d.characterId),name:String(d.name)}})
  const shadow=new JevShadow({address,characters,items,initialSeq,classify,write,readEvents:seq=>events.slice(0,seq)})
  shadow.observe(end);await shadow.close()
  if(digest(rows(source))!==before)throw new Error('source changed')
  evidence={kind:'continuous-replay',source,sourceDigest:before,initialSeq,headSeq:end,stats:shadow.stats(),sourceUnchanged:true}
} else {
  const key=process.env.DEEPSEEK_API_KEY
  if(!key)throw new Error('DEEPSEEK_API_KEY missing')
  const runtime=await FrozenWorldPlaytestRuntime.create({dataDirectory:directory,packPath:resolve('examples/world-packs/prototype-g1'),
    provider:'deepseek',model:'deepseek-flash',apiKey:key,shadowAudit:{items,classify,write}})
  const prompts=[
    '桌上的黄铜钥匙看起来有什么特别？',
    '同行者，请帮我拿起黄铜钥匙，先保管一下。',
    '同行者，翻过来看看齿纹，你觉得这把钥匙旧吗？',
    '同行者，把黄铜钥匙交给我吧。',
    '同行者，回想你刚才拿着钥匙的时候，你看到了什么？我问的是刚才，不是让你现在拿。',
    '留守者，你愿意凑近看看钥匙上的那道划痕吗？',
    '好，靠近看看。我想听听你的判断。',
    '留守者，摸摸那道划痕和边上的毛刺，感觉是什么样的？',
    '钥匙现在在谁手里？刚才留守者是怎么看的？',
    '你们都说说，刚才有没有人把钥匙递给留守者？',
    '先不忙着动东西。你们为什么对后室好奇？',
    '同行者，请回想最开始你从桌上拿起钥匙的那一次，只说那一次经过。',
    '留守者，你还记得刚才查看钥匙的经过吗？是谁递给谁，又是谁还回去？',
    '我把黄铜钥匙交给留守者，让她先保管。',
    '留守者，现在请你仔细看看钥匙，再把黄铜钥匙交还给我。',
    '留守者，回想你之前真正拿着钥匙的那一次，当时看到了什么？这次不用再拿。',
    '保温杯先留在桌上，你们只看看它，不用拿。',
    '留守者，再靠近看看我这边的钥匙，不用把它拿走。你觉得划痕有没有变化？',
    '同行者，把两次查看钥匙的经过分别说说，别把之前保管的事和这次靠近看混在一起。',
    '留守者，也说说你记得的经过：什么时候实际拿着钥匙，什么时候只是看？',
  ]
  const turns: unknown[]=[]
  try {
    const startSeq=Number((await runtime.state()).debug.headSeq)
    for(const [index,input] of prompts.entries()) {
      const effectiveInput = probe && index === 17 ? '留守者，你接过去看一眼钥匙上的划痕，再马上还给我，不用一直拿着。' : input
      const submitted = explicit ? index === 13
        ? '/act interact ' + JSON.stringify({targetRef:{kind:'entity',id:'entity:brass-key'},bindingId:'binding:key-give',definitionRef:{id:'base:give',version:1},arguments:{recipientId:'character:friend'}})
        : '/act speak ' + JSON.stringify({text:effectiveInput}) : effectiveInput
      const start=performance.now(),state=await runtime.submit(submitted)
      const turn={round:index+1,input:effectiveInput,submitted,elapsedMs:Math.round(performance.now()-start),state}
      turns.push(turn);appendFileSync(resolve(directory,'turns.jsonl'),JSON.stringify(turn)+'\n')
      console.log(JSON.stringify({round:index+1,error:state.error,headSeq:state.debug.headSeq,providerCalls:state.debug.providerCalls,shadow:state.debug.shadowAudit}))
    }
    const state=await runtime.state(),before=rows(resolve(directory,'world.sqlite'))
    await runtime.close()
    const after=rows(resolve(directory,'world.sqlite'))
    const expectedRecords=after.filter(r=>Number(r.seq)>startSeq&&r.event_type==='character.speak'&&(String(JSON.parse(String(r.data_json)).text??'').trim()||String(JSON.parse(String(r.data_json)).narration??'').trim())).length*items.length
    const formal=after.map(r=>({eventType:String(r.event_type),eventVersion:Number(r.event_version),data:JSON.parse(String(r.data_json))}))
    evidence={kind:'live',explicitDialogue:explicit,temporaryReceiptProbe:probe,model:state.debug.model,rounds:turns.length,initialSeq:startSeq,headSeq:state.debug.headSeq,
      providerCalls:state.debug.providerCalls,failedRounds:turns.filter(t=>(t as {state:{error:boolean}}).state.error).length,
      statsBeforeDrain:state.debug.shadowAudit,expectedRecords,auditComplete:records.length===expectedRecords,unchangedDuringAuditDrain:digest(before)===digest(after),keyState:currentEntityState(formal,'entity:brass-key')}
  } finally {await runtime.close()}
}
const summary={...evidence,records:records.length,statuses:Object.fromEntries([...new Set(records.map(r=>r.status))].map(s=>[s,records.filter(r=>r.status===s).length])),
  jevCostUsd:records.reduce((s,r)=>s+(r.answer?.costUsd??0),0),jevModels:[...new Set(records.map(r=>r.answer?.model).filter(Boolean))],
  findings:records.flatMap(r=>r.claims.filter(c=>['CONFLICT','CHAIN_RECALL','SPEECH_UNBACKED','HISTORY_UNRESOLVED'].includes(c.status))
    .map(c=>({publicationSeq:r.publication!.seq,item:r.item!.entityId,actorId:r.publication!.actorId,claim:c}))),directory}
writeFileSync(resolve(directory,'summary.json'),JSON.stringify(summary,null,2)+'\n')
console.log(JSON.stringify({kind:evidence.kind,records:summary.records,statuses:summary.statuses,costUsd:summary.jevCostUsd,directory}))
