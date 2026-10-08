import { createHash } from 'node:crypto'
import type { PlaytestState, PlaytestAction, PlaytestRuntime } from '../../../tests/experiments/playtest-server.ts'
import { canonicalizeWorldJson, type WorldJsonObject } from '@harness-world/contracts'

export interface PlayerView {
  game: { title: string }
  player: { name: string }
  scene: { locationName: string; visibleCharacters: string[] } | null
  status: 'ready' | 'busy' | 'paused' | 'error'
  tailRound?: PlaytestState['tailRound']
  history: { seq: number; speaker: string; text: string; player: boolean; segments?: readonly import('@harness-world/contracts').ExpressionSegment[] }[]
  actions: { id: string; label: string; action: PlaytestAction }[]
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
      if (typeof definition.id !== 'string' || definition.id.startsWith('activity:')) continue
      const target = option.targetRef as WorldJsonObject
      const action: PlaytestAction = { actionType: 'interact', parameters: {
        targetRef: structuredClone(option.targetRef), definitionRef: structuredClone(option.definitionRef),
        bindingId: option.bindingId, arguments: structuredClone(option.arguments ?? {}) } }
      const args = action.parameters.arguments as WorldJsonObject
      const targetName = state.actionNames?.[String(target.id)] ?? String(target.id)
      const recipient = typeof args.recipientId === 'string' ? state.actionNames?.[args.recipientId] ?? args.recipientId : undefined
      const verbs: Record<string, string> = { 'base:take': '拿取', 'base:drop': '放下' }
      const label = definition.id === 'base:give' && recipient !== undefined
        ? '把 ' + targetName + ' 交给 ' + recipient
        : (verbs[String(definition.id)] ?? String(definition.id)) + ' · ' + targetName
      actions.push({ id: 'opt:' + createHash('sha256').update(canonicalizeWorldJson(action as unknown as WorldJsonObject)).digest('hex'), label, action })
    }
  }
  return {
    game: { title: state.world.title }, player: { name: state.world.playerName },
    scene: state.world.currentScene ? { locationName: state.world.currentScene.locationName,
      visibleCharacters: [...state.world.currentScene.presentNpcNames] } : null,
    status: state.busy ? 'busy' : state.error ? 'error' : state.paused ? 'paused' : 'ready',
    ...(state.tailRound ? {tailRound: state.tailRound} : {}),
    history: state.transcript.map(line => ({ seq: line.seq, speaker: line.speaker, text: line.text, player: line.player, ...(line.segments === undefined ? {} : { segments: line.segments }) })),
    actions,
  }
}
export function playerViewPatch(before: PlayerView, after: PlayerView): Record<string, unknown> | null {
  const changes: Record<string, unknown> = {}
  for (const key of ['game', 'player', 'scene', 'status', 'actions', 'tailRound'] as const) {
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
export function frontendActionRequest(value: unknown): FrontendActionRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('前端请求无效')
  const r = value as Record<string, unknown>
  if (Object.keys(r).sort().join(',') !== 'actionId,operation,payload,requestId'
    || typeof r.requestId !== 'string' || !/^[a-zA-Z0-9:-]{1,100}$/.test(r.requestId)
    || typeof r.actionId !== 'string' || !/^[a-zA-Z0-9:-]{1,100}$/.test(r.actionId)
    || !['speak', 'perform', 'regenerate', 'selectCandidate', 'cancelRegeneration'].includes(String(r.operation))
    || !r.payload || typeof r.payload !== 'object' || Array.isArray(r.payload)) throw new TypeError('前端请求字段无效')
  const payload = r.payload as Record<string, unknown>
  if (r.operation === 'speak') {
    const keys = Object.keys(payload).sort().join(',')
    if (!['text', 'narration,text'].includes(keys) || typeof payload.text !== 'string'
      || (Object.hasOwn(payload, 'narration') && typeof payload.narration !== 'string')) throw new TypeError('发言只接受 text 和可选 narration')
    const text = payload.text.replace(/\r\n?/gu, '\n').trim()
    const narration = typeof payload.narration === 'string' ? payload.narration.replace(/\r\n?/gu, '\n').trim() : undefined
    if (!(text || narration) || text.length + (narration?.length ?? 0) > 2000) throw new RangeError('发言与描写合计需为 1 至 2000 个字符')
    return { requestId: r.requestId, actionId: r.actionId, operation: 'speak', payload: { text, ...(narration === undefined ? {} : { narration }) } }
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
  if (Object.keys(payload).join(',') !== 'optionId' || typeof payload.optionId !== 'string' || payload.optionId.length > 512) throw new TypeError('行动须引用玩家当前可用的 optionId')
  return { requestId: r.requestId, actionId: r.actionId, operation: 'perform', payload: { optionId: payload.optionId } }
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
        const text = Object.hasOwn(request.payload, 'narration')
          ? '/act speak ' + JSON.stringify({ text: request.payload.text, narration: request.payload.narration })
          : request.payload.text as string
        return projectPlayerView(await this.runtime.submit(text))
      }
      const view = projectPlayerView(await this.runtime.state())
      const option = view.actions.find(a => a.id === request.payload.optionId)
      if (!option || !this.runtime.perform) throw new TypeError('该操作不在玩家当前可用操作中')
      return projectPlayerView(await this.runtime.perform(option.action))
    })
    this.#requests.set(request.actionId, { fingerprint, result })
    return result
  }
}
