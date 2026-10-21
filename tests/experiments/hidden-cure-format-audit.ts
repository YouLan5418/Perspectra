import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import Ajv from 'ajv'
import { prototypeTurnCall } from '@harness-world/provider-chat'
import { gatewayTurnCall } from '../../desktop/host/gateway-turn-call.ts'
import { decideWithFormatRetry } from '../../desktop/host/decision-format.ts'
import type { PrototypeTurnRequest } from '../../packages/application/src/prototype-character-turn.ts'
import type { WorldJsonValue } from '@harness-world/contracts'

// Offline replay of the recorded invalid output: not a new NPC decision or gameplay result.
if (!process.argv[2] || !process.argv[3]) throw new TypeError('用法：hidden-cure-format-audit.ts <含 B/record.json 的实验目录> <新的结果文件>')
const directory=resolve(process.argv[2])
const record=JSON.parse(readFileSync(resolve(directory,'B/record.json'),'utf8'))
const failed=record.calls.find((call:{round:number;proposal?:{scope?:string;addresseeIds?:unknown}})=>
  call.round===6&&call.proposal?.scope==='direct'&&call.proposal.addresseeIds===undefined)
if(!failed)throw new Error('No matching recorded B6 failure')
const request=failed.input as PrototypeTurnRequest
const local=gatewayTurnCall(request), generic=prototypeTurnCall(request)
const ajv=new Ajv({strict:false,allErrors:true})
let repairCalls=0
await decideWithFormatRetry(local,async()=>{repairCalls++;return failed.proposal as WorldJsonValue},new AbortController().signal)
const result={source:resolve(directory,'B/record.json'),actor:failed.actor,round:failed.round,
  proposal:failed.proposal,visiblePeople:request.context.scene,
  localSchemaAccepts:ajv.compile(local.schema)(failed.proposal),genericSchemaAccepts:ajv.compile(generic.schema)(failed.proposal),
  existingRepairDecisions:repairCalls,
  hostAcceptance:false,hostReason:'publication scope and addressees do not match',
  evidenceBoundary:'Schema replay only. Host rejection is established by original B6 debug/turn source; no publication or recipient inferred.',
  conclusion:'Both schemas omit the conditional requirement. Existing schema-only repair accepts this proposal immediately; ordinary turns also do not invoke activity repair.',
  minimumRecommendation:'Align direct/private nonempty addresseeIds with host validation, then reuse one bounded format-only retry on ordinary turns. Preserve visible recipient enum and fail closed; do not infer recipients.'}
const target=resolve(process.argv[3]!)
writeFileSync(target,JSON.stringify(result,null,2)+'\n')
process.stdout.write(JSON.stringify({target,localSchemaAccepts:result.localSchemaAccepts,genericSchemaAccepts:result.genericSchemaAccepts,existingRepairDecisions:repairCalls})+'\n')
