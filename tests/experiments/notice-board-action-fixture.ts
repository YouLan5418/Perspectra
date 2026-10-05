/** Lab-only evidence acquisition. A staff reply is speech, a terminal read is display evidence. */
import { brandId, hashWorldJson, type FaultInjector, type InteractionDefinitionSpec,
  type InteractionExecutionContext, type InteractionPackageImplementation, type WorldEventDraft,
  type WorldJsonObject } from '@harness-world/contracts'
import { interactionPackageHash } from '@harness-world/interaction-runtime'
import { createNoticeBoardPackage, noticeBoardContext, noticeBoardResult } from './notice-board-capability.ts'
import { conflictingBoardWorld, secondBoardId } from './notice-board-conflict-fixture.ts'
import { openCapabilityWorld, npc, inspectDecision } from './notice-board-fixture.ts'
import { PrototypeCharacterTurn } from '../../packages/application/src/prototype-character-turn.ts'

export const askId='experiment:ask_staff',terminalId='experiment:inspect_terminal'
export const staffId='character:staff',terminalTarget='entity:registration-terminal'
export const staffText='我记得登记处在二楼203，不过我这周还没去过。'
export const terminalText='登记业务受理：一楼105；本页未标明更新时间。'
export const ref=(id:string)=>({id,version:1})
const lock=(id:string)=>({ref:ref(id),dependencies:[],
  implementationHash:hashWorldJson('evidence-action-lab',{id,revision:1})})
const object=(v:unknown):WorldJsonObject=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as WorldJsonObject:{}
function evidence(c:InteractionExecutionContext):WorldEventDraft[] {
  const ask=c.definition.id===askId,text=String(c.binding.config.text)
  const content:WorldJsonObject={actorId:c.host.actorId,sourceActionId:c.host.actionId,
    capabilityId:c.definition.id,targetId:c.roles.target!.id,subject:'registration-office',property:'location',
    ...(ask?{speech:{characterId:c.roles.target!.id,text},description:'工作人员回答：'+text}:
      {observedText:text,description:'你亲眼读取办事终端显示：'+text})}
  return [{eventType:'observation.upsert',eventVersion:1,data:{id:c.host.actionId+':acquired-evidence',
    value:{observerId:c.host.actorId,actionId:c.host.actionId,
      epistemicKind:ask?'reported_speech':'direct_observation',content}}}]
}
export function evidenceActionPackage():InteractionPackageImplementation {
  const template=createNoticeBoardPackage().definitions[0]!.spec
  const definitions=[askId,terminalId].map(id=>{
    const spec:InteractionDefinitionSpec={...template,id,
      participantRoles:[template.participantRoles[0]!,{name:'target',kind:id===askId?'character':'entity',
        source:{kind:'primaryTarget'},distinctFrom:[]}],
      bindingConfigSchema:{fields:[{name:'text',type:'string',maxBytes:1024,values:[]}]},
      authorityPolicyRef:ref('evidence:active'),preconditions:[],spatialRequirementRefs:[ref('evidence:reachable')],
      effectBuilderRef:ref('evidence:acquire'),effectCapabilityRefs:[ref('evidence:acquire')],
      observationPolicyRef:ref('evidence:self'),performancePolicyRef:ref('evidence:none'),
      reactionEvidencePolicyRef:ref('evidence:no-reaction')}
    return {spec,implementationHash:lock(id).implementationHash}
  })
  const state=(c:InteractionExecutionContext,role:string)=>c.host.targets.find(t=>
    t.ref.id===c.roles[role]!.id&&t.ref.kind===c.roles[role]!.kind)!.state
  const contents:Omit<InteractionPackageImplementation,'lock'>={definitions,
    rules:[{lock:lock('evidence:active'),check:c=>state(c,'actor').lifecycle==='active'
      &&c.host.authority.sourceRole!=='director'?null:'ACTOR_CANNOT_ACT'},
      {lock:lock('evidence:reachable'),check:c=>state(c,'actor').locationId===state(c,'target').locationId
        &&(c.definition.id===askId?state(c,'target').lifecycle==='active':state(c,'target').kind==='registration-terminal')
        ?null:'EVIDENCE_NOT_REACHABLE'}],
    effects:[{lock:lock('evidence:acquire'),eventTypes:[ref('observation.upsert')],build:evidence,
      validate:(c,events)=>{if(hashWorldJson('acquire-evidence',events)!==hashWorldJson('acquire-evidence',evidence(c)))
        throw new Error('evidence must equal trusted scripted response or terminal display')}}],
    resolvers:[],lifecycle:[],
    performances:[{lock:lock('evidence:none'),policy:{version:'interaction-performance/v1',accepted:[]}}],
    reactionEvidence:[{lock:lock('evidence:no-reaction'),policy:{version:'interaction-reaction-evidence/v1',directRoles:[]}}],
    observation:[{lock:lock('evidence:self'),policy:{version:'interaction-observation-policy/v1',onAccepted:'self',onRejected:'self'}}]}
  return {...contents,lock:{...lock('package:evidence-action-lab'),implementationHash:interactionPackageHash(contents)}}
}
export function actionWorld() {
  const base=conflictingBoardWorld(),pack=evidenceActionPackage()
  const terminal={entityId:terminalTarget,kind:'registration-terminal',locationId:'location:room'}
  const staff={...base.manifest.characters[0]!,characterId:brandId(staffId,'CharacterId'),name:'工作人员',portrayal:null}
  const places=[{locationId:'location:203',name:'二楼203'},{locationId:'location:105',name:'一楼105'}]
  const catalog=base.manifest.interactionCatalog
  const manifest={...base.manifest,characters:[...base.manifest.characters,staff],
    entities:[...base.manifest.entities,terminal],locations:[...base.manifest.locations,...places],
    scenes:base.manifest.scenes.map(s=>({...s,participantIds:[...s.participantIds,staff.characterId]})),
    interactionCatalog:{...catalog,packages:[...catalog.packages,pack.lock],
      definitions:[...catalog.definitions,...pack.definitions.map(d=>({ref:ref(d.spec.id),
        definitionHash:hashWorldJson('interaction-definition/v1',d.spec),implementationHash:d.implementationHash}))],
      bindings:[...catalog.bindings,
        {bindingId:'binding:staff:ask',targetRef:{kind:'character' as const,id:staffId},definitionRef:ref(askId),config:{text:staffText}},
        {bindingId:'binding:terminal:inspect',targetRef:{kind:'entity' as const,id:terminalTarget},definitionRef:ref(terminalId),config:{text:terminalText}},
      ].sort((a,b)=>a.bindingId<b.bindingId?-1:1)}}
  const manifestHash=hashWorldJson('compiled-world-manifest',manifest)
  const genesisEvents:WorldEventDraft[]=base.genesisEvents.map(e=>e.eventType==='world.manifest-locked'
    ?{...e,data:{...e.data as WorldJsonObject,manifestHash}}:e.eventType==='scene.upsert'
      ?{...e,data:{...e.data as WorldJsonObject,value:{...object(object(e.data).value),
        participantIds:[npc,'character:player','character:bob',staffId]}}}:e)
  genesisEvents.push({eventType:'character.created',eventVersion:1,data:{...staff,lifecycleState:'active'}},
    {eventType:'entity.upsert',eventVersion:1,data:terminal},
    ...places.map(p=>({eventType:'location.upsert',eventVersion:1,data:p})))
  return {manifest,manifestHash,genesisEvents,genesisHash:hashWorldJson('world-genesis-plan',genesisEvents)}
}
export const openActionWorld=(dir:string,reopen=false,fault?:FaultInjector)=>
  openCapabilityWorld(dir,fault,reopen,actionWorld(),[evidenceActionPackage()])
export function evidenceDecision(id=askId) {
  return {decision:'perform',actionType:'interact',parameters:{
    targetRef:{kind:id===askId?'character':'entity',id:id===askId?staffId:terminalTarget},
    bindingId:id===askId?'binding:staff:ask':'binding:terminal:inspect',definitionRef:ref(id),arguments:{}}}
}
export function actionContext(context:WorldJsonObject):WorldJsonObject {
  const c=noticeBoardContext(context)
  return {...c,affordances:(c.affordances as WorldJsonObject[]).map(a=>a.actionType!=='interact'?a:
    {...a,interactions:(a.interactions as WorldJsonObject[]).map(i=>({...i,
      ...((object(i.definitionRef).id===askId)?{label:'询问工作人员登记处的位置'}:
        object(i.definitionRef).id===terminalId?{label:'查看办事终端'}:
        object(i.targetRef).id===secondBoardId?{label:'查看窗口指示牌'}:{})}))})}
}
export function actionResult(input:Parameters<typeof noticeBoardResult>[0]):WorldJsonObject {
  const params=object(input.action.parameters),id=object(params.definitionRef).id
  if(id!==askId&&id!==terminalId)return noticeBoardResult(input)
  if(input.status!=='accepted')return {status:input.status,description:'这次未获得工作人员回答或终端内容。'}
  const event=input.events.findLast(e=>{
    const v=object(object(e.data).value),c=object(v.content)
    return e.eventType==='observation.upsert'&&v.observerId===input.actorId&&c.capabilityId===id
      &&c.targetId===object(params.targetRef).id&&c.sourceActionId===v.actionId})
  if(!event)throw new Error('accepted capability has no acquired Source')
  const v=object(object(event.data).value),c=object(v.content)
  const resolution=input.events.findLast(e=>e.eventType==='action.resolved'&&object(e.data).actorId===input.actorId)
  if(resolution&&input.events.indexOf(resolution)>input.events.indexOf(event)
    &&object(resolution.data).actionId!==v.actionId)throw new Error('stale acquired evidence')
  return {status:input.status,description:c.description!,evidence:{actionId:v.actionId!,
    epistemicKind:v.epistemicKind!,targetId:c.targetId!,subject:c.subject!,property:c.property!}}
}
/** Scripted setup reads are not autonomous choices. */
export async function setupRead(f:ReturnType<typeof openActionWorld>,target:string) {
  const turn=new PrototypeCharacterTurn({address:f.address,store:f.store,memory:f.memory,leases:f.leases,
    availability:f.availability,rulebooks:f.rules,executionResult:actionResult,projectContext:actionContext,
    decide:async()=>inspectDecision(target)})
  const r=await turn.run(npc,{maxCalls:1})
  if(r.performResult?.status!=='accepted')throw new Error('setup read rejected')
}
