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
import { CharacterViewBuilder, WorldStore } from '@harness-world/store-sqlite'
import type { CharacterId } from '@harness-world/contracts'
import { compileWorldPackSource, type CompiledWorldPackV5 } from '@harness-world/world-pack'
import { actionText, WAIT_ACTION, type HostAction, type HostState } from '../host/http-server.ts'
import type { ActivityRequest } from '@harness-world/contracts'
import type { AutoStartEvaluation } from '@harness-world/contracts'
import { StatusState } from '@harness-world/application'
import { assembleRoleplay, type WorldComposition } from '../official-bundle.ts'
import { WorldHostRuntime } from '../host/world-runtime.ts'
import { loadRpgContent } from '../host/rpg-pack.ts'
import { startStubModel, type StubDecision, type StubModel } from './stub-model.ts'
import { activityScriptPath, interactionName } from './ids.ts'
import { interactionLabels } from './view.ts'

/** Another opening for the pack, written into a temporary copy before the runtime starts. */
export interface LensStart {
  readonly status?: { readonly public?: WorldJsonObject; readonly characters?: Record<string, WorldJsonObject> }
  /** characterId -> sceneId, the player included. */
  readonly scenes?: Record<string, string>
  /** Activity keys whose autoStart is removed for this simulation. */
  readonly skipAutoStart?: readonly string[]
}
/** An action named the way the game names it; matched against what is offered at that moment. */
export type LensActionSpec =
  | { readonly move: string }
  | { readonly interact: string; readonly target?: string; readonly arguments?: WorldJsonObject }
/** `action` is the exact shape the page copies from an offered option; `move` / `interact` are the short forms. */
export type LensNpcPlan =
  | { readonly kind: 'abstain' }
  | { readonly kind: 'say'; readonly text: string }
  | ({ readonly kind: 'perform' } & ({ readonly action: HostAction } | LensActionSpec))

/** What a character or the player is offered: the host's available actions or a character context's affordances. */
type Offered = readonly {
  readonly actionType: string
  readonly interactions?: readonly WorldJsonObject[]
  readonly destinations?: readonly { readonly locationId: string }[]
}[]
export class UnmatchedAction extends Error {}

const refId = (value: unknown) => (value as WorldJsonObject | undefined)?.id
/** Builds the request for an offered option; throws UnmatchedAction listing what is offered instead. */
export function matchAction(spec: LensActionSpec, offered: Offered): HostAction {
  if ('move' in spec) {
    const destinations = offered.filter(a => a.actionType === 'move').flatMap(a => a.destinations ?? [])
    if (!destinations.some(d => d.locationId === spec.move))
      throw new UnmatchedAction(
        `找不到可去的地点 ${spec.move}；当前可去：${destinations.map(d => d.locationId).join('、') || '（无）'}`,
      )
    return { actionType: 'move', parameters: { locationId: spec.move } }
  }
  const options = offered.filter(a => a.actionType === 'interact').flatMap(a => a.interactions ?? [])
  const candidates = options.filter(
    option =>
      refId(option.definitionRef) === spec.interact &&
      (spec.target === undefined || refId(option.targetRef) === spec.target),
  )
  if (candidates.length > 1) {
    const targets = candidates.map(option => String(refId(option.targetRef) ?? '（无目标）'))
    throw new UnmatchedAction(`交互 ${spec.interact} 有多个目标，请用 target 指定其一：${targets.join('、')}`)
  }
  const found = candidates[0]
  if (!found) {
    const ids = [...new Set(options.map(option => String(refId(option.definitionRef))))]
    throw new UnmatchedAction(
      `找不到交互 ${spec.interact}${spec.target === undefined ? '' : `（目标 ${spec.target}）`}；当前可用的交互：${ids.join('、') || '（无）'}`,
    )
  }
  return {
    actionType: 'interact',
    parameters: {
      ...(found.targetRef === undefined ? {} : { targetRef: found.targetRef }),
      bindingId: found.bindingId!,
      definitionRef: found.definitionRef!,
      arguments: spec.arguments ?? (found.arguments as WorldJsonObject | undefined) ?? {},
    },
  }
}

/** The short form of any perform plan, so the exact `action` form is checked against the offer the same way. */
function planSpec(plan: Extract<LensNpcPlan, { kind: 'perform' }>): LensActionSpec {
  if (!('action' in plan)) return plan
  const parameters = plan.action.parameters
  if (plan.action.actionType === 'move') return { move: String(parameters.locationId) }
  const target = refId(parameters.targetRef)
  return {
    interact: String(refId(parameters.definitionRef)),
    ...(typeof target === 'string' ? { target } : {}),
    ...(parameters.arguments === undefined ? {} : { arguments: parameters.arguments as WorldJsonObject }),
  }
}
export type LensStep =
  | { readonly kind: 'say'; readonly text: string }
  | { readonly kind: 'action'; readonly action: HostAction }
  | { readonly kind: 'activity'; readonly request: Omit<ActivityRequest, 'requestId'> }
  | { readonly kind: 'wait' }
export interface LensTraceLine {
  /** `plan`: a scripted NPC plan that could not run as written this time; the line says why. */
  readonly kind:
    | 'input'
    | 'resolved'
    | 'rejected'
    | 'moved'
    | 'speech'
    | 'item'
    | 'status'
    | 'round-hook'
    | 'activity'
    | 'plan'
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
  /** Why pacing did or did not bring something at the last round's end. */
  readonly pacing?: WorldJsonObject
  /** Non-player characters that had a chance this step: asked by the stub model, or with an action.resolved or
   * speak event (an abstaining character leaves no event). */
  readonly activated: readonly string[]
  /** Per character, player included, what reached her authorized view in this step; an empty list means nothing. */
  readonly perceived: Record<string, readonly string[]>
  readonly error?: string
}

type StoredWorldEvent = ReturnType<WorldStore['readEvents']>[number]
const LENS_DIRECTORY = '.perspectra-lens'
const message = (error: unknown) => (error instanceof Error ? error.message : String(error))
const object = (value: unknown) => value as WorldJsonObject
const readJson = <T>(path: string) => JSON.parse(readFileSync(path, 'utf8')) as T
const show = (value: unknown) => (typeof value === 'string' ? value : JSON.stringify(value))

const FILE_ACCESS = /unable to open database file|EPERM|EACCES/u
const FILE_ACCESS_HINT =
  '。推演需要在系统临时目录（TEMP）里建临时文件；请确认该目录可写，安全软件没有拦截，程序也不在带低完整性标签的目录里运行'
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
function rewriteCopy(copy: string, pack: CompiledWorldPackV5, start: LensStart, generated: ReadonlySet<string>): void {
  const characterIds = new Set<string>(pack.content.characters.map(c => c.characterId))
  const scenes = new Map(pack.content.scenes.map(s => [s.sceneId as string, s]))
  const playerId = pack.content.playerSlots[0]!.characterId
  for (const [characterId, sceneId] of Object.entries(start.scenes ?? {})) {
    if (!characterIds.has(characterId)) throw new TypeError(`起点 scenes：未知角色 ${characterId}`)
    if (!scenes.has(sceneId)) throw new TypeError(`起点 scenes.${characterId}：未知场景 ${sceneId}`)
  }
  for (const key of start.skipAutoStart ?? [])
    if (!generated.has(key) && !pack.assets.some(asset => asset.path === activityScriptPath(key)))
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
  for (const key of start.skipAutoStart ?? [])
    if (!generated.has(key))
      appendFileSync(join(copy, activityScriptPath(key)), '\nglobalThis.activityScript.autoStart = undefined\n')
}

const NO_AUTO_START = '\nglobalThis.activityScript.autoStart = undefined\n'

/** An activity the RPG mechanism generates has no file to edit, so its skipped auto-start is removed from the generated text. */
function skippingGeneratedAutoStart(composition: WorldComposition, keys: readonly string[]): WorldComposition {
  const { rpg } = composition
  if (!rpg || !keys.length) return composition
  return {
    ...composition,
    rpg: {
      ...rpg,
      mapActivities: (config, context) =>
        rpg
          .mapActivities(config, context)
          .map(activity =>
            keys.includes(activity.key) ? { ...activity, source: activity.source + NO_AUTO_START } : activity,
          ),
    },
  }
}

/** Apply simulation opening data to the selected mechanism, then use the ordinary core initializer. */
function openingComposition(
  composition: WorldComposition,
  pack: CompiledWorldPackV5,
  start: LensStart,
): WorldComposition {
  if (!start.status) return composition
  const provider = composition.mechanisms.status,
    values = structuredClone(start.status)
  if (!provider) throw new TypeError('起点 status：本包没有状态机制')
  return {
    ...composition,
    mechanisms: {
      ...composition.mechanisms,
      status: {
        ...provider,
        open: async (world, signal) => {
          const instance = await provider.open(world, signal)
          try {
            if (instance.definition === undefined) throw new TypeError('起点 status：本包没有状态脚本')
            const characterIds = pack.content.characters.map(character => String(character.characterId))
            const statuses = new StatusState(
              instance.definition,
              characterIds,
              pack.content.entities ?? [],
              pack.content.locations.map(location => location.locationId),
            ).statuses
            const check = (entries: WorldJsonObject, owner: 'public' | 'character', field: string) => {
              for (const key of Object.keys(entries))
                if (!statuses.some(status => status.key === key && status.owner === owner))
                  throw new TypeError(`起点 ${field}：未知状态 ${key}`)
            }
            check(values.public ?? {}, 'public', 'status.public')
            for (const [id, entries] of Object.entries(values.characters ?? {})) {
              if (!characterIds.includes(id)) throw new TypeError(`起点 status.characters：未知角色 ${id}`)
              check(entries, 'character', 'status.characters.' + id)
            }
            return {
              definition: instance.definition,
              hasRoundHook: instance.hasRoundHook,
              moduleDefinitions: instance.moduleDefinitions,
              initialize: ids => {
                const result = structuredClone(instance.initialize(ids)) as {
                  public: Record<string, unknown>
                  characters: Record<string, Record<string, unknown>>
                }
                Object.assign(result.public, values.public ?? {})
                for (const [id, entries] of Object.entries(values.characters ?? {}))
                  Object.assign((result.characters[id] ??= {}), entries)
                return result
              },
              policy: (...args) => instance.policy(...args),
              resolve: input => instance.resolve(input),
              endRound: (...args) => instance.endRound(...args),
              prepareModule: (...args) => instance.prepareModule(...args),
              ...(instance.close ? { close: () => instance.close!() } : {}),
            }
          } catch (error) {
            await instance.close?.()
            throw error
          }
        },
      },
    },
  }
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
  #notes: Omit<LensTraceLine, 'seq'>[] = []
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
    stub.decide = (characterId, input) => {
      this.#asked.add(characterId)
      return this.#decide(characterId, input)
    }
  }

  /** The next plan as a model decision. A plan that cannot run as written abstains and leaves a `plan` line, so
   * nothing the author scripted disappears without a trace. */
  #decide(characterId: string, input: WorldJsonObject): StubDecision {
    const queue = this.#plans.get(characterId)
    const plan = queue?.[0]
    if (!plan) return { decision: 'abstain' }
    const name = this.#name(characterId)
    if (plan.kind === 'perform' && input.canPerform === false) {
      // The follow-up after her own action allows only words; the action waits for her next chance.
      this.#notes.push({
        kind: 'plan',
        actorId: characterId,
        text: `${name} 刚完成一次行动，这次跟进机会只能说话或弃权；计划里的下一个行动留到下一次机会`,
      })
      return { decision: 'abstain' }
    }
    queue.shift()
    if (plan.kind === 'abstain') return { decision: 'abstain' }
    if (plan.kind === 'say') return { decision: 'publish', segments: [{ type: 'speech', text: plan.text }] }
    const offered = ((input.context as WorldJsonObject | undefined)?.affordances ?? []) as Offered
    try {
      const action = matchAction(planSpec(plan), offered)
      return { decision: 'perform', actionType: action.actionType, parameters: action.parameters }
    } catch (cause) {
      if (!(cause instanceof UnmatchedAction)) throw cause
      this.#notes.push({ kind: 'plan', actorId: characterId, text: `${name} 的计划行动这次用不上：${cause.message}` })
      return { decision: 'abstain' }
    }
  }

  /** Plans no chance used up, per character; an unused plan usually means she never got the chance the author meant. */
  leftoverPlans(): Record<string, number> {
    return Object.fromEntries(
      [...this.#plans].filter(([, list]) => list.length > 0).map(([id, list]) => [id, list.length]),
    )
  }

  static async open(
    packPath: string,
    start: LensStart = {},
    composition: WorldComposition = assembleRoleplay(),
  ): Promise<LensSimulation> {
    const source = resolve(packPath)
    sweepStaleLensCopies()
    let root: string
    try {
      root = mkdtempSync(join(tmpdir(), COPY_PREFIX))
    } catch (error) {
      throw new Error(`无法在系统临时目录 ${tmpdir()} 新建推演副本：${message(error)}${FILE_ACCESS_HINT}`, {
        cause: error,
      })
    }
    const copy = join(root, 'pack')
    liveCopies.add(root)
    let stub: StubModel | undefined, runtime: WorldHostRuntime | undefined
    try {
      cpSync(source, copy, { recursive: true, filter: path => relative(source, path) !== LENS_DIRECTORY })
      const pack = (await compileWorldPackSource(
        copy,
        composition.interactionPackages.map(interactionPackageDescription),
      )) as CompiledWorldPackV5
      const generated = new Set(loadRpgContent(copy, pack, composition.rpg)?.activities.map(a => a.key))
      rewriteCopy(copy, pack, start, generated)
      stub = await startStubModel()
      runtime = await WorldHostRuntime.create({
        packPath: copy,
        dataDirectory: join(root, 'data'),
        models: stub.models,
        timeoutMs: 10_000,
        composition: skippingGeneratedAutoStart(
          openingComposition(composition, pack, start),
          start.skipAutoStart ?? [],
        ),
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
      // SQLite says only "unable to open database file"; name the folder so the cause can be found.
      if (FILE_ACCESS.test(message(error)))
        throw new Error(`推演数据目录 ${join(root, 'data')} 无法读写：${message(error)}${FILE_ACCESS_HINT}`, {
          cause: error,
        })
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
    this.#notes = []
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
      ...this.#notes.map(note => ({ ...note, seq: events.at(-1)?.seq ?? before })),
    ]
    const autoStart = this.#runtime.autoStartEvaluations('last')
    const pacing = this.#runtime.pacingDecision()
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
      ...(pacing === null ? {} : { pacing }),
      activated: [...activated],
      perceived: this.perceived(before),
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

  /** Per character, player included, the observations her authorized view holds, as readable text. `after`
   * keeps only those that came from events after that seq. The same view the runtime builds for her model. */
  perceived(after = -1): Record<string, string[]> {
    const store = new WorldStore(join(this.#runtime.dataDirectory, 'world.sqlite'))
    try {
      const address = this.#runtime.address
      const head = store.head(address).headSeq
      const events = store.readEvents(address)
      const builder = new CharacterViewBuilder(store)
      return Object.fromEntries(
        [this.#playerId, ...this.#npcIds].map(characterId => [
          characterId,
          builder
            .rebuildFromEvents(address, characterId as CharacterId, head, events)
            .observations.filter(record => record.sourceSeq > after)
            .sort((left, right) => left.sourceSeq - right.sourceSeq)
            .map(record => this.#observationText(object(record.value).content)),
        ]),
      )
    } finally {
      store.close()
    }
  }

  /** One line for an observation: plain text as is, an action by its actor and result, anything else as JSON. */
  #observationText(content: unknown): string {
    if (typeof content === 'string') return content
    const value = object(content)
    if (value && typeof value === 'object') {
      const actor = value.actorId ?? value.characterId ?? value.speakerId
      const who = typeof actor === 'string' ? this.#name(actor) : undefined
      const failed = value.status === 'rejected' ? '（没有成功）' : ''
      const speech = (value.speech ?? value) as WorldJsonObject
      const segments = speech.segments as { type?: string; text?: string }[] | undefined
      const said = Array.isArray(segments)
        ? segments.map(s => (s.type === 'narration' ? `（${s.text}）` : s.text)).join('')
        : typeof speech.text === 'string'
          ? speech.text
          : undefined
      if (said !== undefined) {
        const to = Array.isArray(speech.addresseeIds) ? speech.addresseeIds.map(id => this.#name(id)) : []
        return `${who ?? '有人'}${to.length ? ` 对 ${to.join('、')}` : ''} 说：${said}${failed}`
      }
      const movement = value.movement as WorldJsonObject | undefined
      if (movement) {
        const mover = this.#name(movement.characterId ?? actor)
        // An observer who stays behind sees only where she left from.
        if (typeof movement.toLocationId === 'string')
          return typeof movement.fromLocationId === 'string'
            ? `${mover} 从 ${this.#name(movement.fromLocationId)} 来到 ${this.#name(movement.toLocationId)}${failed}`
            : `${mover} 来到 ${this.#name(movement.toLocationId)}${failed}`
        return `${mover} 离开了 ${this.#name(movement.fromLocationId)}${failed}`
      }
      if (typeof value.resultDescription === 'string') return `${who ?? '有人'}：${value.resultDescription}${failed}`
    }
    return JSON.stringify(content)
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
        if (object(data.source).kind === 'beat')
          lines.push({
            kind: 'status',
            text: `节拍 ${show(object(data.source).beatId)}：${described.join('；') || '无变化'}`,
            seq,
          })
        else if (object(data.source).kind === 'round')
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
