import { tailRuntimeIdentity } from '../tail-runtime-identity.ts'
import { randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import { realpathSync } from 'node:fs'
import {
  assertSettled,
  durableJson,
  flushTailData,
  ownStoryline,
  readTailSelection,
  restoreTail,
  type TailRecord,
  type TailSelection,
} from '../tail-storage.ts'
import { interactionPackageDescription, type WorldJsonObject } from '@harness-world/contracts'
import { createInstalledInteractionPackages } from '@harness-world/interactions-basic'
import { compileWorldPackSource } from '@harness-world/world-pack'
import { actionText, HostBusyError, isWait, type HostAction, type HostState, type PlayerLine } from './http-server.ts'
import type { WorldHostOptions, WorldHostCore } from './world-runtime.ts'
import type { RuntimeModel, RuntimeRole } from '../model-connections.ts'
import type { ActivityRequest } from './pack-activity.ts'

type Factory = (options: WorldHostOptions) => Promise<WorldHostCore>

// Bump when executable rules/context interpretation change incompatibly. Pack lock already covers declared script bytes.
const runtimeRevision = 'tail-round-2026-10-08/v1'
const loadedRuntimeIdentity = tailRuntimeIdentity()

/** Small session owner around the existing executor; candidate databases are never served before selection. */
export class TailRoundRuntime {
  #startingEnvironment = ''
  #runtime: WorldHostCore
  #selection: TailSelection
  #busy = false
  #interrupting = false
  #closed = false
  #escaping = false
  #candidate: WorldHostCore | undefined
  #cancelled = false
  #regenerating = false
  #done: Promise<void> = Promise.resolve()
  #finish: (() => void) | undefined
  #notice = ''
  #closePromise: Promise<void> | undefined
  #requests = new Map<string, { tailId: string; result: Promise<HostState> }>()
  protected constructor(
    readonly options: WorldHostOptions,
    readonly factory: Factory,
    runtime: WorldHostCore,
    selection: TailSelection,
    readonly releaseOwner: () => void,
  ) {
    this.#runtime = runtime
    this.#selection = selection
  }
  static async open(options: WorldHostOptions, factory: Factory): Promise<TailRoundRuntime> {
    const root = resolve(options.dataDirectory),
      release = ownStoryline(root)
    try {
      const selection = readTailSelection(root) ?? { directory: '.', version: randomUUID(), tail: null }
      const runtime = await factory({
        ...options,
        dataDirectory: resolve(root, selection.directory),
        logicalDirectory: root,
        worldVersion: selection.version,
      })
      const owner = new TailRoundRuntime({ ...options, dataDirectory: root }, factory, runtime, selection, release)
      try {
        owner.#startingEnvironment = await owner.#environment()
      } catch (error) {
        await runtime.close()
        throw error
      }
      return owner
    } catch (error) {
      release()
      throw error
    }
  }
  get address() {
    return this.#runtime.address
  }
  get dataDirectory(): string {
    return resolve(this.options.dataDirectory, this.#selection.directory)
  }
  requestInspection(enabled?: boolean) {
    if (this.#closed || this.#regenerating || this.#interrupting) throw new HostBusyError('请等待世界切换完成。')
    return this.#runtime.requestInspection(enabled)
  }
  creatorRecords(query: import('./creator-records.ts').CreatorRecordsQuery = {}) {
    if (this.#closed || this.#regenerating || this.#interrupting) throw new HostBusyError('请等待世界切换完成。')
    return this.#runtime.creatorRecords(query)
  }
  creatorHistory(query: import('./creator-history.ts').CreatorHistoryQuery = {}) {
    if (this.#closed || this.#regenerating || this.#interrupting) throw new HostBusyError('请等待世界切换完成。')
    return {
      ...this.#runtime.creatorHistory(query),
      selection: {
        worldVersion: this.#selection.version,
        tailId: this.#selection.tail?.id ?? null,
        candidateId: this.#selection.tail?.selected ?? null,
        candidateIds: this.#candidates().map(candidate => candidate.id),
      },
    }
  }
  creatorInspection(query: import('./creator-inspection.ts').CreatorInspectionQuery = {}) {
    if (this.#closed || this.#regenerating || this.#interrupting) throw new HostBusyError('请等待世界切换完成。')
    return this.#runtime.creatorInspection(query)
  }
  /** A candidate stays silent until it is installed, so subscribers never read an unselected tail. */
  #candidateFeed(): { options: Pick<WorldHostOptions, 'playerFeed'>; open(): void } {
    const target = this.options.playerFeed
    if (!target) return { options: {}, open: () => {} }
    let installed = false
    return {
      options: { playerFeed: { publish: transcript => installed && target.publish(transcript) } },
      open: () => {
        installed = true
      },
    }
  }
  supportsHistoryRestore(): boolean {
    return this.#runtime.supportsHistoryRestore()
  }
  autoStartEvaluations(mode: 'last' | 'now') {
    return this.#runtime.autoStartEvaluations(mode)
  }
  async state(): Promise<HostState> {
    const state = await this.#runtime.state()
    const canInterrupt =
      state.canInterrupt === true && !this.#interrupting && !this.#regenerating && !this.#closed && !this.#escaping
    return {
      ...state,
      canInterrupt,
      background: state.background === true && canInterrupt,
      ...(state.playerFeedback
        ? {
            playerFeedback: {
              phase: this.#regenerating
                ? '正在重新生成末端回合'
                : this.#busy && !state.busy
                  ? '正在整理本轮进度'
                  : state.playerFeedback.phase,
              message: this.#notice || state.playerFeedback.message,
            },
          }
        : {}),
      busy: this.#busy || state.busy,
      phaseLabel: this.#regenerating ? '正在重新生成末端回合' : state.phaseLabel,
      notice: this.#notice || state.notice,
      tailRound: this.#selection.tail
        ? {
            id: this.#selection.tail.id,
            worldVersion: this.#selection.version,
            candidateIds: this.#candidates().map(candidate => candidate.id),
            candidateIndex:
              this.#candidates().findIndex(
                candidate => candidate.id === (this.#selection.tail!.selected ?? this.#selection.tail!.id),
              ) + 1,
            canRegenerate:
              this.#runtime.supportsHistoryRestore() &&
              !this.#busy &&
              !this.#closed &&
              !this.#escaping &&
              !state.paused,
            regenerating: this.#regenerating,
          }
        : { id: null, worldVersion: this.#selection.version, canRegenerate: false, regenerating: this.#regenerating },
    }
  }
  #candidates() {
    const tail = this.#selection.tail
    return (
      tail?.candidates ??
      (tail ? [{ id: tail.id, directory: this.#selection.directory, headSeq: tail.headSeq, tick: tail.tick }] : [])
    )
  }
  #begin(): void {
    if (this.#busy || this.#closed || this.#escaping) throw new HostBusyError('请等待当前行动完成。')
    this.#busy = true
    this.#notice = ''
    this.#done = new Promise<void>(done => {
      this.#finish = done
    })
  }
  #end(): void {
    this.#busy = false
    this.#finish?.()
    this.#finish = undefined
  }
  #write(selection: TailSelection): void {
    durableJson(join(this.options.dataDirectory, 'current-world.json'), selection)
    this.#selection = selection
  }
  async #environment(): Promise<string> {
    const pack = await compileWorldPackSource(
      resolve(this.options.packPath),
      createInstalledInteractionPackages().map(interactionPackageDescription),
    )
    if (pack.packHash !== this.#runtime.packHash) throw new TypeError('世界包环境已改变，请结束并重新启动。')
    if (tailRuntimeIdentity() !== loadedRuntimeIdentity) throw new TypeError('运行代码已改变，请结束并重新启动。')
    // Call targets without their keys: a key change is not an environment change, a target change is.
    const target = ({ apiKey: _key, ...rest }: RuntimeModel) => rest
    const role = (r: RuntimeRole) => ({ decision: target(r.decision), memory: target(r.memory) })
    return JSON.stringify({
      runtimeRevision,
      executable: loadedRuntimeIdentity,
      packHash: pack.packHash,
      assets: pack.assets,
      interaction: createInstalledInteractionPackages().map(interactionPackageDescription),
      models: {
        default: role(this.options.models.default),
        characters: Object.fromEntries(Object.entries(this.options.models.characters).map(([id, r]) => [id, role(r)])),
      },
      preset: this.options.preset ?? {},
      presetMapping: this.options.presetMapping ?? {},
      serialScheduling: !!this.options.serialScheduling,
      stagedAutonomy: !!this.options.stagedAutonomy,
      continueAfterPublish: !!this.options.continueAfterPublish,
      beforeActionExpression: !!this.options.beforeActionExpression,
      ...(this.options.recentExecutionEvidence ? { recentExecutionEvidence: true } : {}),
      playSettings: this.options.playSettings ?? null,
      tuning: this.options.tuning ?? null,
      memoryCore: !!this.options.memoryCore,
      memoryContextBudget: this.options.memoryContextBudget ?? null,
    })
  }
  async #run(input: TailRecord['input'], idempotencyKey?: string): Promise<HostState> {
    this.#begin()
    this.#runtime.holdCognition()
    const roundId = randomUUID(),
      base = randomUUID()
    try {
      if ((await this.#runtime.state()).paused) throw new HostBusyError('请先恢复 NPC。')
      // The executor's loaded pack/config is immutable. Recheck disk/code only at replay boundaries.
      const environment = this.#startingEnvironment
      // Old eligibility is invalidated durably BEFORE the next world operation.
      this.#write({ ...this.#selection, tail: null })
      const before = await this.#runtime.settleRound()
      if (this.supportsHistoryRestore())
        await this.#runtime.snapshotRound(join(this.options.dataDirectory, '.tail', 'bases', base))
      this.#runtime.beginRoundRandom()
      const result =
        'text' in input
          ? await this.#runtime.submit(input.text, idempotencyKey)
          : 'texts' in input
            ? await this.#runtime.turn(input.texts, idempotencyKey)
            : await this.#runtime.activityAction(input.activity as ActivityRequest)
      if (result.paused || this.#escaping) return result
      const head = await this.#runtime.settleRound()
      if (this.supportsHistoryRestore() && (head.headSeq > before.headSeq || 'activity' in input))
        this.#write({
          ...this.#selection,
          tail: {
            id: roundId,
            base,
            input: structuredClone(input),
            environment,
            ...head,
            activityRandom: this.#runtime.roundRandom(),
            selected: roundId,
            candidates: [{ id: roundId, directory: this.#selection.directory, ...head }],
          },
        })
      return result
    } finally {
      this.#runtime.releaseCognition()
      this.#end()
    }
  }
  /** A new player input or action cancels unfinished NPC work; committed results stay. */
  async #interruptIfBusy(): Promise<void> {
    if (this.#interrupting) throw new HostBusyError('正在受理新的输入，请稍候。')
    if (!this.#busy) return
    this.#interrupting = true
    try {
      const state = await this.#runtime.state()
      if (!state.canInterrupt || this.#regenerating || this.#closed || this.#escaping)
        throw new HostBusyError('请等待当前操作完成。')
      this.#runtime.abortWork()
      await this.#done
    } finally {
      this.#interrupting = false
    }
  }
  async submit(text: string, idempotencyKey?: string): Promise<HostState> {
    if (this.#busy || this.#interrupting) await this.#interruptIfBusy()
    await this.#run({ text }, idempotencyKey)
    return this.state()
  }
  /** A `line` said with an in-world action makes one turn with it, recorded and regenerated as one round. */
  async perform(action: HostAction, line?: PlayerLine): Promise<HostState> {
    if (line !== undefined) {
      const id = String((action.parameters.definitionRef as WorldJsonObject | undefined)?.id ?? '')
      if (id.startsWith('host:')) throw new TypeError('活动管理操作不能附带发言')
      if (this.#busy || this.#interrupting) await this.#interruptIfBusy()
      const say = '/act speak ' + JSON.stringify(line.speech),
        act = actionText(action)
      await this.#run({ texts: line.order === 'after' ? [act, say] : [say, act] })
      return this.state()
    }
    if (this.#busy || this.#interrupting) await this.#interruptIfBusy()
    // Waiting is a turn without input, recorded and regenerated like any other.
    if (isWait(action)) {
      await this.#run({ texts: [] })
      return this.state()
    }
    if (
      action.actionType === 'interact' &&
      (action.parameters.definitionRef as WorldJsonObject | undefined)?.id === 'host:activity-quick'
    ) {
      const operation = String(action.parameters.operation)
      const current = (await this.state()).activities?.find(view => view.activityKey === action.parameters.activityKey)
      if (!current || !(current.quickOperations as WorldJsonObject[] | undefined)?.some(op => op.id === operation))
        throw new TypeError('活动入口已失效，请刷新')
      return this.activityAction({
        activityKey: String(current.activityKey),
        activityId: null,
        revision: 0,
        operation,
        parameters: {},
        requestId: randomUUID(),
      })
    }
    if (
      action.actionType === 'interact' &&
      [
        'host:activity-start',
        'host:activity-retry',
        'host:activity-suspend',
        'host:activity-resume',
        'host:activity-abandon',
      ].includes(String((action.parameters.definitionRef as WorldJsonObject | undefined)?.id))
    ) {
      const state = await this.state()
      const current =
        action.parameters.activityKey === undefined
          ? state.activity
          : state.activities?.find(view => view.activityKey === action.parameters.activityKey)
      if (
        !current ||
        (current.id ?? null) !== action.parameters.previousId ||
        (current.revision ?? 0) !== action.parameters.previousRevision
      )
        throw new TypeError('活动入口已失效，请刷新')
      const operation = String((action.parameters.definitionRef as WorldJsonObject).id).slice('host:activity-'.length)
      if (operation !== 'start' && action.parameters.startParameters !== undefined)
        throw new TypeError('只有开始活动可选择参与者')
      const startParameters = action.parameters.startParameters
      if (
        startParameters !== undefined &&
        (!startParameters || typeof startParameters !== 'object' || Array.isArray(startParameters))
      )
        throw new TypeError('开始参数无效')
      return this.activityAction({
        ...(current.activityKey === undefined ? {} : { activityKey: String(current.activityKey) }),
        activityId: operation === 'start' ? null : String(current.id),
        revision: operation === 'start' ? 0 : Number(current.revision),
        operation,
        parameters: (startParameters as WorldJsonObject | undefined) ?? {},
        requestId: randomUUID(),
      })
    }
    return this.submit(actionText(action))
  }
  async activityAction(activity: ActivityRequest): Promise<HostState> {
    await this.#run({ activity: structuredClone(activity) })
    return this.state()
  }
  regenerate(tailId: string, requestId: string): Promise<HostState> {
    const prior = this.#requests.get(requestId)
    if (prior) {
      if (prior.tailId !== tailId) throw new TypeError('同一请求不能改变目标回合。')
      return prior.result.then(() => this.state())
    }
    if (this.#requests.size >= 4096) throw new RangeError('本会话请求过多，请重新启动。')
    const result = this.#regenerate(tailId)
    this.#requests.set(requestId, { tailId, result })
    return result
  }
  async #regenerate(tailId: string): Promise<HostState> {
    if (!this.#runtime.supportsHistoryRestore()) throw new TypeError('当前外部能力不支持回退或重新生成。')
    const tail = this.#selection.tail
    if (!tail || tail.id !== tailId) throw new TypeError('只能重新生成当前世界线的末端回合。')
    this.#begin()
    this.#regenerating = true
    this.#cancelled = false
    const previous = this.#selection,
      version = randomUUID(),
      directory = '.tail/results/' + version
    let oldClosed = false,
      selected = false
    this.#runtime.holdCognition()
    try {
      if ((await this.#runtime.state()).paused) throw new HostBusyError('请先恢复 NPC。')
      if (this.options.publicationAudit) throw new TypeError('外部审计实验不支持隔离重新生成。')
      if (tail.environment !== (await this.#environment()))
        throw new TypeError('世界包、脚本、规则或模型环境已改变，拒绝重新生成。')
      const head = await this.#runtime.settleRound()
      if (head.headSeq !== tail.headSeq || head.tick !== tail.tick)
        throw new TypeError('末端回合之后已有新的世界变化。')
      restoreTail(
        join(this.options.dataDirectory, '.tail', 'bases', tail.base),
        resolve(this.options.dataDirectory, directory),
      )
      this.#runtime.inheritCreatorBase(tail.base, directory)
      const { shadowAudit: _shadow, ...isolatedOptions } = this.options
      const feed = this.#candidateFeed()
      const candidateOptions = {
        ...isolatedOptions,
        ...feed.options,
        dataDirectory: resolve(this.options.dataDirectory, directory),
        logicalDirectory: this.options.dataDirectory,
        worldVersion: version,
        storyNodes: false,
        memoryShadow: false,
      }
      this.#candidate = await this.factory(candidateOptions)
      this.#candidate.holdCognition()
      this.#candidate.beginRoundRandom(tail.activityRandom)
      if (this.#cancelled || this.#closed) throw new TypeError('重新生成已取消，原结果保留。')
      const result =
        'text' in tail.input
          ? await this.#candidate.submit(tail.input.text)
          : 'texts' in tail.input
            ? await this.#candidate.turn(tail.input.texts)
            : await this.#candidate.activityAction(tail.input.activity as ActivityRequest)
      if (this.#cancelled || this.#closed) throw new TypeError('重新生成已取消，原结果保留。')
      if (result.error) throw new TypeError('候选角色处理未完成，原结果保留。')
      const end = await this.#candidate.settleRound()
      if (tail.environment !== (await this.#environment())) throw new TypeError('生成期间环境已改变，原结果保留。')
      if (this.#cancelled || this.#closed) throw new TypeError('重新生成已取消，原结果保留。')
      // Close/checkpoint all candidate writers, then validate a fresh runtime before the atomic selection.
      await this.#candidate.close()
      this.#candidate = undefined
      this.#candidate = await this.factory(candidateOptions)
      this.#candidate.holdCognition()
      await this.#candidate.settleRound()
      this.#candidate.validateCognition()
      assertSettled(resolve(this.options.dataDirectory, directory), this.address)
      flushTailData(resolve(this.options.dataDirectory, directory))
      if (this.#cancelled || this.#closed) throw new TypeError('重新生成已取消，原结果保留。')
      await this.#runtime.close()
      oldClosed = true
      if (this.#cancelled || this.#closed) throw new TypeError('重新生成已取消，原结果保留。')
      const candidateId = randomUUID()
      this.#write({
        directory,
        version,
        tail: {
          ...tail,
          id: candidateId,
          selected: candidateId,
          ...end,
          candidates: [...this.#candidates(), { id: candidateId, directory, ...end }],
        },
      })
      selected = true // no awaits between the durable commit point and installing the matching runtime
      this.#runtime = this.#candidate
      this.#candidate = undefined
      feed.open()
      this.#runtime.publishPlayerFeed()
      this.#regenerating = false
      this.#runtime.releaseCognition()
      this.#notice = '已生成新候选，原结果仍可切换。'
    } catch (error) {
      if (!selected && oldClosed && !this.#closed)
        this.#runtime = await this.factory({
          ...this.options,
          dataDirectory: resolve(this.options.dataDirectory, previous.directory),
          logicalDirectory: this.options.dataDirectory,
          worldVersion: previous.version,
        })
      this.#notice = error instanceof Error ? error.message : '重新生成失败，原结果保留。'
      throw error
    } finally {
      await this.#candidate?.close()
      this.#candidate = undefined
      this.#runtime.releaseCognition()
      this.#regenerating = false
      this.#end()
    }
    return this.state()
  }
  selectCandidate(tailId: string, candidateId: string, requestId: string): Promise<HostState> {
    const fingerprint = 'select:' + tailId + ':' + candidateId,
      prior = this.#requests.get(requestId)
    if (prior) {
      if (prior.tailId !== fingerprint) throw new TypeError('同一请求不能改变目标候选。')
      return prior.result.then(() => this.state())
    }
    if (this.#requests.size >= 4096) throw new RangeError('本会话请求过多，请重新启动。')
    const result = this.#selectCandidate(tailId, candidateId)
    this.#requests.set(requestId, { tailId: fingerprint, result })
    return result
  }
  async #selectCandidate(tailId: string, candidateId: string): Promise<HostState> {
    if (!this.#runtime.supportsHistoryRestore()) throw new TypeError('当前外部能力不支持候选切换。')
    const tail = this.#selection.tail,
      candidates = this.#candidates()
    const target = candidates.find(candidate => candidate.id === candidateId)
    if (!tail || tail.id !== tailId || !target) throw new TypeError('只能切换当前末端回合的候选。')
    if (target.id === (tail.selected ?? tail.id)) {
      this.#begin()
      this.#end()
      return this.state()
    }
    this.#begin()
    this.#regenerating = true
    this.#cancelled = false
    const previous = this.#selection,
      version = randomUUID()
    let oldClosed = false
    this.#runtime.holdCognition()
    try {
      if ((await this.#runtime.state()).paused) throw new HostBusyError('请先恢复 NPC。')
      if (this.options.publicationAudit) throw new TypeError('外部审计实验不支持隔离候选切换。')
      if (tail.environment !== (await this.#environment())) throw new TypeError('环境已改变，拒绝切换候选。')
      const current = await this.#runtime.settleRound()
      if (current.headSeq !== tail.headSeq || current.tick !== tail.tick)
        throw new TypeError('末端回合之后已有新的世界变化。')
      const path = resolve(this.options.dataDirectory, target.directory)
      if (realpathSync(path) !== path) throw new TypeError('候选目录不能使用链接。')
      const head = assertSettled(path, this.address)
      if (head.headSeq !== target.headSeq || head.tick !== target.tick)
        throw new TypeError('候选世界已改变，拒绝切换。')
      // Finish the old world's jobs before opening an existing candidate with a fresh task version.
      await this.#runtime.close()
      oldClosed = true
      flushTailData(this.dataDirectory)
      const { shadowAudit: _shadow, ...options } = this.options
      const feed = this.#candidateFeed()
      this.#candidate = await this.factory({
        ...options,
        ...feed.options,
        dataDirectory: path,
        logicalDirectory: this.options.dataDirectory,
        worldVersion: version,
        storyNodes: false,
        memoryShadow: false,
      })
      this.#candidate.holdCognition()
      const opened = await this.#candidate.settleRound()
      if (opened.headSeq !== head.headSeq || opened.tick !== head.tick)
        throw new TypeError('候选恢复改变了世界，拒绝切换。')
      this.#candidate.validateCognition()
      if (tail.environment !== (await this.#environment())) throw new TypeError('切换期间环境已改变。')
      flushTailData(path)
      if (this.#cancelled || this.#closed) throw new TypeError('候选切换已取消，原结果保留。')
      this.#write({
        directory: target.directory,
        version,
        tail: { ...tail, id: randomUUID(), selected: target.id, candidates, ...head },
      })
      this.#runtime = this.#candidate
      this.#candidate = undefined
      feed.open()
      this.#runtime.publishPlayerFeed()
      this.#regenerating = false
      this.#notice = '已切换回合候选。'
    } catch (error) {
      if (oldClosed && !this.#closed)
        this.#runtime = await this.factory({
          ...this.options,
          dataDirectory: resolve(this.options.dataDirectory, previous.directory),
          logicalDirectory: this.options.dataDirectory,
          worldVersion: previous.version,
        })
      this.#notice = error instanceof Error ? error.message : '候选切换失败，原结果保留。'
      throw error
    } finally {
      await this.#candidate?.close()
      this.#candidate = undefined
      this.#runtime.releaseCognition()
      this.#regenerating = false
      this.#end()
    }
    return this.state()
  }
  async cancelRegeneration(): Promise<HostState> {
    if (this.#regenerating) {
      this.#cancelled = true
      this.#candidate?.abortWork()
    }
    return this.state()
  }
  async saveNode(title: string) {
    // Off-scene work is presented as idle; saving cancels it instead of rejecting the player.
    if (this.#busy && (await this.state()).background) await this.#interruptIfBusy()
    this.#begin()
    try {
      return await this.#runtime.saveNode(title)
    } finally {
      this.#end()
    }
  }
  async refreshMemory(): Promise<HostState> {
    if (this.#regenerating || this.#closed) throw new HostBusyError('请等待重新生成完成。')
    return this.#runtime.refreshMemory()
  }
  async cancelMemory(): Promise<HostState> {
    if (this.#regenerating || this.#busy) throw new HostBusyError('请等待当前回合完成。')
    return this.#runtime.cancelMemory()
  }
  async waitForMemory(): Promise<void> {
    await this.#runtime.waitForMemory()
  }
  async escape(): Promise<HostState> {
    if (this.#closed || this.#escaping) throw new HostBusyError('正在结束操作。')
    this.#escaping = true
    try {
      if (this.#regenerating) {
        await this.cancelRegeneration()
        await this.#done
      }
      const escaping = this.#runtime.escape()
      await this.#done
      const state = await escaping
      this.#write({ ...this.#selection, tail: null })
      return state
    } finally {
      this.#escaping = false
    }
  }
  async pause(): Promise<HostState> {
    if (this.#regenerating) throw new HostBusyError('请先取消重新生成。')
    return this.#runtime.pause()
  }
  async resume(): Promise<HostState> {
    if (this.#busy || this.#closed || this.#escaping) throw new HostBusyError('请等待当前行动完成。')
    return this.#runtime.resume()
  }
  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise
    this.#closed = true
    this.#cancelled = true
    this.#candidate?.abortWork()
    this.#runtime.abortWork()
    this.#closePromise = (async () => {
      await this.#done
      try {
        await this.#runtime.close()
      } finally {
        this.releaseOwner()
      }
    })()
    return this.#closePromise
  }
}
