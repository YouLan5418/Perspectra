import { expect, it } from 'vitest'
import { auditBeforePublication, type InterventionRecord } from '../experiments/jev-publication-intervention.ts'
import type { ClaimAnswer, ClaimQuestion, ClaimKind } from '../experiments/jev-shadow-claims-client.ts'
import type { StoredWorldEvent } from '@harness-world/contracts'
import type { PrototypeTurnRequest } from '../../packages/application/src/prototype-character-turn.ts'

const request: PrototypeTurnRequest={continuation:false,context:{character:{characterId:'friend',privateAnchor:'PRIVATE'},
  cognition:{secret:'PRIVATE'},scene:{people:[{characterId:'friend',name:'留守者'},{characterId:'player',name:'玩家'}]},
  items:{current:[{entityId:'key',holderId:null,locationId:'room'}]}}}
const draft={decision:'publish',speech:'看看吧。',narration:'留守者接过钥匙，翻看后还给玩家。',addresseeIds:['player']}
const answer=(kind:ClaimKind):ClaimAnswer=>({placement:{kind:'NONE',probabilities:{NONE:1},confidence:1},model:'fixture',inputTokens:1,outputTokens:1,costUsd:0,
  claims:[{characterId:'friend',kind,referenceSeq:null,probabilities:{[kind]:1},referenceProbabilities:{NONE:1},confidence:1}]})
const history=[{seq:1,eventType:'entity.upsert',eventVersion:1,data:{entityId:'key',kind:'key',locationId:'room'},transactionId:'genesis'}] as unknown as StoredWorldEvent[]
async function run(options: {kind?:ClaimKind;mode?:'baseline'|'correct';corrected?:unknown;fail?:boolean;visible?:boolean}={}) {
  const records:InterventionRecord[]=[],questions:ClaimQuestion[]=[],revisions:PrototypeTurnRequest[]=[]
  const before=JSON.stringify(history)
  const result=await auditBeforePublication({request:options.visible===false?{...request,context:{...request.context,items:{current:[]}}}:request,
    raw:draft,history,signal:new AbortController().signal,options:{mode:options.mode??'correct',items:[{entityId:'key',name:'钥匙'}],
      classify:async q=>{questions.push(q);if(options.fail)throw new Error('failure');return answer(options.kind??'OBJECTIVE_DURING')},write:r=>records.push(r)},
    decide:async r=>{revisions.push(r);return options.corrected??{...draft,narration:'留守者凑近看了看玩家手中的钥匙。'}}})
  expect(JSON.stringify(history)).toBe(before)
  expect(JSON.stringify(questions)).not.toContain('PRIVATE')
  return {result,records,questions,revisions}
}
it('repairs one unsupported objective incident once, preserves audience and exposes only the original actor context',async()=>{
  const r=await run();expect(r.revisions).toHaveLength(1);expect(r.records[0]?.outcome).toBe('repaired_once')
  expect(r.revisions[0]?.canPerform).toBe(false);expect(r.result).toMatchObject({narration:'留守者凑近看了看玩家手中的钥匙。',addresseeIds:['player']})
})
it('baseline does not call the auditor or repair provider',async()=>{const r=await run({mode:'baseline'});expect(r.result).toEqual(draft);expect(r.questions).toHaveLength(0);expect(r.revisions).toHaveLength(0)})
it('speech and past-only claims do not trigger repair',async()=>{for(const kind of ['SPEECH_NOW','SPEECH_PAST','OBJECTIVE_PAST','UNCERTAIN'] as const){const r=await run({kind});expect(r.revisions).toHaveLength(0);expect(r.result).toEqual(draft)}})
it('unseen inventory facts cannot trigger corrective disclosure',async()=>{const r=await run({visible:false});expect(r.revisions).toHaveLength(0)})
it('audit failure returns original without a new action',async()=>{const r=await run({fail:true});expect(r.result).toEqual(draft);expect(r.records[0]?.outcome).toBe('audit_or_repair_failed_original_used')})
it('invalid repair or changed audience falls back without retry',async()=>{
  for(const corrected of [{decision:'perform',actionType:'interact',parameters:{}},{...draft,addresseeIds:[]}]){
    const r=await run({corrected});expect(r.result).toEqual(draft);expect(r.revisions).toHaveLength(1);expect(r.records[0]?.repaired).toBe(false)
  }
})

it('Jev sees only the individually observed expression, even when another private expression shares the same atomic round',async()=>{
  const publicSpeech={characterId:'player',text:'请看看钥匙。',narration:'',scope:'scene_public'}
  const privateSpeech={characterId:'player',text:'SECRET_SAME_TX',narration:'',scope:'direct',addresseeIds:['other']}
  const events=[...history,{seq:2,transactionId:'mixed',eventType:'character.speak',data:publicSpeech},
    {seq:3,transactionId:'mixed',eventType:'character.speak',data:privateSpeech},
    {seq:4,transactionId:'mixed',eventType:'observation.upsert',data:{value:{observerId:'friend',content:{speech:publicSpeech}}}}] as unknown as StoredWorldEvent[]
  let question:ClaimQuestion|undefined
  await auditBeforePublication({request,raw:draft,history:events,signal:new AbortController().signal,
    options:{mode:'correct',items:[{entityId:'key',name:'钥匙'}],write:()=>{},classify:async q=>{question=q;return answer('NONE')}},decide:async()=>{throw new Error('not called')}})
  expect(question?.earlierPublications).toHaveLength(1)
  expect(JSON.stringify(question)).not.toContain('SECRET_SAME_TX')
})

it('a ground-only conflict triggers one expression repair without granting a drop operation',async()=>{
  const events=[{seq:1,eventType:'character.created',data:{characterId:'friend',name:'留守者',locationId:'room'},eventVersion:1,transactionId:'g'},
    {...history[0],seq:2},{seq:3,eventType:'entity.transferred',eventVersion:1,transactionId:'t',data:{entityId:'key',fromHolderId:null,fromLocationId:'room',toHolderId:'friend',toLocationId:null,characterId:'friend',interactionId:'take'}}] as unknown as StoredWorldEvent[]
  const records:InterventionRecord[]=[],revisions:PrototypeTurnRequest[]=[]
  const result=await auditBeforePublication({request,raw:{...draft,narration:'留守者把钥匙放回桌上，手收了回来。'},history:events,
    signal:new AbortController().signal,options:{mode:'correct',items:[{entityId:'key',name:'钥匙'}],write:r=>records.push(r),classify:async()=>({...answer('NONE'),placement:{kind:'OBJECTIVE_RELEASE',probabilities:{OBJECTIVE_RELEASE:1},confidence:1}})},
    decide:async r=>{revisions.push(r);return {...draft,narration:'留守者仍握着钥匙。'}}})
  expect(result).toMatchObject({narration:'留守者仍握着钥匙。'});expect(revisions).toHaveLength(1)
  expect(records[0]?.checks[0]?.conflicts).toEqual([]);expect(records[0]?.checks[0]?.placement.status).toBe('CONFLICT')
})
