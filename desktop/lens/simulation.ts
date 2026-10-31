import { randomUUID } from 'node:crypto'
import {
  appendFileSync,
  cpSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { interactionPackageDescription, type WorldJsonObject } from '@harness-world/contracts'
import { createInstalledInteractionPackages } from '@harness-world/interactions-basic'
import { WorldStore } from '@harness-world/store-sqlite'
import { compileWorldPackSource, type CompiledWorldPackV5 } from '@harness-world/world-pack'
import { actionText, WAIT_ACTION, type HostAction, type HostState } from '../host/http-server.ts'
import type { ActivityRequest } from '../host/pack-activity.ts'
import type { AutoStartEvaluation } from '../host/pack-activities.ts'
import { PackStatus } from '../host/pack-status.ts'
import { WorldHostRuntime } from '../host/world-runtime.ts'
import { startStubModel, type StubDecision, type StubModel } from './stub-model.ts'
import { interactionName } from './ids.ts'
import { interactionLabels } from './view.ts'

/** Another opening for the pack, written into a temporary copy before the runtime starts. */
export interface LensStart {
  readonly status?: { readonly public?: WorldJsonObject; readonly characters?: Record<string, WorldJsonObject> }
  /** characterId -> sceneId, the player included. */
  readonly scenes?: Record<string, string>
  /** Activity keys whose autoStart is removed for this simulation. */
  readonly skipAutoStart?: readonly string[]
}
export type LensNpcPlan =
  | { readonly kind: 'abstain' }
  | { readonly kind: 'say'; readonly text: string }
  | { readonly kind: 'perform'; readonly action: HostAction }
export type LensStep =
  | { readonly kind: 'say'; readonly text: string }
  | { readonly kind: 'action'; readonly action: HostAction }
  | { readonly kind: 'activity'; readonly request: Omit<ActivityRequest, 'requestId'> }
  | { readonly kind: 'wait' }
export interface LensTraceLine {
  readonly kind: 'input' | 'resolved' | 'rejected' | 'moved' | 'speech' | 'item' | 'status' | 'round-hook' | 'activity'
  readonly actorId?: string
  /** Set on `activity` lines: the activity the committed event belongs to. */
  readonly activityKey?: string
  readonly text: string
  readonly seq: number
}
/** One interaction a non-player character is offered right now by the real runtime; `label` names it the way the
 * lens view names her whitelisted interactions, so the page can match the two. */
export interface LensNpcOption {
  readonly definitionId: string
  readonly label: string
  readonly targetId?: string
  readonly targetName?: string
  readonly action: HostAction
}
export interface LensStepTrace {
  readonly index: number
  readonly step: LensStep
  readonly lines: readonly LensTraceLine[]
  readonly autoStart: readonly AutoStartEvaluation[]
  /** Non-player characters that had a chance this step: asked by the stub model, or with an action.resolved or
   * speak event (an abstaining character leaves no event). */
  readonly activated: readonly string[]
  readonly error?: string
}

type StoredWorldEvent = ReturnType<WorldStore['readEvents']>[number]
const LENS_DIRECTORY = '.perspectra-lens'
const message = (error: unknown) => (error instanceof Error ? error.message : String(error))
const object = (value: unknown) => value as WorldJsonObject
const readJson = <T>(path: string) => JSON.parse(readFileSync(path, 'utf8')) as T
const show = (value: unknown) => (typeof value === 'string' ? value : JSON.stringify(value))

const COPY_PREFIX = 'perspectra-lens-'
const STALE_COPY_MS = 24 * 60 * 60 * 1000
/** Copies this process still uses; a lens left open for more than a day must not lose its copy to the sweep. */
const liveCopies = new Set<string>()

/** Best effort: removes temporary copies older than a day that a killed Launcher left behind. A copy that cannot be
 * read or removed (another lens may still use it) is skipped; the sweep never throws. */
export function sweepStaleLensCopies(directory = tmpdir(), now = Date.now()): void {
  let names: string[]
  try {
    names = readdirSync(directory)
  } catch {
    return
  }
  for (const name of names) {
    if (!name.startsWith(COPY_PREFIX)) continue
    const path = join(directory, name)
    if (liveCopies.has(path)) continue
    try {
      const stat = statSync(path)
      if (stat.isDirectory() && now - stat.mtimeMs > STALE_COPY_MS) rmSync(path, { recursive: true, force: true })
    } catch {
      // Skipped: in use or already gone.
    }
  }
}

/** Writes the start into the copy; reference errors name the field and ID. */
function rewriteCopy(copy: string, pack: CompiledWorldPackV5, start: LensStart): void {
  const characterIds = new Set<string>(pack.content.characters.map(c => c.characterId))
  const scenes = new Map(pack.content.scenes.map(s => [s.sceneId as string, s]))
  const playerId = pack.content.playerSlots[0]!.characterId
  for (const [characterId, sceneId] of Object.entries(start.scenes ?? {})) {
    if (!characterIds.has(characterId)) throw new TypeError(`起点 scenes：未知角色 ${characterId}`)
    if (!scenes.has(sceneId)) throw new TypeError(`起点 scenes.${characterId}：未知场景 ${sceneId}`)
  }
  const status = start.status
  if (status) {
    const statuses = PackStatus.load(copy, pack)?.statuses
    if (!statuses) throw new TypeError('起点 status：本包没有状态脚本')
    const check = (values: WorldJsonObject, owner: 'public' | 'character', field: string) => {
      for (const key of Object.keys(values))
        if (!statuses.some(s => s.key === key && s.owner === owner))
          throw new TypeError(`起点 ${field}：未知状态 ${key}`)
    }
    check(status.public ?? {}, 'public', 'status.public')
    for (const [characterId, values] of Object.entries(status.characters ?? {})) {
      if (!characterIds.has(characterId)) throw new TypeError(`起点 status.characters：未知角色 ${characterId}`)
      check(values, 'character', 'status.characters.' + characterId)
    }
  }
  const activityPath = (key: string) => `scripts/activities/${key}.js`
  for (const key of start.skipAutoStart ?? [])
    if (!pack.assets.some(asset => asset.path === activityPath(key)))
      throw new TypeError(`起点 skipAutoStart：未知活动 ${key}`)

  const manifest = readJson<{ sceneFiles: string[]; characterFiles: string[] }>(join(copy, 'worldpack.source.json'))
  if (start.scenes && Object.keys(start.scenes).length) {
    const moves = start.scenes
    for (const file of manifest.sceneFiles) {
      const document = readJson<{ scenes: { sceneId: string; lifecycle: string; participantIds: string[] }[] }>(
        join(copy, file),
      )
      for (const scene of document.scenes) {
        const kept = scene.participantIds.filter(id => moves[id] === undefined)
        const joined = Object.keys(moves).filter(id => moves[id] === scene.sceneId)
        scene.participantIds = [...kept, ...joined]
        if (moves[playerId] === scene.sceneId) scene.lifecycle = 'active'
        else if (scene.lifecycle === 'active' && !scene.participantIds.length) scene.lifecycle = 'created'
      }
      writeFileSync(join(copy, file), JSON.stringify(document, null, 2))
    }
    for (const file of manifest.characterFiles) {
      const document = readJson<{ characters: { characterId: string; initialLocationId?: string | null }[] }>(
        join(copy, file),
      )
      for (const character of document.characters) {
        const sceneId = moves[character.characterId]
        if (sceneId !== undefined) character.initialLocationId = scenes.get(sceneId)!.locationId
      }
      writeFileSync(join(copy, file), JSON.stringify(document, null, 2))
    }
  }
  if (status)
    appendFileSync(
      join(copy, 'scripts/status.js'),
      `
;(() => {
  const start = ${JSON.stringify(status)}
  const initialize = globalThis.statusScript.initialize
  globalThis.statusScript.initialize = function (...args) {
    const result = initialize.apply(this, args)
    Object.assign(result.public, start.public ?? {})
    for (const [id, values] of Object.entries(start.characters ?? {}))
      result.characters[id] = Object.assign(result.characters[id] ?? {}, values)
    return result
  }
})()
`,
    )
  for (const key of start.skipAutoStart ?? [])
    appendFileSync(join(copy, activityPath(key)), '\nglobalThis.activityScript.autoStart = undefined\n')
}

function npcDecision(plan: LensNpcPlan | undefined): StubDecision {
  if (!plan || plan.kind === 'abstain') return { decision: 'abstain' }
  if (plan.kind === 'say') return { decision: 'publish', segments: [{ type: 'speech', text: plan.text }] }
  return { decision: 'perform', actionType: plan.action.actionType, parameters: plan.action.parameters }
}

function inputText(step: LensStep): string {
  if (step.kind === 'say') return `输入：说「${step.text}」`
  if (step.kind === 'action') return '输入：' + actionText(step.action)
  if (step.kind === 'activity')
    return `输入：活动 ${step.request.activityKey ?? '（当前）'} 的 ${step.request.operation}`
  return '输入：静观'
}

/** A real host runtime on a temporary copy of the pack, answered by a stub model; the pack itself is never written. */
export class LensSimulation {
  readonly #root: string
  readonly #runtime: WorldHostRuntime
  readonly #stub: StubModel
  readonly #playerId: string
  readonly #names: ReadonlyMap<string, string>
  readonly #activityTitles: ReadonlyMap<string, string>
  readonly #npcIds: readonly string[]
  #labels: ReturnType<typeof interactionLabels> | undefined
  #plans = new Map<string, LensNpcPlan[]>()
  #asked = new Set<string>()
  #steps = 0
  #closing: Promise<void> | undefined

  private constructor(
    readonly startedFrom: LensStart,
    root: string,
    runtime: WorldHostRuntime,
    stub: StubModel,
    pack: CompiledWorldPackV5,
    activityTitles: ReadonlyMap<string, string>,
  ) {
    this.#root = root
    this.#runtime = runtime
    this.#stub = stub
    this.#playerId = pack.content.playerSlots[0]!.characterId
    this.#npcIds = pack.content.characters.map(c => c.characterId as string).filter(id => id !== this.#playerId)
    this.#names = new Map([
      ...pack.content.characters.map(c => [c.characterId, c.displayName] as const),
      ...pack.content.locations.map(l => [l.locationId, l.name ?? l.locationId] as const),
      ...(pack.content.entities ?? []).map(e => [e.entityId, e.name ?? e.entityId] as const),
    ])
    this.#activityTitles = activityTitles
    stub.decide = characterId => {
      this.#asked.add(characterId)
      return npcDecision(this.#plans.get(characterId)?.shift())
    }
  }

  static async open(packPath: string, start: LensStart = {}): Promise<LensSimulation> {
    const source = resolve(packPath)
    sweepStaleLensCopies()
    const root = mkdtempSync(join(tmpdir(), COPY_PREFIX)),
      copy = join(root, 'pack')
    liveCopies.add(root)
    let stub: StubModel | undefined, runtime: WorldHostRuntime | undefined
    try {
      cpSync(source, copy, { recursive: true, filter: path => relative(source, path) !== LENS_DIRECTORY })
      const pack = (await compileWorldPackSource(
        copy,
        createInstalledInteractionPackages().map(interactionPackageDescription),
      )) as CompiledWorldPackV5
      rewriteCopy(copy, pack, start)
      stub = await startStubModel()
      runtime = await WorldHostRuntime.create({
        packPath: copy,
        dataDirectory: join(root, 'data'),
        models: stub.models,
        memoryCore: false,
        timeoutMs: 10_000,
      })
      const titles = new Map(
        ((await runtime.state()).activities ?? []).map(a => [String(a.activityKey), String(a.title)] as const),
      )
      return new LensSimulation(structuredClone(start), root, runtime, stub, pack, titles)
    } catch (error) {
      await runtime?.close()
      await stub?.close()
      rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
      liveCopies.delete(root)
      throw error
    }
  }

  state(): Promise<HostState> {
    return this.#runtime.state()
  }
  async statusTruth(): Promise<WorldJsonObject> {
    return object(this.#runtime.creatorInspection({ limit: 1 }).statusTruth ?? {})
  }
  setNpcPlans(plans: Record<string, readonly LensNpcPlan[]>): void {
    this.#plans = new Map(Object.entries(plans).map(([id, list]) => [id, [...list]]))
  }
  conditionsNow(): readonly AutoStartEvaluation[] {
    return this.#runtime.autoStartEvaluations('now')
  }
  statusDefinition() {
    return this.#runtime.statusDefinition()
  }
  activityDefinitions() {
    return this.#runtime.activityDefinitions()
  }
  /** Per non-player character, the interactions the runtime's own resolver chain offers her right now. */
  npcOptions(): Record<string, readonly LensNpcOption[]> {
    this.#labels ??= interactionLabels(join(this.#root, 'pack'), this.#runtime.statusDefinition().operations)
    const { operationLabels, bindingLabels } = this.#labels
    return Object.fromEntries(
      this.#npcIds.map(characterId => [
        characterId,
        this.#runtime
          .characterAffordances(characterId)
          .filter(affordance => affordance.actionType === 'interact')
          .flatMap(affordance => affordance.interactions ?? [])
          .flatMap((option): LensNpcOption[] => {
            const definitionId = (option.definitionRef as WorldJsonObject | undefined)?.id
            if (typeof definitionId !== 'string') return []
            const targetId = (option.targetRef as WorldJsonObject | undefined)?.id
            const label =
              definitionId.startsWith('activity:') && typeof option.label === 'string'
                ? option.label
                : interactionName(definitionId, characterId, operationLabels, bindingLabels)
            const parameters: WorldJsonObject = {
              ...(option.targetRef === undefined ? {} : { targetRef: option.targetRef }),
              ...(option.bindingId === undefined ? {} : { bindingId: option.bindingId }),
              definitionRef: option.definitionRef!,
              arguments: option.arguments ?? {},
            }
            return [
              {
                definitionId,
                label,
                ...(typeof targetId === 'string' ? { targetId, targetName: this.#name(targetId) } : {}),
                action: { actionType: 'interact', parameters },
              },
            ]
          }),
      ]),
    )
  }

  async step(step: LensStep): Promise<LensStepTrace> {
    const index = this.#steps++
    const before = this.#read().at(-1)?.seq ?? 0
    let error: string | undefined
    this.#asked = new Set()
    // The host refreshes its last evaluations only when a round commits; autoStart() assigns a new array, so an
    // unchanged reference means this step ran no check and must not repeat the previous step's (e.g. `started`).
    const previousAutoStart = this.#runtime.autoStartEvaluations('last')
    try {
      if (step.kind === 'say') await this.#runtime.submit(step.text)
      else if (step.kind === 'action') await this.#runtime.perform(step.action)
      else if (step.kind === 'activity')
        await this.#runtime.activityAction({ ...step.request, requestId: randomUUID() })
      // The player's 静观 button: a round without input, which records its round like any other.
      else await this.#runtime.perform(WAIT_ACTION)
    } catch (cause) {
      error = message(cause)
    }
    const events = this.#read()
    const lines = [
      { kind: 'input' as const, actorId: this.#playerId, text: inputText(step), seq: before },
      ...this.#lines(events, before),
    ]
    const autoStart = this.#runtime.autoStartEvaluations('last')
    const activated = new Set([...this.#asked].filter(id => id !== this.#playerId))
    for (const event of events)
      if (event.seq > before) {
        const data = object(event.data)
        const actor =
          event.eventType === 'action.resolved'
            ? data.actorId
            : event.eventType === 'character.speak'
              ? data.characterId
              : undefined
        if (typeof actor === 'string' && actor !== this.#playerId) activated.add(actor)
      }
    return {
      index,
      step: structuredClone(step),
      lines,
      autoStart: autoStart === previousAutoStart ? [] : autoStart,
      activated: [...activated],
      ...(error === undefined ? {} : { error }),
    }
  }

  close(): Promise<void> {
    this.#closing ??= (async () => {
      try {
        await this.#runtime.close()
      } finally {
        await this.#stub.close()
        rmSync(this.#root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
        liveCopies.delete(this.#root)
      }
    })()
    return this.#closing
  }

  #read(): StoredWorldEvent[] {
    const store = new WorldStore(join(this.#runtime.dataDirectory, 'world.sqlite'))
    try {
      return store.readEvents(this.#runtime.address)
    } finally {
      store.close()
    }
  }
  #name(id: unknown): string {
    return typeof id === 'string' ? (this.#names.get(id) ?? id) : '（无）'
  }

  /** One Chinese line per committed fact after `before`; status lines show the value it replaced. */
  #lines(events: readonly StoredWorldEvent[], before: number): LensTraceLine[] {
    const truth = new Map<string, unknown>()
    const lines: LensTraceLine[] = []
    for (const event of events) {
      const data = object(event.data),
        seq = event.seq,
        later = seq > before
      if (event.eventType === 'status.updated') {
        const changes = data.changes as { holderId: string | null; key: string; value: unknown }[]
        const described = changes.map(({ holderId, key, value }) => {
          const slot = (holderId ?? '') + '\0' + key
          const text = `${holderId === null ? '' : this.#name(holderId) + ' 的 '}${key}：${show(truth.get(slot) ?? '（无）')} → ${show(value)}`
          truth.set(slot, value)
          return text
        })
        if (!later) continue
        if (object(data.source).kind === 'round')
          lines.push({ kind: 'round-hook', text: '回合结束：' + (described.join('；') || '无变化'), seq })
        else for (const text of described) lines.push({ kind: 'status', text: '状态 ' + text, seq })
        continue
      }
      if (!later) continue
      const line = this.#line(event.eventType, data)
      if (line) lines.push({ ...line, seq })
    }
    return lines
  }
  #line(eventType: string, data: WorldJsonObject): Omit<LensTraceLine, 'seq'> | undefined {
    switch (eventType) {
      case 'action.resolved': {
        const actorId = String(data.actorId)
        return data.accepted === true
          ? { kind: 'resolved', actorId, text: `${this.#name(actorId)} 的 ${show(data.actionType)} 行动已裁定` }
          : {
              kind: 'rejected',
              actorId,
              text: `${this.#name(actorId)} 的 ${show(data.actionType)} 行动被拒绝：${show(data.reason)}`,
            }
      }
      case 'action.rejected': {
        const actorId = String(data.characterId)
        return {
          kind: 'rejected',
          actorId,
          text: `${this.#name(actorId)} 的 ${show(data.actionType)} 行动被拒绝：${show(data.reason)}`,
        }
      }
      case 'character.moved': {
        const actorId = String(data.characterId)
        return {
          kind: 'moved',
          actorId,
          text: `${this.#name(actorId)} 从 ${this.#name(data.fromLocationId)} 来到 ${this.#name(data.toLocationId)}`,
        }
      }
      case 'character.speak': {
        const actorId = String(data.characterId)
        const segments = data.segments as { type: string; text: string }[] | undefined
        const text = segments
          ? segments.map(s => (s.type === 'narration' ? `（${s.text}）` : s.text)).join('')
          : String(data.text)
        return { kind: 'speech', actorId, text: `${this.#name(actorId)} 说：${text}` }
      }
      case 'entity.transferred':
      case 'entity.taken': {
        const actorId = String(data.characterId)
        const to = eventType === 'entity.taken' ? data.characterId : (data.toHolderId ?? data.toLocationId)
        return {
          kind: 'item',
          actorId,
          text: `${this.#name(data.entityId)}：${this.#name(data.fromHolderId ?? data.fromLocationId)} → ${this.#name(to)}`,
        }
      }
      case 'activity.updated': {
        const key = String(data.activityKey)
        return {
          kind: 'activity',
          actorId: String(data.actorId),
          activityKey: key,
          text: `活动 ${this.#activityTitles.get(key) ?? key}（${key}）：${show(data.description)}`,
        }
      }
      default:
        return undefined
    }
  }
}
