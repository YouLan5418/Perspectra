import { parseExpressionSegments, checkExpressionPolicy } from '@harness-world/contracts'
import Ajv from 'ajv'
import type { ChatCall } from '@harness-world/provider-chat'
import type { WorldJsonValue } from '@harness-world/contracts'
import { createHash, randomUUID } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'
import { createContext, Script } from 'node:vm'
import { brandId, canonicalizeWorldJson, resolutionAuthority, type WorldAddress,
  type WorldJsonObject, type WorldEventDraft } from '@harness-world/contracts'
import { WorldStore, WriterLeaseService, CharacterRuntimeAvailabilityService } from '@harness-world/store-sqlite'
import { SceneDecisionService } from '@harness-world/application'
import { createBasicInteractionPackage } from '@harness-world/interactions-basic'
import { createCoreRulebookRegistry, RulebookRegistry, type RulebookEvent, type RulebookResolver,
  type RulebookResolutionContext, type ActionAffordance, type CompiledWorldManifest } from '@harness-world/kernel'
import type { CompiledWorldPackV5 } from '@harness-world/world-pack'
import { PrototypeInvalidOutputError, type PrototypeTurnRequest } from '../../packages/application/src/prototype-character-turn.ts'
import { characterExecutionResult } from '../../packages/application/src/character-execution-result.ts'

/** One schema-only retry for an activity decision; execution/permissions are still validated by the turn. */
export async function decideActivityFormat(call: ChatCall, decide: (call: ChatCall) => Promise<WorldJsonValue>,
  signal: AbortSignal, schema: WorldJsonObject = call.schema): Promise<WorldJsonValue> {
  const validate = new Ajv({ strict: false, allErrors: true }).compile(schema)
  signal.throwIfAborted()
  const first = await decide(call)
  signal.throwIfAborted()
  if (validate(first)) return first
  // No invalid dialogue is published or appended to the visible context. Only field diagnostics are returned.
  const issues = (validate.errors ?? []).map(e => ({ path: e.instancePath, keyword: e.keyword,
    ...(e.keyword === 'additionalProperties' ? { field: e.params.additionalProperty } : {}),
    ...(e.keyword === 'type' ? { expectedType: e.params.type } : {}) }))
  const chosen = first !== null && typeof first === 'object' && !Array.isArray(first) ? first as WorldJsonObject : {}
  const branches = Array.isArray(schema.oneOf) ? schema.oneOf as WorldJsonObject[] : []
  const selected = branches.filter(branch => {
    const properties = branch.properties as WorldJsonObject | undefined
    return (properties?.decision as WorldJsonObject | undefined)?.const === chosen.decision
      && (chosen.decision !== 'perform' || (properties?.actionType as WorldJsonObject | undefined)?.const === chosen.actionType)
  })
  // The local gateway flattens root unions. On correction expose only the model's chosen legal branch,
  // never delete fields from its payload or grant a new action. The result still gets full validation.
  let retrySchema = selected.length === 1 ? selected[0]! : call.schema
  if (selected.length === 1 && chosen.decision === 'perform') {
    const properties = retrySchema.properties as WorldJsonObject
    const parameters = properties.parameters as WorldJsonObject
    const choices = Array.isArray(parameters.oneOf) ? parameters.oneOf as WorldJsonObject[] : []
    const proposed = chosen.parameters as WorldJsonObject | undefined
    const matches = choices.filter(choice => {
      const fields = choice.properties as WorldJsonObject
      const target = fields.targetRef as WorldJsonObject, definition = fields.definitionRef as WorldJsonObject
      return (fields.bindingId as WorldJsonObject).const === proposed?.bindingId
        && ((target.properties as WorldJsonObject).id as WorldJsonObject).const === (proposed?.targetRef as WorldJsonObject | undefined)?.id
        && ((definition.properties as WorldJsonObject).id as WorldJsonObject).const === (proposed?.definitionRef as WorldJsonObject | undefined)?.id
    })
    if (matches.length === 1) retrySchema = { ...retrySchema, properties: { ...properties, parameters: matches[0]! } }
  }
  // Some local gateways stringify numeric const values. Equal numeric bounds express the same
  // constraint without converting any model output; the original schema remains the validator.
  const numericBounds = (value: WorldJsonValue): WorldJsonValue => {
    if (Array.isArray(value)) return value.map(numericBounds)
    if (value === null || typeof value !== 'object') return value
    const result = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, numericBounds(item)])) as WorldJsonObject
    if (typeof result.const === 'number') { const { const: fixed, ...fields } = result; return { ...fields, minimum: fixed, maximum: fixed } }
    return result
  }
  const revised: ChatCall = { ...call, schema: numericBounds(retrySchema) as WorldJsonObject,
    messages: [...call.messages, { role: 'system', content:
    '上一次返回不符合本次工具 JSON schema。请重新选择一个合法分支；perform 只含 decision、actionType、parameters；对白属于 publish。'
    + 'integer/number 字段必须返回 JSON 数值，不能用带引号的字符串代替；尤其 definitionRef.version 和 arguments.revision。'
    + '不改变上下文、可用操作或剩余预算，不预先声称执行成功。格式错误：' + JSON.stringify(issues) }] }
  const second = await decide(revised)
  signal.throwIfAborted()
  if (!validate(second)) throw new PrototypeInvalidOutputError('角色活动输出格式修正后仍无效；本次未执行操作。')
  return second
}

type Game = WorldJsonObject & { active: boolean; phase: string; turn: string|null; round: number;
  public: WorldJsonObject; private: WorldJsonObject; internal: WorldJsonObject }
export type ActivityState = WorldJsonObject & { id: string; revision: number; participants: string[]; game: Game }
type Policy = WorldJsonObject & { speech: 'free'|'none'|'choices'; speechChoices: string[];
  narration: boolean; move: boolean; interactions: string[]; operations: string[] }
type Operation = { id: string; label: string; requiresTurn: boolean; schema: WorldJsonObject }
export interface ActivityRequest {
  readonly activityId: string|null
  readonly revision: number
  readonly operation: string
  readonly parameters: WorldJsonObject
  readonly requestId: string
}
function object(value: unknown): WorldJsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('活动数据必须是对象')
  return value as WorldJsonObject
}
function exact(value: WorldJsonObject, keys: string[]): void {
  if (Object.keys(value).sort().join(',') !== keys.sort().join(',')) throw new TypeError('活动字段不合法')
}
function strings(value: unknown): string[] {
  if (!Array.isArray(value) || value.some(v=>typeof v !== 'string') || new Set(value).size!==value.length) {
    throw new TypeError('活动列表必须是互不重复的字符串')
  }
  return value as string[]
}
function json(value: WorldJsonObject): string { return Buffer.from(canonicalizeWorldJson(value)).toString('utf8') }

/** Trusted, synchronous creator rules; all writes and model calls remain in the host. */
export class PackActivity {
  #randomValues: number[] = []
  #randomReplay: readonly number[] | undefined
  #randomCursor = 0
  beginRoundRandom(values?: readonly number[]): void { this.#randomValues = []; this.#randomReplay = values; this.#randomCursor = 0 }
  roundRandom(): number[] { return [...this.#randomValues] }
  #initialRandom(): number {
    const value = this.#randomReplay === undefined ? Math.random() : this.#randomReplay[this.#randomCursor]
    if (value === undefined) throw new TypeError('活动初始化随机记录不足。')
    this.#randomCursor++; this.#randomValues.push(value); return value
  }
  readonly #script: Script
  readonly #operations: Operation[]
  readonly #validators = new Map<string, ReturnType<Ajv['compile']>>()
  readonly title: string
  readonly npcIds: string[]
  constructor(source: string, readonly worldPath: string, readonly address: WorldAddress, readonly playerId: string) {
    this.#script = new Script(source+'\nJSON.stringify(__method === "definition" ? activityScript.definition : activityScript[__method](...JSON.parse(__args)))')
    const definition=object(this.#call('definition',[]))
    exact(definition,['title','npcIds','operations'])
    if (typeof definition.title!=='string' || definition.title.length>80
      || !Array.isArray(definition.operations) || definition.operations.length>16) throw new TypeError('活动定义无效')
    this.title=definition.title; this.npcIds=strings(definition.npcIds)
    if(this.npcIds.length>8 || this.npcIds.includes(playerId))throw new TypeError('活动 NPC 列表无效')
    const ajv=new Ajv({ strict:true, allErrors:false })
    this.#operations=definition.operations.map(value=>{
      const op=object(value);exact(op,['id','label','requiresTurn','schema'])
      if(typeof op.id!=='string' || !/^[a-z][a-z0-9-]{0,40}$/u.test(op.id) || typeof op.label!=='string'
        || typeof op.requiresTurn!=='boolean') throw new TypeError('操作定义无效')
      const schema=object(op.schema)
      if(schema.type!=='object' || schema.additionalProperties!==false) throw new TypeError('操作必须声明封闭对象参数')
      const properties=object(schema.properties ?? {})
      if(Object.hasOwn(properties,'activityId') || Object.hasOwn(properties,'revision'))throw new TypeError('活动参数不得覆盖宿主版本字段')
      if(this.#validators.has(op.id))throw new TypeError('重复的活动操作')
      this.#validators.set(op.id,ajv.compile(schema))
      return {id:op.id,label:op.label,requiresTurn:op.requiresTurn,schema}
    })
    // Validate restored committed state without publishing internal/private game data.
    this.current()
  }
  static load(packPath:string, pack:CompiledWorldPackV5, worldPath:string,address:WorldAddress,playerId:string) {
    const entry='scripts/activity.js', lock=pack.assets.find(a=>a.path===entry)
    if(!lock)return undefined
    const file=resolve(packPath,entry)
    if(!lstatSync(file).isFile() || relative(realpathSync(packPath),realpathSync(file))!==entry.split('/').join(sep)) {
      throw new TypeError('活动脚本必须位于包内')
    }
    const bytes=readFileSync(file)
    if(bytes.length>65536 || bytes.length!==lock.size
      || 'sha256:'+createHash('sha256').update(bytes).digest('hex')!==lock.contentHash) throw new TypeError('活动脚本与编译资产不一致')
    return new PackActivity(bytes.toString('utf8'),worldPath,address,playerId)
  }
  #call(method:string,args:unknown[]):unknown {
    const input=JSON.stringify(args)
    if(input.length>65536)throw new RangeError('活动输入过长')
    const context=createContext(Object.assign(Object.create(null),{__method:method,__args:input, ...(method === 'initialize' ? {__initialRandom: () => this.#initialRandom()} : {})}),
      {codeGeneration:{strings:false,wasm:false},microtaskMode:'afterEvaluate'})
    let output:unknown
    try{
      if (method === 'initialize') new Script('Math.random = __initialRandom').runInContext(context, {timeout:100})
      output=this.#script.runInContext(context,{timeout:100})
    }
    catch{throw new TypeError('包内活动脚本执行失败或超时')}
    if(typeof output!=='string' || output.length>65536)throw new TypeError('活动脚本必须返回有限 JSON')
    return JSON.parse(output)
  }
  #game(value:unknown,participants:string[]):Game {
    const game=object(value)
    exact(game,['active','phase','turn','round','public','private','internal'])
    if(typeof game.active!=='boolean' || typeof game.phase!=='string' || game.phase.length>80
      || !Number.isSafeInteger(game.round) || Number(game.round)<1
      || (game.active ? !participants.includes(String(game.turn)) : game.turn!==null)) throw new TypeError('活动阶段或轮次无效')
    object(game.public);object(game.internal)
    const owners=object(game.private)
    if(Object.keys(owners).sort().join(',')!==[...participants].sort().join(','))throw new TypeError('私有变量角色无效')
    for(const value of Object.values(owners))object(value)
    if(json(game).length>65536)throw new RangeError('活动状态过长')
    return game as Game
  }
  state(events:readonly RulebookEvent[]):ActivityState|undefined {
    const event=events.findLast(e=>e.eventType==='activity.updated')
    if(!event)return undefined
    const state=object(object(event.data).state)
    exact(state,['id','revision','participants','game'])
    const participants=strings(state.participants)
    if(typeof state.id!=='string' || !Number.isSafeInteger(state.revision) || Number(state.revision)<1
      || json({participants})!==json({participants:[this.playerId,...this.npcIds]}))throw new TypeError('活动存档损坏')
    this.#game(state.game,participants)
    return state as ActivityState
  }
  current():ActivityState|undefined {
    const store=new WorldStore(this.worldPath)
    try{return this.state(store.readEvents(this.address))}finally{store.close()}
  }
  scoped(state:ActivityState,actorId:string):WorldJsonObject {
    if(!state.participants.includes(actorId))throw new TypeError('不是活动参与者')
    return {id:state.id,revision:state.revision,participants:state.participants,
      game:{active:state.game.active,phase:state.game.phase,turn:state.game.turn,round:state.game.round,
        public:state.game.public,private:object(state.game.private[actorId])}}
  }
  policy(state:ActivityState,actorId:string):Policy {
    const policy=object(this.#call('policy',[this.scoped(state,actorId),actorId]))
    exact(policy,['speech','speechChoices','narration','move','interactions','operations'])
    if(!['free','none','choices'].includes(String(policy.speech)) || typeof policy.narration!=='boolean'
      || typeof policy.move!=='boolean')throw new TypeError('活动许可无效')
    strings(policy.speechChoices);strings(policy.interactions)
    if(strings(policy.operations).some(id=>!this.#validators.has(id)))throw new TypeError('脚本请求了未安装的操作')
    return policy as Policy
  }
  options(state:ActivityState,actorId:string):WorldJsonObject[] {
    const policy=this.policy(state,actorId)
    return this.#operations.filter(op=>policy.operations.includes(op.id)
      && (!op.requiresTurn || state.game.turn===actorId)).map(op=>({
      label:op.label,targetRef:{kind:'character',id:actorId},bindingId:state.id,
      definitionRef:{id:'activity:'+op.id,version:1},arguments:{activityId:state.id,revision:state.revision},
      argumentSchema:{...op.schema,required:['activityId','revision',...(op.schema.required as string[] ?? [])],
        properties:{...object(op.schema.properties ?? {}),activityId:{const:state.id,type:'string'},
          revision:{const:state.revision,type:'integer'}}},
    }))
  }
  view(actorId:string) {
    const state=this.current()
    return {title:this.title,available:true,...(state && state.participants.includes(actorId)?{
      ...this.scoped(state,actorId),policy:state.game.active?this.policy(state,actorId):null,
      options:state.game.active?this.options(state,actorId):[],
    }:{id:null,revision:0})}
  }
  #check(state:ActivityState|undefined,id:unknown,revision:unknown,actorId:string):asserts state is ActivityState {
    if(!state?.game.active || state.id!==id || state.revision!==revision || !state.participants.includes(actorId)) {
      throw new TypeError('活动请求已失效，请刷新；这次没有执行')
    }
  }
  projectContext(context:WorldJsonObject,canPerform:boolean):WorldJsonObject {
    const state=this.current(),actorId=String(object(context.character).characterId)
    if(!state?.game.active || !state.participants.includes(actorId))return context
    const policy=this.policy(state,actorId)
    return {...context,activity:this.scoped(state,actorId),expressionPolicy:{
      speech:policy.speech,speechChoices:policy.speechChoices,narration:policy.narration},
      affordances:this.filterAffordances(context.affordances as unknown as ActionAffordance[],state,actorId,canPerform) as unknown as WorldJsonObject[]}
  }
  filterAffordances(base:readonly ActionAffordance[],state:ActivityState,actorId:string,canPerform=true):ActionAffordance[] {
    const policy=this.policy(state,actorId)
    const result:ActionAffordance[]=base.flatMap(a=>a.actionType==='move' ? (policy.move&&canPerform?[a]:[])
      : a.actionType==='interact' ? [{...a,interactions:canPerform?(a.interactions??[]).filter(i=>
        policy.interactions.includes(String(object(i.definitionRef).id))):[]}]
        : a.actionType==='speak' && (policy.speech!=='none'||policy.narration)?[a]:[])
    const choices=canPerform?this.options(state,actorId):[]
    if(choices.length)result.push({actionType:'interact',actionVersion:2,interactions:choices})
    // One interact entry: wire builders intentionally select a single affordance per action type.
    const interactions=result.filter(a=>a.actionType==='interact').flatMap(a=>a.interactions??[])
    return [...result.filter(a=>a.actionType!=='interact'),...(interactions.length?[{actionType:'interact',actionVersion:2,interactions}]:[])]
  }
  validateDecision(decision:WorldJsonObject,request:PrototypeTurnRequest):void {
    const anchor=request.context.activity
    if(anchor===undefined)return
    const actor=String(object(request.context.character).characterId),snapshot=object(anchor),state=this.current()
    this.#check(state,snapshot.id,snapshot.revision,actor)
    const policy=this.policy(state,actor)
    if(decision.decision==='publish'){
      if(Object.keys(decision).some(k=>!['decision','segments','addresseeIds'].includes(k)))throw new TypeError('非法混合输出整包拒绝')
      checkExpressionPolicy(parseExpressionSegments(decision.segments), policy)
    }else if(decision.decision==='perform'){
      if(Object.keys(decision).sort().join(',')!=='actionType,decision,parameters')throw new TypeError('非法混合输出整包拒绝')
    }
  }
  checkExpression(policy:Policy,parameters:WorldJsonObject):void {
    if((!policy.narration && Object.hasOwn(parameters,'narration'))
      || (policy.speech==='none' && Object.hasOwn(parameters,'speech'))
      || (policy.speech==='choices' && Object.hasOwn(parameters,'speech')
        && !policy.speechChoices.includes(String(parameters.speech))))throw new TypeError('当前表达不在创作者许可内')
  }
  rulebooks():RulebookRegistry {
    const base=createCoreRulebookRegistry({interactionPackages:[createBasicInteractionPackage()]})
      .resolve('builtin:speak-move',2,'activity',this.address)
    const resolver:RulebookResolver={
      affordances:context=>{
        const values=base.affordances(context),state=this.state(context.events),actor=String(context.characterId)
        return state?.game.active && state.participants.includes(actor)?this.filterAffordances(values,state,actor):values
      },
      resolve:context=>this.#resolve(context,base),
    }
    const registry=new RulebookRegistry();registry.register('builtin:speak-move',2,resolver);return registry
  }
  #resolve(context:RulebookResolutionContext,base:RulebookResolver) {
    const state=this.state(context.events),actor=String(context.characterId),action=context.action
    const p=object(action.parameters),definition=typeof p.definitionRef==='object'?object(p.definitionRef):undefined
    if(typeof definition?.id==='string' && definition.id.startsWith('activity:')){
      if(action.actionType!=='interact')throw new TypeError('游戏操作必须使用 interact')
      exact(p,['targetRef','bindingId','definitionRef','arguments'])
      exact(definition,['id','version'])
      const args=object(p.arguments),target=object(p.targetRef)
      this.#check(state,args.activityId,args.revision,actor)
      if(p.bindingId!==state.id || json(target)!==json({kind:'character',id:actor}) || definition.version!==1)throw new TypeError('活动绑定无效')
      const operation=definition.id.slice(9),op=this.#operations.find(v=>v.id===operation),policy=this.policy(state,actor)
      if(!op || !policy.operations.includes(operation) || op.requiresTurn&&state.game.turn!==actor)throw new TypeError('尚未轮到你或操作未被允许')
      const {activityId:_id,revision:_revision,...parameters}=args
      if(!this.#validators.get(operation)!(parameters))throw new TypeError('游戏操作参数无效')
      const resolved=object(this.#call('resolve',[state,actor,operation,parameters]))
      exact(resolved,['game','description','audience'])
      if(typeof resolved.description!=='string'||resolved.description.length>2000
        || !['participants','self'].includes(String(resolved.audience)))throw new TypeError('游戏结果无效')
      const next={...state,revision:state.revision+1,game:this.#game(resolved.game,state.participants)}
      return {status:'accepted' as const,events:[this.#event(next,resolved.description,actor,context.actionId??'',operation)],
        observationScope:{scope:'direct' as const,recipientIds:resolved.audience==='self'?[actor]:state.participants}}
    }
    if(state?.game.active && state.participants.includes(actor)){
      const policy=this.policy(state,actor)
      if(action.actionType==='speak'){
        const expression={...(Object.hasOwn(p,'text') && p.text!==''?{speech:p.text}:{}),
          ...(Object.hasOwn(p,'narration')&&p.narration!==''?{narration:p.narration}:{})}
        if (p.segments !== undefined) checkExpressionPolicy(parseExpressionSegments(p.segments), policy)
        else this.checkExpression(policy,expression)
      }else if(action.actionType==='move'){
        if(!policy.move)throw new TypeError('活动期间禁止移动')
      }else if(action.actionType!=='interact' || !policy.interactions.includes(String(definition?.id))){
        throw new TypeError('活动期间禁止此交互')
      }
    }
    return base.resolve(context)
  }
  #event(state:ActivityState,description:string,actorId:string,actionId:string,operation:string):WorldEventDraft {
    return {eventType:'activity.updated',eventVersion:1,data:{state,description,actorId,actionId,operation}}
  }
  #resultMetadata(state:ActivityState,operation:string):WorldJsonObject {
    return {activity:{id:state.id,revision:state.revision,phase:state.game.phase,round:state.game.round,
      active:state.game.active,lifecycle:operation==='start'?'started':state.game.active?'updated':'ended'}}
  }
  executionResult=(input:Parameters<typeof characterExecutionResult>[0])=>{
    const parameters=object(input.action.parameters)
    if(String(object(parameters.definitionRef??{}).id).startsWith('activity:') && input.status==='accepted'){
      const latest=input.events.findLast(e=>e.eventType==='activity.updated')
      if(latest){
        const data=object(latest.data)
        return {status:'accepted' as const,description:String(data.description),
          observationMetadata:this.#resultMetadata(this.state([latest])!,String(data.operation))}
      }
    }
    return characterExecutionResult(input)
  }
  #plan(value:unknown):string|undefined {
    const plan=object(value)
    if(plan.kind==='wait'){exact(plan,['kind']);return undefined}
    exact(plan,['kind','characterId'])
    const state=this.current()
    if(plan.kind!=='activate' || typeof plan.characterId!=='string' || !this.npcIds.includes(plan.characterId)
      || !state?.game.active || !state.participants.includes(plan.characterId))throw new TypeError('调度请求了未授权角色')
    return plan.characterId
  }
  schedule():string|undefined {
    const state=this.current()
    if(!state?.game.active)return undefined
    return this.#plan(this.#call('schedule',[this.scoped(state,this.playerId)]))
  }
  outcome(result:WorldJsonObject):string|undefined {
    const state=this.current()
    if(!state?.game.active)return undefined
    return this.#plan(this.#call('onOutcome',[result,this.scoped(state,this.playerId)]))
  }
  #observations(state:ActivityState,description:string,actor:string,actionId:string,observerIds=state.participants):WorldEventDraft[] {
    return observerIds.map(observerId=>({eventType:'observation.upsert',eventVersion:1,data:{
      id:actionId+':'+observerId,value:{observerId,actionId,epistemicKind:'observed_action',
        content:{status:'accepted',actionType:'interact',actorId:actor,resultDescription:description,
          resultMetadata:this.#resultMetadata(state,state.revision===1?'start':'result')}}}}))
  }
  async apply(request:ActivityRequest):Promise<boolean> {
    const store=new WorldStore(this.worldPath),leases=new WriterLeaseService(this.worldPath),owner='activity:'+request.requestId
    const availability=new CharacterRuntimeAvailabilityService(this.worldPath)
    let lease:ReturnType<WriterLeaseService['acquire']>|undefined
    try{
      lease=leases.acquire(this.address,owner,180000)
      const head=store.head(this.address),events=store.readEvents(this.address),current=this.state(events)
      const input={...request,actorId:this.playerId}
      const prior=events.findLast(e=>e.eventType==='activity.updated'&&object(e.data).requestId===request.requestId)
      if(prior){
        if(json(object(object(prior.data).input))!==json(input))throw new TypeError('同一请求 ID 不能改变内容')
        return false
      }
      const actionId=owner+':action'
      let state:ActivityState,description:string,drafts:WorldEventDraft[],observerIds:string[]
      if(request.operation==='start'){
        if(current?.game.active || request.activityId!==null || request.revision!==0)throw new TypeError('已有活动或开始请求失效')
        if(Object.keys(request.parameters).length)throw new TypeError('开始操作没有参数')
        const manifest=store.readManifest(this.address)!.manifest as CompiledWorldManifest
        if(this.npcIds.some(id=>!manifest.characters.some(c=>c.characterId===id) || manifest.playerBindings.some(b=>b.characterId===id)))throw new TypeError('活动 NPC 未声明')
        const scene=new SceneDecisionService(store,availability,2).decideFromEvents(this.address,brandId(this.playerId,'CharacterId'),events,head.headSeq)
        if(this.npcIds.some(id=>!scene.observerIds.includes(brandId(id,'CharacterId'))))throw new TypeError('需要与游戏参与者在同一场景')
        const participants=[this.playerId,...this.npcIds]
        state={id:'activity:'+randomUUID(),revision:1,participants,game:this.#game(this.#call('initialize',[{
          playerId:this.playerId,npcIds:this.npcIds}]),participants)}
        description=this.title+'开始。';observerIds=participants
        drafts=[this.#event(state,description,this.playerId,actionId,'start')]
      }else{
        this.#check(current,request.activityId,request.revision,this.playerId)
        if(request.operation==='retry'){if(Object.keys(request.parameters).length)throw new TypeError('重试没有参数');return true}
        if(!this.#validators.get(request.operation)?.(request.parameters))throw new TypeError('游戏操作参数无效')
        const manifest=store.readManifest(this.address)!
        const rules=this.rulebooks().resolve('builtin:speak-move',2,owner,this.address)
        const resolution=rules.resolve({manifest:manifest.manifest as CompiledWorldManifest,manifestHash:manifest.manifestHash,
          events,characterId:this.playerId,actionId,asOfWorldSeq:head.headSeq,
          resolutionAuthority:resolutionAuthority('player','standard'),action:{actionType:'interact',parameters:{
            targetRef:{kind:'character',id:this.playerId},bindingId:current.id,
            definitionRef:{id:'activity:'+request.operation,version:1},
            arguments:{activityId:current.id,revision:current.revision,...request.parameters}}}})
        observerIds=[...(resolution.observationScope?.recipientIds ?? current.participants)]
        drafts=[...resolution.events];state=object(drafts[0]!.data).state as ActivityState
        description=String(object(drafts[0]!.data).description)
      }
      drafts[0]={...drafts[0]!,data:{...object(drafts[0]!.data),requestId:request.requestId,input}}
      drafts.push(...this.#observations(state,description,this.playerId,actionId,observerIds),
        {eventType:'action.resolved',eventVersion:1,data:{actorId:this.playerId,actionId,actionType:'interact',accepted:true,sourceRole:'player'}},
        {eventType:'world.tick-advanced',eventVersion:1,data:{tick:head.tick+1}})
      await store.commitRound({address:this.address,transactionId:brandId(owner,'TransactionId'),roundId:brandId(owner,'InteractionRoundId'),
        expectedHeadSeq:head.headSeq,expectedTick:head.tick,nextTick:head.tick+1,events:drafts,outbox:[],
        writerFencingToken:lease.fencingToken,correlationId:owner,authority:{actorId:this.playerId,request:input,status:'accepted'}})
      return true
    }finally{if(lease)leases.release(this.address,owner,lease.fencingToken);availability.close();leases.close();store.close()}
  }
  /** Host override: deliberately never invokes creator policy, resolve, schedule or onOutcome. */
  async escape():Promise<void> {
    const store=new WorldStore(this.worldPath),leases=new WriterLeaseService(this.worldPath),owner='escape:'+randomUUID()
    let lease:ReturnType<WriterLeaseService['acquire']>|undefined
    try{
      lease=leases.acquire(this.address,owner,180000)
      const head=store.head(this.address),state=this.state(store.readEvents(this.address))
      if(!state?.game.active)return
      const next={...state,revision:state.revision+1,game:{...state.game,active:false,phase:'host-aborted',turn:null}}
      const description='玩家使用宿主逃生按钮中止活动，已解除本活动的交互限制与调度。'
      await store.commitRound({address:this.address,transactionId:brandId(owner,'TransactionId'),roundId:brandId(owner,'InteractionRoundId'),
        expectedHeadSeq:head.headSeq,expectedTick:head.tick,nextTick:head.tick+1,
        events:[this.#event(next,description,this.playerId,owner,'host-escape'),...this.#observations(next,description,this.playerId,owner),
          {eventType:'world.tick-advanced',eventVersion:1,data:{tick:head.tick+1}}],
        outbox:[],writerFencingToken:lease.fencingToken,correlationId:owner,authority:{actorId:this.playerId,source:'host-escape',status:'accepted'}})
    }finally{if(lease)leases.release(this.address,owner,lease.fencingToken);leases.close();store.close()}
  }
  async speak(text:string,requestId:string):Promise<void> {
    return this.worldAction({actionType:'speak',parameters:{text,scope:'direct',addresseeIds:this.npcIds}},requestId)
  }
  async worldAction(action:{actionType:string;parameters:WorldJsonObject},requestId:string):Promise<void> {
    const store=new WorldStore(this.worldPath),leases=new WriterLeaseService(this.worldPath),owner='activity-world:'+requestId
    const availability=new CharacterRuntimeAvailabilityService(this.worldPath)
    let lease:ReturnType<WriterLeaseService['acquire']>|undefined
    try{
      lease=leases.acquire(this.address,owner,180000)
      const head=store.head(this.address),events=store.readEvents(this.address),state=this.state(events)
      if(!state?.game.active)throw new TypeError('活动已结束')
      const prior=store.committedRound(this.address,brandId(owner,'TransactionId'))
      if(prior){
        const record=store.readRoundAuthority(this.address,brandId(owner,'TransactionId'))!
        if(json(object(record.authority.action))!==json(action))throw new TypeError('同一请求不能改变内容')
        return
      }
      if(action.actionType==='speak'){
        const policy=this.policy(state,this.playerId)
        this.checkExpression(policy,{...(Object.hasOwn(action.parameters,'text')?{speech:action.parameters.text}:{}),
          ...(Object.hasOwn(action.parameters,'narration')?{narration:action.parameters.narration}:{})})
      }
      const manifest=store.readManifest(this.address)!,rules=this.rulebooks().resolve('builtin:speak-move',2,owner,this.address)
      const result=rules.resolve({manifest:manifest.manifest as CompiledWorldManifest,manifestHash:manifest.manifestHash,
        events,characterId:this.playerId,actionId:owner,asOfWorldSeq:head.headSeq,
        resolutionAuthority:resolutionAuthority('player','standard'),action})
      if(result.status!=='accepted')throw new TypeError('这次操作未被规则接受')
      const scene=new SceneDecisionService(store,availability,2)
      const drafts:WorldEventDraft[]=[...result.events]
      if(action.actionType==='move')drafts.push(...scene.transitionForMove(this.address,events,brandId(this.playerId,'CharacterId'),String(action.parameters.locationId),head.headSeq))
      const scope=result.observationScope
      const audience=scene.audienceForAction(this.address,brandId(this.playerId,'CharacterId'),events,head.headSeq,
        {scope:scope?.scope ?? 'scene_public',...(scope?.recipientIds===undefined?{}:{recipientIds:scope.recipientIds.map(id=>brandId(id,'CharacterId'))})})
      const speech=result.events.find(e=>e.eventType==='character.speak')
      const description=this.executionResult({manifest:manifest.manifest as CompiledWorldManifest,events:[...events,...result.events],
        actorId:brandId(this.playerId,'CharacterId'),action,status:result.status,reason:null}).description
      for(const observerId of new Set([...audience.fullContentCharacterIds,this.playerId])){
        drafts.push({eventType:'observation.upsert',eventVersion:1,data:{id:owner+':'+observerId,value:{observerId,
          content:{actorId:this.playerId,status:'accepted',actionType:action.actionType,resultDescription:description!,
            ...(speech===undefined?{}:{speech:speech.data})}}}})
      }
      drafts.push({eventType:'action.resolved',eventVersion:1,data:{actorId:this.playerId,actionId:owner,actionType:action.actionType,accepted:true,sourceRole:'player'}},
        {eventType:'world.tick-advanced',eventVersion:1,data:{tick:head.tick+1}})
      await store.commitRound({address:this.address,transactionId:brandId(owner,'TransactionId'),roundId:brandId(owner,'InteractionRoundId'),
        expectedHeadSeq:head.headSeq,expectedTick:head.tick,nextTick:head.tick+1,events:drafts,outbox:[],
        writerFencingToken:lease.fencingToken,correlationId:owner,authority:{actorId:this.playerId,action,status:'accepted'}})
    }finally{if(lease)leases.release(this.address,owner,lease.fencingToken);availability.close();leases.close();store.close()}
  }
}
