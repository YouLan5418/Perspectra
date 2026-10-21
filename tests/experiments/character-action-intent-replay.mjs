// Author fixture replay: compare visible proposals only; never execute them or save hidden reasoning.
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from 'node:fs'
import { resolve, join } from 'node:path'
import Ajv from 'ajv'
import { gatewayTurnCall } from '../../desktop/host/gateway-turn-call.ts'
import { characterActionIntentPrinciples, characterTurnCall } from '../../packages/provider-chat/src/character-turn-call.ts'
import { characterActionExplanations, characterActionExplanationsNote } from '../../packages/provider-chat/src/character-action-explanations.ts'

const base=resolve('output/interaction-continuity')
const source=join(base,'comparison-wzCBNH','perform-availability-review.json')
const selected=JSON.parse(readFileSync(source,'utf8')).targets
const semantic=process.argv.includes('--action-semantics')
const addedPrompt=semantic?characterActionExplanationsNote:characterActionIntentPrinciples
const resume=process.argv.slice(2).find(arg=>arg.startsWith('--resume='))?.slice(9)
const directory=resume?resolve(resume):mkdtempSync(join(base,semantic?'semantic-replay-':'intent-replay-'))
const saved=resume?JSON.parse(readFileSync(join(directory,'record.json'),'utf8')):undefined
if(saved&&saved.addedPrompt!==addedPrompt)throw new Error('Resume prompt mismatch')
const results=saved?.results??[]
const persist=()=>writeFileSync(join(directory,'record.json'),JSON.stringify({
  model:'gemini-3.8-flash',endpoint:'http://127.0.0.1:8045/v1/chat/completions',
  addedPrompt,comparisonMechanism:semantic?'action-semantics':'intent-clarity',maximumOutputTokens:32768,
  source,executedActions:0,validationContract:'standard prototype schema; transmitted local schema unchanged',results,
  ...(saved?{harnessNote:'Resumed after captured local-schema duplicate enum rejected by validator meta-schema; use the standard host decision schema for validation, without changing requests or retrying completed calls.'}:{}),
  limits:'Paired frozen contexts, one response per prompt; no format retries, no world commits, no hidden reasoning. '
    +(semantic?'Previous removes only the semantic note and derived action explanations; both retain the independent-character and intent principles.'
      :'Previous means the independent-character prompt without the new intent paragraph, not necessarily the original historical prompt.')
},null,2)+'\n')
mkdirSync(directory,{recursive:true})
persist()
for(const [index,target] of selected.entries()) {
  const record=JSON.parse(readFileSync(join(base,target.record),'utf8'))
  const captured=record.calls[target.callIndex]
  const call=gatewayTurnCall(captured.input)
  if(!call.messages[0].content.includes(addedPrompt))throw new Error('Missing new prompt')
  if(!captured.schema.properties.decision.enum.includes('perform')||captured.input.canPerform!==true)throw new Error('Replay must offer perform')
  const validate=new Ajv({strict:false,allErrors:true}).compile(characterTurnCall(captured.input).schema)
  for(const mode of index%2===0?['previous','improved']:['improved','previous']) {
    const completed=results.find(row=>row.target.record===target.record&&row.target.callIndex===target.callIndex&&row.mode===mode)
    if(completed) {
      if(completed.proposal!==undefined)completed.valid=validate(completed.proposal)
      persist()
      continue
    }
    const system=mode==='previous'?call.messages[0].content.replace(addedPrompt,''):call.messages[0].content
    const explanations=semantic&&mode==='improved'?characterActionExplanations(captured.input.context):[]
    const input=explanations.length?{...captured.input,context:{...captured.input.context,actionExplanations:explanations}}:captured.input
    const body={model:record.meta.model,messages:[{role:'system',content:system},{role:'user',content:JSON.stringify(input)}],
      stream:false,temperature:captured.generation.temperature,max_tokens:32768,reasoning_effort:record.meta.thinkingLevel,
      tools:[{type:'function',function:{name:'submit_actions',description:call.description,parameters:captured.schema}}],
      tool_choice:{type:'function',function:{name:'submit_actions'}}}
    const started=performance.now()
    const row={target,mode,thinkingLevel:record.meta.thinkingLevel,requestCanPerform:true,wireOffersPerform:true}
    if(semantic)row.actionExplanations=explanations
    results.push(row)
    try {
      const response=await fetch('http://127.0.0.1:8045/v1/chat/completions',{method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify(body),signal:AbortSignal.timeout(60000)})
      row.httpStatus=response.status
      if(!response.ok)throw new Error('HTTP '+response.status)
      const result=await response.json()
      row.usage=result.usage
      const message=result.choices?.[0]?.message
      row.proposal=JSON.parse(message?.tool_calls?.[0]?.function?.arguments??message?.content)
      row.valid=validate(row.proposal)
      if(!row.valid)row.schemaErrors=validate.errors
    } catch(error) {row.failure=error instanceof Error?error.name+': '+error.message:String(error)}
    row.elapsedMs=Math.round(performance.now()-started)
    persist()
    console.log(JSON.stringify({directory,index,mode,thinking:row.thinkingLevel,elapsedMs:row.elapsedMs,valid:row.valid,proposal:row.proposal,failure:row.failure}))
  }
}
console.log(JSON.stringify({directory,calls:results.length,errors:results.filter(row=>row.failure||!row.valid).length}))
if(results.some(row=>row.failure||!row.valid))process.exitCode=1
