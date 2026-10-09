import { hashWorldJson, canonicalizeWorldJson, type InteractionPackageImplementation,
  type InteractionExecutionContext, type InteractionDefinitionSpec, type WorldEventDraft } from '@harness-world/contracts'
import { interactionPackageHash } from '@harness-world/interaction-runtime'
import { createBasicInteractionPackage } from './basic.ts'

const ref=(id:string)=>({id,version:1})
const lock=(id:string)=>({ref:ref(id),dependencies:[],implementationHash:hashWorldJson('home-meal-implementation',{id,revision:1})})
const state=(context:InteractionExecutionContext,role:string)=>{
  const target=context.roles[role]!
  return context.host.targets.find(entry=>entry.ref.kind===target.kind&&entry.ref.id===target.id)!.state
}
const transition=(context:InteractionExecutionContext,kind:string):WorldEventDraft[]=>[
  {eventType:'entity.upsert',eventVersion:1,data:{entityId:context.roles.item!.id,
    locationId:state(context,'actor').locationId!,kind}}]
const effect=(id:string,kind:string)=>({lock:lock(id),eventTypes:[ref('entity.upsert')],
  build:(context:InteractionExecutionContext)=>transition(context,kind),
  validate:(context:InteractionExecutionContext,events:readonly WorldEventDraft[])=>{
    if(Buffer.from(canonicalizeWorldJson(events)).compare(Buffer.from(canonicalizeWorldJson(transition(context,kind))))!==0)
      throw new TypeError('料理结果与规则不一致')
  }})
const definition=(id:string,cook:boolean):InteractionDefinitionSpec=>({
  versionTag:'interaction-definition/v1',id,version:1,
  participantRoles:[{name:'actor',kind:'character',source:{kind:'hostActor'},distinctFrom:[]},
    {name:'item',kind:'entity',source:{kind:'primaryTarget'},distinctFrom:[]},
    ...(cook?[{name:'equipment',kind:'entity' as const,source:{kind:'derived' as const,resolver:ref('home:equipment')},distinctFrom:['item']}]:[])],
  argumentSchema:{fields:[]},bindingConfigSchema:{fields:cook?[{name:'equipmentId',type:'string',maxBytes:200,values:[]}]:[]},
  authorityPolicyRef:ref('base:actor-active'),observationPolicyRef:ref('base:public-outcome'),
  preconditions:[ref(cook?'home:raw-rice':'home:cooked-rice')],
  spatialRequirementRefs:[ref('space:co-location'),...(cook?[ref('home:cooker')]:[])],
  effectBuilderRef:ref(cook?'home:cook-effect':'home:eat-effect'),effectCapabilityRefs:[ref(cook?'home:cook-effect':'home:eat-effect')],
  dependencyRefs:[],performancePolicyRef:ref('base:no-performance'),reactionEvidencePolicyRef:ref('base:no-direct'),
  lifecycleRefs:[],limits:{maximumEvents:1},
})
/** One declared meal batch changes raw -> cooked -> empty, preserving its entity ID.
 * No hunger simulation, invented inventory, or compatibility changes to the basic package. */
export function createHomeInteractionPackage():InteractionPackageImplementation {
  const contents={rules:[
    {lock:lock('home:raw-rice'),check:(c:InteractionExecutionContext)=>state(c,'item').kind==='raw-rice-kit'?null:'RAW_RICE_REQUIRED'},
    {lock:lock('home:cooked-rice'),check:(c:InteractionExecutionContext)=>state(c,'item').kind==='cooked-rice'?null:'COOKED_RICE_REQUIRED'},
    {lock:lock('home:cooker'),check:(c:InteractionExecutionContext)=>state(c,'equipment').kind==='rice-cooker'&&state(c,'equipment').holderId===null?null:'COOKER_REQUIRED'},
  ],effects:[effect('home:cook-effect','cooked-rice'),effect('home:eat-effect','empty-meal-container')],
  resolvers:[{lock:lock('home:equipment'),resolve:(c:InteractionExecutionContext)=>
    c.host.targets.find(t=>t.ref.kind==='entity'&&t.ref.id===c.binding.config.equipmentId)?.ref??null}],
  lifecycle:[],performances:[],reactionEvidence:[],observation:[],
  definitions:['home:cook-rice','home:eat-rice'].map(id=>({spec:definition(id,id==='home:cook-rice'),implementationHash:lock(id).implementationHash}))}
  return {...contents,lock:{ref:ref('package:home-meal'),dependencies:[ref('package:interactions-basic')],implementationHash:interactionPackageHash(contents)}}
}
export const createInstalledInteractionPackages=()=>[createBasicInteractionPackage(),createHomeInteractionPackage()]
