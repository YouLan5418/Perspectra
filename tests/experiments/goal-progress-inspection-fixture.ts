import { canonicalizeWorldJson, hashWorldJson, type InteractionDefinitionSpec, type InteractionExecutionContext,
  type InteractionPackageImplementation, type WorldEventDraft } from '@harness-world/contracts'
import { interactionPackageHash } from '@harness-world/interaction-runtime'

const ref=(id:string)=>({id,version:1})
const lock=(id:string)=>({ref:ref(id),dependencies:[],implementationHash:hashWorldJson('goal-progress-author-fixture',{id,revision:1})})
const state=(c:InteractionExecutionContext,role:string)=>c.host.targets.find(t=>t.ref.id===c.roles[role]!.id&&t.ref.kind===c.roles[role]!.kind)!.state
const outcome=(c:InteractionExecutionContext):WorldEventDraft[]=>{
 const index=c.roles.item!.id==='entity:index'
 // Both finite results are authored fixture content. No model, global search or objective-completion inference.
 const metadata={definitionId:'experiment:inspect-shelf',range:index?'借阅索引':'西侧目录架',finding:index?'catalogue_entry':'not_found'}
 const description=index?'检查了借阅索引，其中一条登记写明：摘要原件目前留在前室桌上，可前往核实。登记只是一条线索，不代表已经取得原件。'
  :'已检查西侧目录架的摘要分栏，本次在该范围未发现摘要原件。没有检查其他架位、借阅索引或前室；不证明整个档案室没有原件。'
 return [{eventType:'observation.upsert',eventVersion:1,data:{id:`${c.host.actionId}:inspection`,value:{observerId:c.roles.actor!.id,
  actionId:c.host.actionId,content:{actorId:c.roles.actor!.id,actionType:'interact',status:'accepted',resultDescription:description,resultMetadata:metadata}}}}]
}
export function goalProgressInspectionPackage():InteractionPackageImplementation {
 const spec:InteractionDefinitionSpec={versionTag:'interaction-definition/v1',id:'experiment:inspect-shelf',version:1,
  participantRoles:[{name:'actor',kind:'character',source:{kind:'hostActor'},distinctFrom:[]},{name:'item',kind:'entity',source:{kind:'primaryTarget'},distinctFrom:[]}],
  argumentSchema:{fields:[]},bindingConfigSchema:{fields:[]},authorityPolicyRef:ref('base:actor-active'),observationPolicyRef:ref('base:public-outcome'),
  preconditions:[ref('experiment:inspectable')],spatialRequirementRefs:[ref('space:co-location')],
  effectBuilderRef:ref('experiment:inspection-result'),effectCapabilityRefs:[ref('experiment:inspection-result')],dependencyRefs:[],
  performancePolicyRef:ref('base:no-performance'),reactionEvidencePolicyRef:ref('base:no-direct'),lifecycleRefs:[],limits:{maximumEvents:1}}
 const contents={rules:[{lock:lock('experiment:inspectable'),check:(c:InteractionExecutionContext)=>
  ['entity:west-shelf','entity:index'].includes(c.roles.item!.id)&&state(c,'actor').locationId==='location:back-room'?null:'NOT_CO_LOCATED'}],
  effects:[{lock:lock('experiment:inspection-result'),eventTypes:[ref('observation.upsert')],build:outcome,
   validate:(c:InteractionExecutionContext,events:readonly WorldEventDraft[])=>{
    if(Buffer.from(canonicalizeWorldJson(events)).compare(Buffer.from(canonicalizeWorldJson(outcome(c))))!==0)throw new TypeError('调查结果与声明范围不一致')
   }}],resolvers:[],lifecycle:[],performances:[],reactionEvidence:[],observation:[],
  definitions:[{spec,implementationHash:lock(spec.id).implementationHash}]}
 return {...contents,lock:{ref:ref('package:goal-progress-investigation'),dependencies:[ref('package:interactions-basic')],implementationHash:interactionPackageHash(contents)}}
}
