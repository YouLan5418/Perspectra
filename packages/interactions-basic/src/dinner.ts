import { hashWorldJson, canonicalizeWorldJson, type InteractionPackageImplementation,
  type InteractionExecutionContext, type InteractionDefinitionSpec, type WorldEventDraft } from '@harness-world/contracts'
import { interactionPackageHash } from '@harness-world/interaction-runtime'

const ref=(id:string)=>({id,version:1})
const lock=(id:string)=>({ref:ref(id),dependencies:[],implementationHash:hashWorldJson('dinner-party-implementation',{id,revision:1})})
const state=(context:InteractionExecutionContext,role:string)=>{
  const target=context.roles[role]!
  return context.host.targets.find(entry=>entry.ref.kind===target.kind&&entry.ref.id===target.id)!.state
}
const config=(context:InteractionExecutionContext,name:string)=>String(context.binding.config[name])
const transition=(context:InteractionExecutionContext):WorldEventDraft[]=>[
  {eventType:'entity.upsert',eventVersion:1,data:{entityId:context.roles.item!.id,
    locationId:state(context,'actor').locationId!,kind:config(context,'resultKind')}}]
const text=(name:string)=>({name,type:'string' as const,maxBytes:1024,values:[]})
const equipment=(name:string)=>({name,kind:'entity' as const,source:{kind:'derived' as const,resolver:ref('dinner:'+name)},distinctFrom:['item']})

/** Each binding names the exact kinds it accepts and produces; the definition only says which equipment must be present. */
const kinds={
  'dinner:repair':{roles:['tool'],configs:['toolId']},
  'dinner:cook-cold':{roles:[],configs:[]},
  'dinner:cook-home':{roles:['stove'],configs:['stoveId','stoveKind']},
  'dinner:cook-feast':{roles:['stove','tool'],configs:['stoveId','stoveKind','toolId']},
} as const
const definition=(id:keyof typeof kinds):InteractionDefinitionSpec=>({
  versionTag:'interaction-definition/v1',id,version:1,
  participantRoles:[{name:'actor',kind:'character',source:{kind:'hostActor'},distinctFrom:[]},
    {name:'item',kind:'entity',source:{kind:'primaryTarget'},distinctFrom:[]},...kinds[id].roles.map(equipment)],
  argumentSchema:{fields:[]},bindingConfigSchema:{fields:[...kinds[id].configs,'requiredKind','resultKind'].map(text)},
  authorityPolicyRef:ref('base:actor-active'),observationPolicyRef:ref('base:public-outcome'),
  preconditions:[ref('dinner:item-kind'),...(kinds[id].roles.some(role=>role==='stove')?[ref('dinner:stove-ready')]:[])],
  spatialRequirementRefs:[ref('space:co-location')],
  effectBuilderRef:ref('dinner:transform'),effectCapabilityRefs:[ref('dinner:transform')],
  dependencyRefs:[],performancePolicyRef:ref('base:no-performance'),reactionEvidencePolicyRef:ref('base:no-direct'),
  lifecycleRefs:[],limits:{maximumEvents:1},
})
/** One declared object changes from one author-written kind to another, keeping its entity ID:
 * a broken stove becomes usable, raw ingredients become a particular dinner. No hidden cooking simulation. */
export function createDinnerInteractionPackage():InteractionPackageImplementation {
  const resolver=(role:'stove'|'tool')=>({lock:lock('dinner:'+role),resolve:(c:InteractionExecutionContext)=>
    c.host.targets.find(t=>t.ref.kind==='entity'&&t.ref.id===c.binding.config[role+'Id'])?.ref??null})
  const contents={rules:[
    {lock:lock('dinner:item-kind'),check:(c:InteractionExecutionContext)=>state(c,'item').kind===config(c,'requiredKind')?null:'ITEM_STATE_MISMATCH'},
    {lock:lock('dinner:stove-ready'),check:(c:InteractionExecutionContext)=>state(c,'stove').kind===config(c,'stoveKind')?null:'STOVE_NOT_READY'},
  ],effects:[{lock:lock('dinner:transform'),eventTypes:[ref('entity.upsert')],build:transition,
    validate:(context:InteractionExecutionContext,events:readonly WorldEventDraft[])=>{
      if(Buffer.from(canonicalizeWorldJson(events)).compare(Buffer.from(canonicalizeWorldJson(transition(context))))!==0)
        throw new TypeError('物品状态变化与规则不一致')
    }}],
  resolvers:[resolver('stove'),resolver('tool')],
  lifecycle:[],performances:[],reactionEvidence:[],observation:[],
  definitions:(Object.keys(kinds) as (keyof typeof kinds)[]).map(id=>({spec:definition(id),implementationHash:lock(id).implementationHash}))}
  return {...contents,lock:{ref:ref('package:dinner-party'),dependencies:[ref('package:interactions-basic')],implementationHash:interactionPackageHash(contents)}}
}
