import {execFileSync} from 'node:child_process'
import {mkdir,writeFile} from 'node:fs/promises'
import {resolve} from 'node:path'
import assert from 'node:assert/strict'
import type {WorldJsonObject} from '../../packages/sdk/src/contracts/index.ts'
import {admit} from '../../packages/memory-core/src/node/admission.ts'
import {deliver} from '../../packages/memory-core/src/node/delivery.ts'
import {object,rows} from '../../packages/memory-core/src/node/archive.ts'
const python=process.argv[2],assets=process.argv[3]
if(!python||!assets)throw new Error('Usage: delivery-parity.ts PYTHON ASSETS')
const env={PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,TEMP:process.env.TEMP,TMP:process.env.TMP,PYTHONIOENCODING:'utf-8',PYTHONDONTWRITEBYTECODE:'1',HCW_HINDSIGHT_ONNX_DIR:resolve(assets),HCW_HINDSIGHT_CACHE_DIR:resolve('.tmp/node-memory/delivery-cache'),HF_HUB_OFFLINE:'1',TRANSFORMERS_OFFLINE:'1'}
const oracle=(input:WorldJsonObject)=>JSON.parse(execFileSync(resolve(python),['experiments/node-memory/delivery-oracle.py'],{input:JSON.stringify(input),encoding:'utf8',env,timeout:120000,maxBuffer:32*1024*1024,windowsHide:true})) as WorldJsonObject
const fixture=oracle({operation:'fixture'}),data=object(fixture.archive),index=object(fixture.index)
const reports:WorldJsonObject[]=[]
for(const query of ['明天见面喝热茶','activity:first 是怎么结束的','钥匙在哪里','没有任何相关内容','。'])for(const [maxItems,maxChars]of [[6,12000],[1,1100]]){
  const request={context:{character:{characterId:'character:friend',name:'朋友'},scene:{locationId:'location:tea',people:[]},items:{current:[]},stimulus:[],observations:[],selfObservations:[]},recallEvidence:{query}}
  const result=oracle({operation:'recall',archive:data,index,request,tick:20,maxItems:maxItems!,maxChars:maxChars!}),projected=object(result.query)
  const admitted=admit(data,index,object(result.recall),request,projected)
  assert.deepEqual(admitted.candidates,result.candidates,'candidate rows: '+query)
  assert.deepEqual(admitted.trace,result.admission,'admission trace: '+query)
  const delivered=deliver(data,admitted.candidates,request,20,projected,maxItems,maxChars)
  assert.deepEqual(delivered,result.delivery,'delivery: '+query+' budget '+maxChars)
  reports.push({query,maxItems:maxItems!,maxChars:maxChars!,equal:true})
}
for(const bad of [{...data,scope:{...object(data.scope),characterId:'character:other'}},{...data,sources:rows(data.sources).map((s,i)=>i? s : {...s,sourceHash:'tampered'})}])assert.throws(()=>deliver(bad,[],{context:{character:{characterId:'character:friend'}}},20,{originalText:''}))
await mkdir('.tmp/node-memory',{recursive:true});await writeFile('.tmp/node-memory/delivery-parity.json',JSON.stringify(reports,null,2)+'\n')
console.log(JSON.stringify({cases:reports.length,passed:true}))
