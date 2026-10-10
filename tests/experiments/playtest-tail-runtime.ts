import { tailRuntimeIdentity } from '../../desktop/tail-runtime-identity.ts'
import { randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import { realpathSync } from 'node:fs'
import { assertSettled, durableJson, flushTailData, ownStoryline, readTailSelection, restoreTail, type TailRecord, type TailSelection } from '../../desktop/tail-storage.ts'
import { interactionPackageDescription, type WorldJsonObject } from '@harness-world/contracts'
import { createInstalledInteractionPackages } from '@harness-world/interactions-basic'
import { compileWorldPackSource } from '@harness-world/world-pack'
import { PlaytestBusyError, type PlaytestAction, type PlaytestState } from './playtest-server.ts'
import type { FrozenPlaytestOptions, FrozenWorldRuntimeCore } from './playtest-frozen-runtime.ts'
import type { ActivityRequest } from './pack-activity.ts'

type Factory = (options: FrozenPlaytestOptions) => Promise<FrozenWorldRuntimeCore>
// Bump when executable rules/context interpretation change incompatibly. Pack lock already covers declared script bytes.
const runtimeRevision = 'tail-round-2026-10-08/v1'
const loadedRuntimeIdentity = tailRuntimeIdentity()

/** Small session owner around the existing executor; candidate databases are never served before selection. */
export class TailRoundRuntime {
  #startingEnvironment = ''
  #runtime: FrozenWorldRuntimeCore
  #selection: TailSelection
  #busy = false
  #closed = false
  #escaping = false
  #candidate: FrozenWorldRuntimeCore | undefined
  #cancelled = false
  #regenerating = false
  #done: Promise<void> = Promise.resolve()
  #finish: (() => void) | undefined
  #notice = ''
  #closePromise: Promise<void> | undefined
  #requests = new Map<string, { tailId: string; result: Promise<PlaytestState> }>()
  protected constructor(readonly options: FrozenPlaytestOptions, readonly factory: Factory,
    runtime: FrozenWorldRuntimeCore, selection: TailSelection, readonly releaseOwner: () => void) {
    this.#runtime = runtime; this.#selection = selection
  }
  static async open(options: FrozenPlaytestOptions, factory: Factory): Promise<TailRoundRuntime> {
    const root = resolve(options.dataDirectory), release = ownStoryline(root)
    try {
      const selection = readTailSelection(root) ?? { directory: '.', version: randomUUID(), tail: null }
      const runtime = await factory({ ...options, dataDirectory: resolve(root, selection.directory), logicalDirectory: root, worldVersion: selection.version })
      const owner = new TailRoundRuntime({ ...options, dataDirectory: root }, factory, runtime, selection, release)
      try { owner.#startingEnvironment = await owner.#environment() } catch (error) { await runtime.close(); throw error }
      return owner
    } catch (error) { release(); throw error }
  }
  get address() { return this.#runtime.address }
  get dataDirectory(): string { return resolve(this.options.dataDirectory, this.#selection.directory) }
  requestInspection(enabled?: boolean) { return this.#runtime.requestInspection(enabled) }
  async state(): Promise<PlaytestState> {
    const state = await this.#runtime.state()
    return { ...state, ...(state.playerFeedback ? {playerFeedback:{phase:this.#regenerating?'正在重新生成末端回合':this.#busy&&!state.busy?'正在整理本轮进度':state.playerFeedback.phase,message:this.#notice||state.playerFeedback.message}}:{}), busy: this.#busy || state.busy, phaseLabel: this.#regenerating ? '正在重新生成末端回合' : state.phaseLabel,
      notice: this.#notice || state.notice,
      tailRound: this.#selection.tail ? { id: this.#selection.tail.id, worldVersion: this.#selection.version,
        candidateIds: this.#candidates().map(candidate => candidate.id),
        candidateIndex: this.#candidates().findIndex(candidate => candidate.id === (this.#selection.tail!.selected ?? this.#selection.tail!.id)) + 1,
        canRegenerate: !this.#busy && !this.#closed && !this.#escaping && !state.paused, regenerating: this.#regenerating } : { id: null, worldVersion: this.#selection.version, canRegenerate: false, regenerating: this.#regenerating } }
  }
  #candidates() {
    const tail = this.#selection.tail
    return tail?.candidates ?? (tail ? [{id:tail.id,directory:this.#selection.directory,headSeq:tail.headSeq,tick:tail.tick}] : [])
  }
  #begin(): void {
    if (this.#busy || this.#closed || this.#escaping) throw new PlaytestBusyError('请等待当前行动完成。')
    this.#busy = true; this.#notice = ''
    this.#done = new Promise<void>(done => { this.#finish = done })
  }
  #end(): void { this.#busy = false; this.#finish?.(); this.#finish = undefined }
  #write(selection: TailSelection): void {
    durableJson(join(this.options.dataDirectory,'current-world.json'),selection)
    this.#selection = selection
  }
  async #environment(): Promise<string> {
    const pack = await compileWorldPackSource(resolve(this.options.packPath), createInstalledInteractionPackages().map(interactionPackageDescription))
    if (pack.packHash !== this.#runtime.packHash) throw new TypeError('世界包环境已改变，请结束并重新启动。')
    if (tailRuntimeIdentity() !== loadedRuntimeIdentity) throw new TypeError('运行代码已改变，请结束并重新启动。')
    const endpoint = this.options.utilityEndpoint ? new URL(this.options.utilityEndpoint) : undefined
    if (endpoint) { endpoint.username = ''; endpoint.password = ''; endpoint.search = ''; endpoint.hash = '' }
    return JSON.stringify({ runtimeRevision, executable: loadedRuntimeIdentity, packHash: pack.packHash, assets: pack.assets,
      interaction: createInstalledInteractionPackages().map(interactionPackageDescription),
      provider: this.options.provider, protocol: this.options.protocol ?? 'openai', model: this.options.model ?? null, endpoint: endpoint?.href ?? null,
      thinkingLevel: this.options.thinkingLevel ?? null, intentModel: this.options.intentModel ?? null, preset: this.options.preset ?? {}, presetMapping: this.options.presetMapping ?? {},
      playSettings:this.options.playSettings??null, tuning: this.options.tuning ?? null, memoryCore: !!this.options.memoryCore,
      memoryContextBudget: this.options.memoryContextBudget ?? null })
  }
  async #run(input: TailRecord['input'], idempotencyKey?: string): Promise<PlaytestState> {
    this.#begin(); this.#runtime.holdCognition()
    const roundId = randomUUID(), base = randomUUID()
    try {
      if ((await this.#runtime.state()).paused) throw new PlaytestBusyError('请先恢复 NPC。')
      // The executor's loaded pack/config is immutable. Recheck disk/code only at replay boundaries.
      const environment = this.#startingEnvironment
      // Old eligibility is invalidated durably BEFORE the next world operation.
      this.#write({ ...this.#selection, tail: null })
      const before = await this.#runtime.settleRound()
      await this.#runtime.snapshotRound(join(this.options.dataDirectory,'.tail','bases',base))
      this.#runtime.beginRoundRandom()
      const result = 'text' in input ? await this.#runtime.submit(input.text, idempotencyKey) : await this.#runtime.activityAction(input.activity as ActivityRequest)
      if (result.paused || this.#escaping) return result
      const head = await this.#runtime.settleRound()
      if (head.headSeq > before.headSeq || 'activity' in input) this.#write({ ...this.#selection, tail: { id: roundId, base, input: structuredClone(input), environment,
        ...head, activityRandom: this.#runtime.roundRandom(), selected:roundId,
        candidates:[{id:roundId,directory:this.#selection.directory,...head}] } })
      return result
    } finally { this.#runtime.releaseCognition(); this.#end() }
  }
  async submit(text: string, idempotencyKey?: string): Promise<PlaytestState> {
    if (text.startsWith('/vars ')) {
      this.#begin()
      try { this.#write({ ...this.#selection, tail: null }); await this.#runtime.submit(text) } finally { this.#end() }
    } else await this.#run({ text }, idempotencyKey)
    return this.state()
  }
  async perform(action: PlaytestAction): Promise<PlaytestState> {
    if(action.actionType==='interact' && ['host:activity-start','host:activity-retry','host:activity-suspend','host:activity-resume','host:activity-abandon'].includes(String((action.parameters.definitionRef as WorldJsonObject|undefined)?.id))){
      const state=await this.state()
      const current=action.parameters.activityKey===undefined?state.activity:state.activities?.find(view=>view.activityKey===action.parameters.activityKey)
      if(!current || (current.id??null)!==action.parameters.previousId || (current.revision??0)!==action.parameters.previousRevision)
        throw new TypeError('活动入口已失效，请刷新')
      const operation=String((action.parameters.definitionRef as WorldJsonObject).id).slice('host:activity-'.length)
      if(operation!=='start'&&action.parameters.startParameters!==undefined)throw new TypeError('只有开始活动可选择参与者')
      const startParameters=action.parameters.startParameters
      if(startParameters!==undefined&&(!startParameters||typeof startParameters!=='object'||Array.isArray(startParameters)))throw new TypeError('开始参数无效')
      return this.activityAction({...(current.activityKey===undefined?{}:{activityKey:String(current.activityKey)}),activityId:operation==='start'?null:String(current.id),revision:operation==='start'?0:Number(current.revision),operation,parameters:(startParameters as WorldJsonObject|undefined)??{},requestId:randomUUID()})
    }
    return this.submit('/act '+action.actionType+' '+JSON.stringify(action.parameters))
  }
  async activityAction(activity: ActivityRequest): Promise<PlaytestState> {
    await this.#run({activity:structuredClone(activity)}); return this.state()
  }
  regenerate(tailId: string, requestId: string): Promise<PlaytestState> {
    const prior = this.#requests.get(requestId)
    if (prior) { if (prior.tailId !== tailId) throw new TypeError('同一请求不能改变目标回合。'); return prior.result.then(() => this.state()) }
    if (this.#requests.size >= 4096) throw new RangeError('本会话请求过多，请重新启动。')
    const result = this.#regenerate(tailId)
    this.#requests.set(requestId,{tailId,result})
    return result
  }
  async #regenerate(tailId: string): Promise<PlaytestState> {
    const tail = this.#selection.tail
    if (!tail || tail.id !== tailId) throw new TypeError('只能重新生成当前世界线的末端回合。')
    this.#begin(); this.#regenerating = true; this.#cancelled = false
    const previous = this.#selection, version = randomUUID(), directory = '.tail/results/'+version
    let oldClosed = false, selected = false
    this.#runtime.holdCognition()
    try {
      if ((await this.#runtime.state()).paused) throw new PlaytestBusyError('请先恢复 NPC。')
      if (this.options.publicationAudit) throw new TypeError('外部审计实验不支持隔离重新生成。')
      if (tail.environment !== await this.#environment()) throw new TypeError('世界包、脚本、规则或模型环境已改变，拒绝重新生成。')
      const head = await this.#runtime.settleRound()
      if (head.headSeq !== tail.headSeq || head.tick !== tail.tick) throw new TypeError('末端回合之后已有新的世界变化。')
      restoreTail(join(this.options.dataDirectory,'.tail','bases',tail.base),resolve(this.options.dataDirectory,directory))
      const {shadowAudit: _shadow, ...isolatedOptions} = this.options
      const candidateOptions = { ...isolatedOptions, dataDirectory: resolve(this.options.dataDirectory,directory),
        logicalDirectory: this.options.dataDirectory, worldVersion: version, storyNodes: false, memoryShadow: false }
      this.#candidate = await this.factory(candidateOptions)
      this.#candidate.holdCognition(); this.#candidate.beginRoundRandom(tail.activityRandom)
      if (this.#cancelled || this.#closed) throw new TypeError('重新生成已取消，原结果保留。')
      const result = 'text' in tail.input ? await this.#candidate.submit(tail.input.text)
        : await this.#candidate.activityAction(tail.input.activity as ActivityRequest)
      if (this.#cancelled || this.#closed) throw new TypeError('重新生成已取消，原结果保留。')
      if (result.error) throw new TypeError('候选角色处理未完成，原结果保留。')
      const end = await this.#candidate.settleRound()
      if (tail.environment !== await this.#environment()) throw new TypeError('生成期间环境已改变，原结果保留。')
      if (this.#cancelled || this.#closed) throw new TypeError('重新生成已取消，原结果保留。')
      // Close/checkpoint all candidate writers, then validate a fresh runtime before the atomic selection.
      await this.#candidate.close(); this.#candidate = undefined
      this.#candidate = await this.factory(candidateOptions)
      this.#candidate.holdCognition()
      await this.#candidate.settleRound()
      this.#candidate.validateCognition()
      assertSettled(resolve(this.options.dataDirectory,directory),this.address)
      flushTailData(resolve(this.options.dataDirectory,directory))
      if (this.#cancelled || this.#closed) throw new TypeError('重新生成已取消，原结果保留。')
      await this.#runtime.close(); oldClosed = true
      if (this.#cancelled || this.#closed) throw new TypeError('重新生成已取消，原结果保留。')
      const candidateId = randomUUID()
      this.#write({directory,version,tail:{...tail,id:candidateId,selected:candidateId,...end,
        candidates:[...this.#candidates(),{id:candidateId,directory,...end}]}})
      selected = true // no awaits between the durable commit point and installing the matching runtime
      this.#runtime = this.#candidate; this.#candidate = undefined
      this.#regenerating = false
      this.#runtime.releaseCognition()
      this.#notice = '已生成新候选，原结果仍可切换。'
    } catch (error) {
      if (!selected && oldClosed && !this.#closed) this.#runtime = await this.factory({ ...this.options,
        dataDirectory: resolve(this.options.dataDirectory,previous.directory), logicalDirectory:this.options.dataDirectory, worldVersion:previous.version })
      this.#notice = error instanceof Error ? error.message : '重新生成失败，原结果保留。'
      throw error
    } finally {
      await this.#candidate?.close(); this.#candidate = undefined
      this.#runtime.releaseCognition(); this.#regenerating = false; this.#end()
    }
    return this.state()
  }
  selectCandidate(tailId: string, candidateId: string, requestId: string): Promise<PlaytestState> {
    const fingerprint = 'select:'+tailId+':'+candidateId, prior = this.#requests.get(requestId)
    if (prior) {
      if (prior.tailId !== fingerprint) throw new TypeError('同一请求不能改变目标候选。')
      return prior.result.then(() => this.state())
    }
    if (this.#requests.size >= 4096) throw new RangeError('本会话请求过多，请重新启动。')
    const result = this.#selectCandidate(tailId,candidateId)
    this.#requests.set(requestId,{tailId:fingerprint,result})
    return result
  }
  async #selectCandidate(tailId: string, candidateId: string): Promise<PlaytestState> {
    const tail = this.#selection.tail, candidates = this.#candidates()
    const target = candidates.find(candidate => candidate.id === candidateId)
    if (!tail || tail.id !== tailId || !target) throw new TypeError('只能切换当前末端回合的候选。')
    if (target.id === (tail.selected ?? tail.id)) { this.#begin(); this.#end(); return this.state() }
    this.#begin(); this.#regenerating = true; this.#cancelled = false
    const previous = this.#selection, version = randomUUID()
    let oldClosed = false
    this.#runtime.holdCognition()
    try {
      if ((await this.#runtime.state()).paused) throw new PlaytestBusyError('请先恢复 NPC。')
      if (this.options.publicationAudit) throw new TypeError('外部审计实验不支持隔离候选切换。')
      if (tail.environment !== await this.#environment()) throw new TypeError('环境已改变，拒绝切换候选。')
      const current = await this.#runtime.settleRound()
      if (current.headSeq !== tail.headSeq || current.tick !== tail.tick) throw new TypeError('末端回合之后已有新的世界变化。')
      const path = resolve(this.options.dataDirectory,target.directory)
      if (realpathSync(path) !== path) throw new TypeError('候选目录不能使用链接。')
      const head = assertSettled(path,this.address)
      if (head.headSeq !== target.headSeq || head.tick !== target.tick) throw new TypeError('候选世界已改变，拒绝切换。')
      // Finish the old world's jobs before opening an existing candidate with a fresh task version.
      await this.#runtime.close(); oldClosed = true
      flushTailData(this.dataDirectory)
      const {shadowAudit:_shadow,...options} = this.options
      this.#candidate = await this.factory({...options,dataDirectory:path,logicalDirectory:this.options.dataDirectory,
        worldVersion:version,storyNodes:false,memoryShadow:false})
      this.#candidate.holdCognition()
      const opened = await this.#candidate.settleRound()
      if (opened.headSeq !== head.headSeq || opened.tick !== head.tick) throw new TypeError('候选恢复改变了世界，拒绝切换。')
      this.#candidate.validateCognition()
      if (tail.environment !== await this.#environment()) throw new TypeError('切换期间环境已改变。')
      flushTailData(path)
      if (this.#cancelled || this.#closed) throw new TypeError('候选切换已取消，原结果保留。')
      this.#write({directory:target.directory,version,tail:{...tail,id:randomUUID(),selected:target.id,candidates,...head}})
      this.#runtime = this.#candidate; this.#candidate = undefined
      this.#regenerating = false
      this.#notice = '已切换回合候选。'
    } catch (error) {
      if (oldClosed && !this.#closed) this.#runtime = await this.factory({...this.options,
        dataDirectory:resolve(this.options.dataDirectory,previous.directory),logicalDirectory:this.options.dataDirectory,worldVersion:previous.version})
      this.#notice = error instanceof Error ? error.message : '候选切换失败，原结果保留。'
      throw error
    } finally {
      await this.#candidate?.close(); this.#candidate = undefined
      this.#runtime.releaseCognition(); this.#regenerating = false; this.#end()
    }
    return this.state()
  }
  async cancelRegeneration(): Promise<PlaytestState> {
    if (this.#regenerating) { this.#cancelled = true; this.#candidate?.abortWork() }
    return this.state()
  }
  async saveNode(title: string) {
    this.#begin()
    try { return await this.#runtime.saveNode(title) } finally { this.#end() }
  }
  async refreshMemory(): Promise<PlaytestState> {
    if (this.#regenerating || this.#closed) throw new PlaytestBusyError('请等待重新生成完成。')
    return this.#runtime.refreshMemory()
  }
  async cancelMemory(): Promise<PlaytestState> {
    if (this.#regenerating || this.#busy) throw new PlaytestBusyError('请等待当前回合完成。')
    return this.#runtime.cancelMemory()
  }
  async waitForMemory(): Promise<void> { await this.#runtime.waitForMemory() }
  async escape(): Promise<PlaytestState> {
    if (this.#closed || this.#escaping) throw new PlaytestBusyError('正在结束操作。')
    this.#escaping = true
    try {
      if (this.#regenerating) { await this.cancelRegeneration(); await this.#done }
      const escaping = this.#runtime.escape()
      await this.#done
      const state = await escaping
      this.#write({...this.#selection,tail:null})
      return state
    } finally { this.#escaping = false }
  }
  async pause(): Promise<PlaytestState> {
    if (this.#regenerating) throw new PlaytestBusyError('请先取消重新生成。')
    return this.#runtime.pause()
  }
  async resume(): Promise<PlaytestState> {
    if (this.#busy || this.#closed || this.#escaping) throw new PlaytestBusyError('请等待当前行动完成。')
    return this.#runtime.resume()
  }
  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise
    this.#closed = true; this.#cancelled = true
    this.#candidate?.abortWork(); this.#runtime.abortWork()
    this.#closePromise = (async () => {
      await this.#done
      try { await this.#runtime.close() } finally { this.releaseOwner() }
    })()
    return this.#closePromise
  }
}
