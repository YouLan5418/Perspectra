import { createHash } from 'node:crypto'
import type { PlaytestState, PlaytestAction, PlaytestRuntime } from '../../../tests/experiments/playtest-server.ts'
import { canonicalizeWorldJson, type WorldJsonObject } from '@harness-world/contracts'

export interface PlayerView {
  game: { title: string }
  player: { name: string }
  scene: { locationName: string; visibleCharacters: string[]; recipients: { id: string; name: string }[] } | null
  activity?: { title: string; active: boolean; phase: string; public: WorldJsonObject }
  activities?: { key: string; title: string; active: boolean; suspended: boolean; phase: string; public: WorldJsonObject }[]
  status: 'ready' | 'busy' | 'paused' | 'error'
  feedback?: { phase: string; message: string }
  settings?: PlaytestState['playerSettings']
  tailRound?: PlaytestState['tailRound']
  history: { seq: number; speaker: string; text: string; player: boolean; segments?: readonly import('@harness-world/contracts').ExpressionSegment[] }[]
  actions: { id: string; label: string; action: PlaytestAction; participantSelection?: { min: number; max: number; candidates: { id: string; name: string }[] } }[]
}
export function projectPlayerView(state: PlaytestState): PlayerView {
  const actions: PlayerView['actions'] = []
  for (const affordance of state.availableActions ?? []) {
    if (affordance.actionType === 'move') for (const destination of affordance.destinations ?? []) {
      actions.push({ id: 'move:' + destination.locationId, label: '前往 ' + destination.name,
        action: { actionType: 'move', parameters: { locationId: destination.locationId } } })
    }
    if (affordance.actionType === 'interact') for (const option of affordance.interactions ?? []) {
      if (!option.targetRef || !option.definitionRef || typeof option.bindingId !== 'string') continue
      const definition = option.definitionRef as WorldJsonObject
      if (typeof definition.id !== 'string') continue
      if(definition.id.startsWith('activity:')){
        const schema=option.argumentSchema as WorldJsonObject|undefined
        const properties=schema?.properties as WorldJsonObject|undefined
        if(!properties || Object.keys(properties).some(key=>key!=='activityId'&&key!=='revision'))continue
      }
      const target = option.targetRef as WorldJsonObject
      const action: PlaytestAction = { actionType: 'interact', parameters: {
        targetRef: structuredClone(option.targetRef), definitionRef: structuredClone(option.definitionRef),
        bindingId: option.bindingId, arguments: structuredClone(option.arguments ?? {}) } }
      const args = action.parameters.arguments as WorldJsonObject
      const targetName = state.actionNames?.[String(target.id)] ?? String(target.id)
      const recipient = typeof args.recipientId === 'string' ? state.actionNames?.[args.recipientId] ?? args.recipientId : undefined
      const verbs: Record<string, string> = { 'base:take': '拿取', 'base:drop': '放下', 'home:cook-rice': '煮白米饭', 'home:eat-rice': '吃完这锅饭' }
      const label = definition.id.startsWith('activity:') ? String(option.label??definition.id) : definition.id === 'base:give' && recipient !== undefined
        ? '把 ' + targetName + ' 交给 ' + recipient
        : (verbs[String(definition.id)] ?? String(definition.id)) + ' · ' + targetName
      actions.push({ id: 'opt:' + createHash('sha256').update(canonicalizeWorldJson(action as unknown as WorldJsonObject)).digest('hex'), label, action })
    }
  }
  const activities=state.activities??(state.activity?[state.activity]:[])
  const foreground=activities.some(activity=>(activity.game as WorldJsonObject|undefined)?.active===true)
  for(const activity of activities){
    const active=(activity.game as WorldJsonObject|undefined)?.active===true
    if(!active&&foreground)continue
    const operation=active?'suspend':activity.suspended===true?'resume':'start'
    const action:PlaytestAction={actionType:'interact',parameters:{definitionRef:{id:'host:activity-'+operation,version:1},
      ...(activity.activityKey===undefined?{}:{activityKey:activity.activityKey}),previousId:activity.id??null,previousRevision:activity.revision??0}}
    const selection=operation==='start'?activity.participantSelection as WorldJsonObject|undefined:undefined
    actions.push({id:'opt:'+createHash('sha256').update(canonicalizeWorldJson(action as unknown as WorldJsonObject)).digest('hex'),label:({suspend:'暂停 ',resume:'继续 ',start:'开始 '}[operation])+activity.title,action,
      ...(selection?{participantSelection:structuredClone(selection) as unknown as NonNullable<PlayerView['actions'][number]['participantSelection']>}: {})})
    if(activity.suspended===true){
      const abandon:PlaytestAction={...action,parameters:{...action.parameters,definitionRef:{id:'host:activity-abandon',version:1}}}
      actions.push({id:'opt:'+createHash('sha256').update(canonicalizeWorldJson(abandon as unknown as WorldJsonObject)).digest('hex'),label:'放弃 '+activity.title,action:abandon})
    }
  }
  const activityGame=state.activity?.game as WorldJsonObject|undefined
  if(activityGame?.active && activityGame.turn!==(state.activity!.participants as string[])[0]){
    const action:PlaytestAction={actionType:'interact',parameters:{definitionRef:{id:'host:activity-retry',version:1},previousId:state.activity!.id!,previousRevision:state.activity!.revision!}}
    actions.push({id:'opt:'+createHash('sha256').update(canonicalizeWorldJson(action as unknown as WorldJsonObject)).digest('hex'),label:'再次请求角色处理',action})
  }
  return {
    ...(state.activity?{activity:{title:String(state.activity.title),active:activityGame?.active===true,phase:String(activityGame?.phase??'not-started'),public:structuredClone(activityGame?.public??{}) as WorldJsonObject}}:{}),
    ...(state.activities?{activities:state.activities.map(activity=>{
      const game=activity.game as WorldJsonObject|undefined
      return {key:String(activity.activityKey),title:String(activity.title),active:game?.active===true,suspended:activity.suspended===true,
        phase:String(game?.phase??'not-started'),public:structuredClone(game?.public??{}) as WorldJsonObject}
    })}:{}),
    game: { title: state.world.title }, player: { name: state.world.playerName },
    scene: state.world.currentScene ? { locationName: state.world.currentScene.locationName,
      visibleCharacters: [...state.world.currentScene.presentNpcNames], recipients: (state.world.currentScene.recipients ?? []).map(({ id, name }) => ({ id, name })) } : null,
    ...(state.playerFeedback ? { feedback: structuredClone(state.playerFeedback) } : {}),
    status: state.busy ? 'busy' : state.error ? 'error' : state.paused ? 'paused' : 'ready',
    ...(state.playerSettings?{settings:{inputCharacters:state.playerSettings.inputCharacters,reading:{fontSize:state.playerSettings.reading.fontSize,lineHeight:state.playerSettings.reading.lineHeight,autoFollow:state.playerSettings.reading.autoFollow}}}:{}),
    ...(state.tailRound ? {tailRound: state.tailRound} : {}),
    history: state.transcript.map(line => ({ seq: line.seq, speaker: line.speaker, text: line.text, player: line.player, ...(line.segments === undefined ? {} : { segments: line.segments }) })),
    actions,
  }
}
export function playerViewPatch(before: PlayerView, after: PlayerView): Record<string, unknown> | null {
  const changes: Record<string, unknown> = {}
  for (const key of ['game', 'player', 'scene', 'status', 'actions', 'tailRound', 'settings', 'activity', 'activities', 'feedback'] as const) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) changes[key] = after[key]
  }
  if (JSON.stringify(before.history) !== JSON.stringify(after.history)) {
    const prefix = before.history.length <= after.history.length
      && before.history.every((line, i) => JSON.stringify(line) === JSON.stringify(after.history[i]))
    if (prefix) changes.historyAppend = after.history.slice(before.history.length)
    else changes.history = after.history
  }
  return Object.keys(changes).length ? changes : null
}
export interface FrontendActionRequest { requestId: string; actionId: string; operation: 'speak' | 'perform' | 'regenerate' | 'selectCandidate' | 'cancelRegeneration'; payload: Record<string, unknown> }
export function frontendActionRequest(value: unknown, maximumCharacters = 2000): FrontendActionRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('前端请求无效')
  const r = value as Record<string, unknown>
  if (Object.keys(r).sort().join(',') !== 'actionId,operation,payload,requestId'
    || typeof r.requestId !== 'string' || !/^[a-zA-Z0-9:-]{1,100}$/.test(r.requestId)
    || typeof r.actionId !== 'string' || !/^[a-zA-Z0-9:-]{1,100}$/.test(r.actionId)
    || !['speak', 'perform', 'regenerate', 'selectCandidate', 'cancelRegeneration'].includes(String(r.operation))
    || !r.payload || typeof r.payload !== 'object' || Array.isArray(r.payload)) throw new TypeError('前端请求字段无效')
  const payload = r.payload as Record<string, unknown>
  if (r.operation === 'speak') {
    if (Object.keys(payload).some(key => !['text', 'narration', 'scope', 'addresseeIds'].includes(key)) || typeof payload.text !== 'string'
      || (Object.hasOwn(payload, 'narration') && typeof payload.narration !== 'string')) throw new TypeError('发言字段无效')
    const scope = payload.scope ?? 'scene_public'
    const recipients = payload.addresseeIds ?? []
    if (typeof scope !== 'string' || !['scene_public', 'direct', 'private', 'self'].includes(scope)
      || !Array.isArray(recipients) || recipients.some(id => typeof id !== 'string' || !id || id.length > 200)
      || recipients.length > 64 || new Set(recipients).size !== recipients.length
      || ((scope === 'direct' || scope === 'private') ? recipients.length === 0 : recipients.length !== 0)) throw new TypeError('发言范围与接收对象不匹配')
    const text = payload.text.replace(/\r\n?/gu, '\n').trim()
    const narration = typeof payload.narration === 'string' ? payload.narration.replace(/\r\n?/gu, '\n').trim() : undefined
    if (!(text || narration) || text.length + (narration?.length ?? 0) > maximumCharacters) throw new RangeError(`发言与描写合计需为 1 至 ${maximumCharacters} 个字符`)
    return { requestId: r.requestId, actionId: r.actionId, operation: 'speak', payload: { text, ...(narration === undefined ? {} : { narration }), ...(Object.hasOwn(payload, 'scope') || Object.hasOwn(payload, 'addresseeIds') ? { scope, addresseeIds: recipients } : {}) } }
  }
  if (r.operation === 'cancelRegeneration') {
    if (Object.keys(payload).length) throw new TypeError('取消不接受额外参数')
    return {requestId:r.requestId,actionId:r.actionId,operation:'cancelRegeneration',payload:{}}
  }
  if (r.operation === 'selectCandidate') {
    if (Object.keys(payload).sort().join(',') !== 'candidateId,tailId' || ![payload.tailId,payload.candidateId].every(id => typeof id === 'string' && /^[a-f0-9-]{36}$/.test(id))) throw new TypeError('候选切换须引用当前回合和候选')
    return {requestId:r.requestId,actionId:r.actionId,operation:'selectCandidate',payload:{tailId:payload.tailId,candidateId:payload.candidateId}}
  }
  if (r.operation === 'regenerate') {
    if (Object.keys(payload).join(',') !== 'tailId' || typeof payload.tailId !== 'string' || !/^[a-f0-9-]{36}$/.test(payload.tailId)) throw new TypeError('重新生成须引用当前末端回合')
    return {requestId:r.requestId,actionId:r.actionId,operation:'regenerate',payload:{tailId:payload.tailId}}
  }
  if (Object.keys(payload).some(key=>!['optionId','npcIds'].includes(key)) || typeof payload.optionId !== 'string' || payload.optionId.length > 512) throw new TypeError('行动须引用玩家当前可用的 optionId')
  if(Object.hasOwn(payload,'npcIds')&&(!Array.isArray(payload.npcIds)||payload.npcIds.length>8||payload.npcIds.some(id=>typeof id!=='string'||!id||id.length>200)||new Set(payload.npcIds).size!==payload.npcIds.length))throw new TypeError('活动参与者选择无效')
  return { requestId: r.requestId, actionId: r.actionId, operation: 'perform', payload: { optionId: payload.optionId,...(Object.hasOwn(payload,'npcIds')?{npcIds:payload.npcIds}:{}) } }
}
/** Per-running-session deduplication, including in-flight and failed results. Never evicts IDs. */
export class FrontendActions {
  #requests = new Map<string, { fingerprint: string; result: Promise<PlayerView> }>()
  constructor(readonly runtime: PlaytestRuntime) {}
  perform(request: FrontendActionRequest): Promise<PlayerView> {
    const fingerprint = Buffer.from(canonicalizeWorldJson({ operation: request.operation, payload: request.payload as WorldJsonObject })).toString('utf8')
    const previous = this.#requests.get(request.actionId)
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new TypeError('同一 actionId 不能对应不同操作')
      return previous.result.then(async () => projectPlayerView(await this.runtime.state()))
    }
    if (this.#requests.size >= 4096) throw new RangeError('本会话操作数量达到实验上限，请保存后重新启动')
    const result = Promise.resolve().then(async () => {
      if (request.operation === 'cancelRegeneration') {
        if (!this.runtime.cancelRegeneration) throw new TypeError('取消不可用')
        return projectPlayerView(await this.runtime.cancelRegeneration())
      }
      if (request.operation === 'selectCandidate') {
        if (!this.runtime.selectCandidate) throw new TypeError('候选切换不可用')
        return projectPlayerView(await this.runtime.selectCandidate(request.payload.tailId as string,request.payload.candidateId as string,request.actionId))
      }
      if (request.operation === 'regenerate') {
        if (!this.runtime.regenerate) throw new TypeError('重新生成不可用')
        return projectPlayerView(await this.runtime.regenerate(request.payload.tailId as string,request.actionId))
      }
      if (request.operation === 'speak') {
        const recipients = request.payload.addresseeIds as string[] | undefined
        if (recipients?.length) {
          const visible = projectPlayerView(await this.runtime.state()).scene?.recipients ?? []
          if (recipients.some(id => !visible.some(character => character.id === id))) throw new TypeError('接收对象已不在当前可见场景，请重新选择')
        }
        const text = Object.hasOwn(request.payload, 'narration') || Object.hasOwn(request.payload, 'scope')
          ? '/act speak ' + JSON.stringify(request.payload)
          : request.payload.text as string
        return projectPlayerView(await this.runtime.submit(text))
      }
      const view = projectPlayerView(await this.runtime.state())
      const option = view.actions.find(a => a.id === request.payload.optionId)
      if (!option || !this.runtime.perform) throw new TypeError('该操作不在玩家当前可用操作中')
      const selected=request.payload.npcIds as string[]|undefined,selection=option.participantSelection
      if(selection){
        if(!selected||selected.length<selection.min||selected.length>selection.max||selected.some(id=>!selection.candidates.some(candidate=>candidate.id===id)))throw new TypeError('请选择当前可用的活动参与者')
      }else if(selected!==undefined)throw new TypeError('此操作不接受参与者选择')
      const action=selection?{...option.action,parameters:{...option.action.parameters,startParameters:{npcIds:selected!}}}:option.action
      return projectPlayerView(await this.runtime.perform(action))
    })
    this.#requests.set(request.actionId, { fingerprint, result })
    return result
  }
}
