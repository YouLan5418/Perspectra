import { createHash } from 'node:crypto'
import { canonicalizeWorldJson, type WorldJsonObject } from '@harness-world/contracts'
import type { PlayerView, FrontendActionRequest } from '@harness-world/frontend'
import type { HostState, HostAction, HostRuntime } from './http-server.ts'

export function projectPlayerView(state: HostState): PlayerView {
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
      // Like activity operations, a status operation that needs player-supplied arguments is not a one-click option.
      if(definition.id.startsWith('status:')){
        const properties=(option.argumentSchema as WorldJsonObject|undefined)?.properties as WorldJsonObject|undefined
        if(properties&&Object.keys(properties).length)continue
      }
      const target = option.targetRef as WorldJsonObject
      const action: HostAction = { actionType: 'interact', parameters: {
        targetRef: structuredClone(option.targetRef), definitionRef: structuredClone(option.definitionRef),
        bindingId: option.bindingId, arguments: structuredClone(option.arguments ?? {}) } }
      const args = action.parameters.arguments as WorldJsonObject
      const targetName = state.actionNames?.[String(target.id)] ?? String(target.id)
      const recipient = typeof args.recipientId === 'string' ? state.actionNames?.[args.recipientId] ?? args.recipientId : undefined
      const verbs: Record<string, string> = { 'base:take': '拿取', 'base:drop': '放下', 'home:cook-rice': '煮白米饭', 'home:eat-rice': '吃完这锅饭',
        'dinner:repair': '修理', 'dinner:cook-cold': '做一桌凉拌冷盘', 'dinner:cook-home': '开火做家常菜', 'dinner:cook-feast': '用蒸馏器熬高汤做大餐' }
      const label = definition.id.startsWith('activity:') || definition.id.startsWith('status:') ? String(option.label??definition.id) : definition.id === 'base:give' && recipient !== undefined
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
    const quick=!active&&activity.suspended!==true&&Array.isArray(activity.quickOperations)?activity.quickOperations as WorldJsonObject[]:[]
    if(quick.length){
      // One-click operations replace the start entry; the host starts and applies them in one player action.
      for(const option of quick){
        const action:HostAction={actionType:'interact',parameters:{definitionRef:{id:'host:activity-quick',version:1},
          activityKey:String(activity.activityKey),operation:String(option.id)}}
        actions.push({id:'opt:'+createHash('sha256').update(canonicalizeWorldJson(action as unknown as WorldJsonObject)).digest('hex'),label:String(option.label),action})
      }
      continue
    }
    const operation=active?'suspend':activity.suspended===true?'resume':'start'
    const action:HostAction={actionType:'interact',parameters:{definitionRef:{id:'host:activity-'+operation,version:1},
      ...(activity.activityKey===undefined?{}:{activityKey:activity.activityKey}),previousId:activity.id??null,previousRevision:activity.revision??0}}
    const selection=operation==='start'?activity.participantSelection as WorldJsonObject|undefined:undefined
    actions.push({id:'opt:'+createHash('sha256').update(canonicalizeWorldJson(action as unknown as WorldJsonObject)).digest('hex'),label:({suspend:'暂停 ',resume:'继续 ',start:'开始 '}[operation])+activity.title,action,
      ...(selection?{participantSelection:structuredClone(selection) as unknown as NonNullable<PlayerView['actions'][number]['participantSelection']>}: {})})
    if(activity.suspended===true){
      const abandon:HostAction={...action,parameters:{...action.parameters,definitionRef:{id:'host:activity-abandon',version:1}}}
      actions.push({id:'opt:'+createHash('sha256').update(canonicalizeWorldJson(abandon as unknown as WorldJsonObject)).digest('hex'),label:'放弃 '+activity.title,action:abandon})
    }
  }
  const background = state.busy && state.background === true
  const activityGame=state.activity?.game as WorldJsonObject|undefined
  const expressionPolicy = activityGame?.active ? state.activity?.policy as WorldJsonObject | undefined : undefined
  if(activityGame?.active && activityGame.turn!==(state.activity!.participants as string[])[0]){
    const action:HostAction={actionType:'interact',parameters:{definitionRef:{id:'host:activity-retry',version:1},previousId:state.activity!.id!,previousRevision:state.activity!.revision!}}
    actions.push({id:'opt:'+createHash('sha256').update(canonicalizeWorldJson(action as unknown as WorldJsonObject)).digest('hex'),label:'再次请求角色处理',action})
  }
  return {
    expression: { speech: expressionPolicy?.speech === 'none' ? 'none' : expressionPolicy?.speech === 'choices' ? 'choices' : 'free',
      speechChoices: Array.isArray(expressionPolicy?.speechChoices) ? expressionPolicy.speechChoices.filter((value): value is string => typeof value === 'string') : [],
      narration: expressionPolicy?.narration !== false },
    ...(state.activity?{activity:{title:String(state.activity.title),active:activityGame?.active===true,phase:String(activityGame?.phase??'not-started'),public:structuredClone(activityGame?.public??{}) as WorldJsonObject}}:{}),
    ...(state.activities?{activities:state.activities.map(activity=>{
      const game=activity.game as WorldJsonObject|undefined
      return {key:String(activity.activityKey),title:String(activity.title),active:game?.active===true,suspended:activity.suspended===true,
        phase:String(game?.phase??'not-started'),public:structuredClone(game?.public??{}) as WorldJsonObject}
    })}:{}),
    game: { title: state.world.title }, player: { name: state.world.playerName },
    scene: state.world.currentScene ? { locationName: state.world.currentScene.locationName,
      visibleCharacters: [...state.world.currentScene.presentNpcNames], recipients: (state.world.currentScene.recipients ?? []).map(({ id, name }) => ({ id, name })) } : null,
    // Off-scene work stays invisible: the player sees an idle scene and acting cancels that work.
    ...(state.playerFeedback ? { feedback: background ? { phase: '可以输入', message: state.playerFeedback.message } : structuredClone(state.playerFeedback) } : {}),
    status: state.busy && !background ? 'busy' : state.error ? 'error' : state.paused ? 'paused' : 'ready',
    ...(state.canInterrupt===undefined||background?{}:{canInterrupt:state.canInterrupt}),
    ...(state.busy && !background && state.responders?.length ? { responders: [...state.responders] } : {}),
    ...(state.playerSettings?{settings:{inputCharacters:state.playerSettings.inputCharacters,reading:{fontSize:state.playerSettings.reading.fontSize,lineHeight:state.playerSettings.reading.lineHeight,autoFollow:state.playerSettings.reading.autoFollow},
      ...(state.playerSettings.audio?{audio:{volume:state.playerSettings.audio.volume,muted:state.playerSettings.audio.muted,voiceEnabled:state.playerSettings.audio.voiceEnabled}}:{}),
      ...(state.playerSettings.palette?{palette:state.playerSettings.palette}:{})}}:{}),
    ...(state.tailRound ? {tailRound: state.tailRound} : {}),
    ...(state.statusBar ? { statusBar: state.statusBar.map(({ key, label, holderId, holderName, self, value, current }) =>
      ({ key, label, holderId, ...(holderName === undefined ? {} : { holderName }), ...(self === true ? { self } : {}), value, current })) } : {}),
    ...(state.statusTruth?.length ? { statusTruth: state.statusTruth.map(({ key, label, holderId, holderName, self, value }) =>
      ({ key, label, holderId, ...(holderName === undefined ? {} : { holderName }), ...(self === true ? { self } : {}), value })) } : {}),
    history: state.transcript.map(line => ({ seq: line.seq, speaker: line.speaker, ...(line.speakerId === undefined ? {} : {speakerId:line.speakerId}), text: line.text, player: line.player, ...(line.segments === undefined ? {} : { segments: line.segments }) })),
    actions,
  }
}
/** Per-running-session deduplication, including in-flight and failed results. Never evicts IDs. */
export class FrontendActions {
  #requests = new Map<string, { fingerprint: string; result: Promise<PlayerView> }>()
  constructor(readonly runtime: HostRuntime) {}
  perform(request: FrontendActionRequest): Promise<PlayerView> {
    const fingerprint = Buffer.from(canonicalizeWorldJson({ operation: request.operation, payload: request.payload as WorldJsonObject })).toString('utf8')
    const previous = this.#requests.get(request.actionId)
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new TypeError('同一 actionId 不能对应不同操作')
      return previous.result.then(async () => projectPlayerView(await this.runtime.state()))
    }
    if (this.#requests.size >= 4096) throw new RangeError('本会话操作数量达到上限，请保存后重新启动')
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
