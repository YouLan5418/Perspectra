import { Context, Service, type Fiber, type Plugin } from '@deepseek-ai/cordis'
import { pathToFileURL } from 'node:url'
import {
  HOST_PLUGIN_FAILURE_TEXT,
  hostPluginLoadFailureMessage,
  hostPluginNativeAllowed,
  hostPluginSettings,
  shouldLoadHostPlugin,
  type HostPluginFailureReason,
  type HostPluginSettings,
} from './host-plugin-settings.ts'
import type { InstalledPlugin } from './plugin-requirements.ts'
import { resolvePluginConfig } from './host-plugin-manifest.ts'
import { readPluginManifest } from './plugin-manifest-file.ts'
import type { FrontendHostServices } from '@perspectra/frontend'
import { validBgmTrack, type FrontendBgmPlugin, type FrontendBgmService } from '@perspectra/frontend'
import { HostCapabilities, type CapabilityCatalog } from './host-capabilities.ts'
import { installOfficialBundle, type HostSeams } from './official-bundle.ts'
import { installPluginResolver } from './plugin-resolve.ts'
import {
  HOST_API_VERSION,
  hostApiCompatible,
  type FrontendServicesApi,
  type MemoryInstance,
  type DecisionInstance,
  type DecisionsApi,
  type LlmInstance,
  type LlmTransportInstance,
  type LlmSlotApi,
  type PluginManifest,
  type RulesApi,
  type RulesInstance,
  type ContentApi,
  type ContentGenerator,
  type MemorySlotApi,
  type PlayerFeedApi,
  type PlayerFeedEvent,
  type PlayerFeedLine,
  type SchedulerInstance,
  type SchedulerSlotApi,
  type WakeupInstance,
  type SeamProvider,
  type CharacterLoopInstance,
  type CharacterLoopSlotApi,
  type KnowledgeInstance,
  type KnowledgeSlotApi,
  type StatusInstance,
  type StatusSlotApi,
  type ActivitiesSlotApi,
  type CommunicationSlotApi,
  type CommunicationInstance,
  type AutonomySlotApi,
  type AutonomyInstance,
  type PacingSlotApi,
  type PacingInstance,
  type DiceSlotApi,
  type DiceInstance,
  type ActivitiesInstance,
} from '@perspectra/sdk'

// Cordis 4.0.1 exposes FiberState only as an ambient const enum in its declarations.
const CORDIS_ACTIVE = 2

// The SDK declares the services on Cordis' Context; the classes below must satisfy its interfaces.
export type { PlayerFeedEvent, PlayerFeedLine }

type SpeechSynthesizer = NonNullable<FrontendHostServices['synthesizeSpeech']>
type CoreServiceName =
  | Exclude<PluginManifest['services'][number], 'frontendServices' | 'playerFeed' | 'capabilities'>
  | 'wakeups'
type RecordCoreRegistration = (ctx: Context, service: CoreServiceName) => void

/** Retain the caller at a core registration point before Cordis unwinds a failed fiber. */
abstract class CoreService extends Service {
  protected readonly recordRegistrationCallback: RecordCoreRegistration

  constructor(ctx: Context, name: CoreServiceName, recordRegistration: RecordCoreRegistration) {
    super(ctx, name)
    this.recordRegistrationCallback = recordRegistration
  }

  protected recordRegistration(): void {
    this.recordRegistrationCallback(this.ctx, this.name as CoreServiceName)
  }
}

/** Read-only: listeners see the player's own transcript after the host projects it, never character
 * Context, private statuses or other characters' views, and nothing they return reaches the world. */
export class PlayerFeed extends Service implements PlayerFeedApi {
  #listeners = new Set<(event: PlayerFeedEvent) => unknown>()
  #published: readonly PlayerFeedLine[] | undefined
  #closed = false

  constructor(ctx: Context) {
    super(ctx, 'playerFeed')
    ctx.effect(() => () => {
      this.#closed = true
      this.#listeners.clear()
    })
  }

  /** Own the returned disposer with the subscribing plugin's ctx.effect(). */
  readonly subscribe = (listener: (event: PlayerFeedEvent) => unknown): (() => void) => {
    if (this.#closed) throw new Error('宿主服务已关闭。')
    if (typeof listener !== 'function') throw new TypeError('订阅须提供监听函数。')
    this.#listeners.add(listener)
    return () => void this.#listeners.delete(listener)
  }

  /** Called by the host after each projection; only changes reach listeners. */
  publish(transcript: readonly PlayerFeedLine[]): void {
    if (this.#closed) return
    const previous = this.#published
    this.#published = structuredClone(transcript)
    let event: PlayerFeedEvent
    if (
      previous &&
      previous.length <= transcript.length &&
      JSON.stringify(previous) === JSON.stringify(transcript.slice(0, previous.length))
    ) {
      if (previous.length === transcript.length) return
      event = { kind: 'append', lines: structuredClone(transcript.slice(previous.length)) }
    } else event = { kind: 'reset', lines: structuredClone(transcript) }
    // Deliver outside the host's projection; a slow or failing listener cannot hold up or break play.
    for (const listener of this.#listeners)
      setImmediate(() => {
        if (!this.#listeners.has(listener)) return
        try {
          void Promise.resolve(listener(structuredClone(event))).catch(() =>
            console.error('[玩家可见事件订阅] 监听器执行失败；原生错误未记录。'),
          )
        } catch {
          console.error('[玩家可见事件订阅] 监听器执行失败；原生错误未记录。')
        }
      })
  }
}

/** One plugin at a time may replace the scheduler; whatever stays empty falls to the official bundle. */
export class SchedulerSlot extends CoreService implements SchedulerSlotApi {
  current: SeamProvider<SchedulerInstance> | undefined
  wakeups: readonly SeamProvider<WakeupInstance>[] = []

  constructor(ctx: Context, recordRegistration: RecordCoreRegistration) {
    super(ctx, 'scheduler', recordRegistration)
  }

  /** Own the returned disposer with the registering plugin's ctx.effect(). */
  register(provider: SeamProvider<SchedulerInstance>): () => void {
    this.recordRegistration()
    if (this.current) throw new Error(`调度器已由 ${this.current.id} 提供`)
    this.current = provider
    return () => {
      if (this.current === provider) this.current = undefined
    }
  }

  registerWakeup(provider: SeamProvider<WakeupInstance>): () => void {
    this.recordRegistrationCallback(this.ctx, 'wakeups')
    if (this.wakeups.some(other => other.id === provider.id)) throw new Error(`唤醒来源 ${provider.id} 已注册`)
    this.wakeups = [...this.wakeups, provider]
    return () => {
      this.wakeups = this.wakeups.filter(other => other !== provider)
    }
  }
}

export class CharacterLoopSlot extends CoreService implements CharacterLoopSlotApi {
  current: SeamProvider<CharacterLoopInstance> | undefined

  constructor(ctx: Context, recordRegistration: RecordCoreRegistration) {
    super(ctx, 'characterLoop', recordRegistration)
  }

  register(provider: SeamProvider<CharacterLoopInstance>): () => void {
    this.recordRegistration()
    if (this.current) throw new Error(`角色循环已由 ${this.current.id} 提供`)
    this.current = provider
    return () => {
      if (this.current === provider) this.current = undefined
    }
  }
}

export class KnowledgeSlot extends CoreService implements KnowledgeSlotApi {
  current: SeamProvider<KnowledgeInstance> | undefined
  constructor(ctx: Context, recordRegistration: RecordCoreRegistration) {
    super(ctx, 'knowledge', recordRegistration)
  }
  register(provider: SeamProvider<KnowledgeInstance>): () => void {
    this.recordRegistration()
    if (this.current) throw new Error(`知识机制已由 ${this.current.id} 提供`)
    this.current = provider
    return () => {
      if (this.current === provider) this.current = undefined
    }
  }
}

export class StatusSlot extends CoreService implements StatusSlotApi {
  current: SeamProvider<StatusInstance> | undefined
  constructor(ctx: Context, recordRegistration: RecordCoreRegistration) {
    super(ctx, 'status', recordRegistration)
  }
  register(provider: SeamProvider<StatusInstance>): () => void {
    this.recordRegistration()
    if (this.current) throw new Error(`状态机制已由 ${this.current.id} 提供`)
    this.current = provider
    return () => {
      if (this.current === provider) this.current = undefined
    }
  }
}

export class ActivitiesSlot extends CoreService implements ActivitiesSlotApi {
  current: SeamProvider<ActivitiesInstance> | undefined
  constructor(ctx: Context, recordRegistration: RecordCoreRegistration) {
    super(ctx, 'activities', recordRegistration)
  }
  register(provider: SeamProvider<ActivitiesInstance>): () => void {
    this.recordRegistration()
    if (this.current) throw new Error(`活动机制已由 ${this.current.id} 提供`)
    this.current = provider
    return () => {
      if (this.current === provider) this.current = undefined
    }
  }
}

export class CommunicationSlot extends CoreService implements CommunicationSlotApi {
  current: SeamProvider<CommunicationInstance> | undefined
  constructor(ctx: Context, recordRegistration: RecordCoreRegistration) {
    super(ctx, 'communication', recordRegistration)
  }
  register(provider: SeamProvider<CommunicationInstance>): () => void {
    this.recordRegistration()
    if (this.current) throw new Error(`通信机制已由 ${this.current.id} 提供`)
    this.current = provider
    return () => {
      if (this.current === provider) this.current = undefined
    }
  }
}

export class AutonomySlot extends CoreService implements AutonomySlotApi {
  current: SeamProvider<AutonomyInstance> | undefined
  constructor(ctx: Context, recordRegistration: RecordCoreRegistration) {
    super(ctx, 'autonomy', recordRegistration)
  }
  register(provider: SeamProvider<AutonomyInstance>): () => void {
    this.recordRegistration()
    if (this.current) throw new Error(`自主策略已由 ${this.current.id} 提供`)
    this.current = provider
    return () => {
      if (this.current === provider) this.current = undefined
    }
  }
}

export class PacingSlot extends CoreService implements PacingSlotApi {
  current: SeamProvider<PacingInstance> | undefined
  constructor(ctx: Context, recordRegistration: RecordCoreRegistration) {
    super(ctx, 'pacing', recordRegistration)
  }
  register(provider: SeamProvider<PacingInstance>): () => void {
    this.recordRegistration()
    if (this.current) throw new Error(`剧情节奏已由 ${this.current.id} 提供`)
    this.current = provider
    return () => {
      if (this.current === provider) this.current = undefined
    }
  }
}

export class DiceSlot extends CoreService implements DiceSlotApi {
  current: SeamProvider<DiceInstance> | undefined
  constructor(ctx: Context, recordRegistration: RecordCoreRegistration) {
    super(ctx, 'dice', recordRegistration)
  }
  register(provider: SeamProvider<DiceInstance>): () => void {
    this.recordRegistration()
    if (this.current) throw new Error(`骰子已由 ${this.current.id} 提供`)
    this.current = provider
    return () => {
      if (this.current === provider) this.current = undefined
    }
  }
}

export class MemorySlot extends CoreService implements MemorySlotApi {
  current: SeamProvider<MemoryInstance> | undefined

  constructor(ctx: Context, recordRegistration: RecordCoreRegistration) {
    super(ctx, 'memory', recordRegistration)
  }

  /** Own the returned disposer with the registering plugin's ctx.effect(). */
  register(provider: SeamProvider<MemoryInstance>): () => void {
    this.recordRegistration()
    if (this.current) throw new Error(`记忆已由 ${this.current.id} 提供`)
    this.current = provider
    return () => {
      if (this.current === provider) this.current = undefined
    }
  }
}

export class LlmSlot extends CoreService implements LlmSlotApi {
  currentTransport: SeamProvider<LlmTransportInstance> | undefined
  current: SeamProvider<LlmInstance> | undefined

  constructor(ctx: Context, recordRegistration: RecordCoreRegistration) {
    super(ctx, 'llm', recordRegistration)
  }

  /** Own the returned disposer with the registering plugin's ctx.effect(). */
  register(provider: SeamProvider<LlmInstance>): () => void {
    this.recordRegistration()
    if (this.current || this.currentTransport)
      throw new Error(`模型通道已由 ${this.current?.id ?? this.currentTransport?.id} 提供`)
    this.current = provider
    return () => {
      if (this.current === provider) this.current = undefined
    }
  }

  registerTransport(provider: SeamProvider<LlmTransportInstance>): () => void {
    this.recordRegistration()
    if (this.current || this.currentTransport)
      throw new Error(`模型通道已由 ${this.current?.id ?? this.currentTransport?.id} 提供`)
    this.currentTransport = provider
    return () => {
      if (this.currentTransport === provider) this.currentTransport = undefined
    }
  }
}

export class DecisionRegistry extends CoreService implements DecisionsApi {
  providers: readonly SeamProvider<DecisionInstance>[] = []

  constructor(ctx: Context, recordRegistration: RecordCoreRegistration) {
    super(ctx, 'decisions', recordRegistration)
  }

  /** Own the returned disposer with the registering plugin's ctx.effect(). */
  register(provider: SeamProvider<DecisionInstance>): () => void {
    this.recordRegistration()
    if (this.providers.some(other => other.id === provider.id)) throw new Error(`决策实现 ${provider.id} 已注册`)
    this.providers = [...this.providers, provider]
    return () => {
      this.providers = this.providers.filter(other => other !== provider)
    }
  }
}

export class RuleRegistry extends CoreService implements RulesApi {
  providers: readonly SeamProvider<RulesInstance>[] = []

  constructor(ctx: Context, recordRegistration: RecordCoreRegistration) {
    super(ctx, 'rules', recordRegistration)
  }

  /** Own the returned disposer with the registering plugin's ctx.effect(). */
  register(provider: SeamProvider<RulesInstance>): () => void {
    this.recordRegistration()
    if (this.providers.some(other => other.id === provider.id)) throw new Error(`规则层 ${provider.id} 已注册`)
    this.providers = [...this.providers, provider]
    return () => {
      this.providers = this.providers.filter(other => other !== provider)
    }
  }
}

export class ContentRegistry extends CoreService implements ContentApi {
  generators: readonly ContentGenerator[] = []

  constructor(ctx: Context, recordRegistration: RecordCoreRegistration) {
    super(ctx, 'content', recordRegistration)
  }

  /** Own the returned disposer with the registering plugin's ctx.effect(). */
  register(generator: ContentGenerator): () => void {
    this.recordRegistration()
    if (this.generators.some(other => other.id === generator.id)) throw new Error(`内容生成插件 ${generator.id} 已注册`)
    const reader = this.generators.find(other => other.configFile === generator.configFile)
    if (reader) throw new Error(`${generator.configFile} 已由内容生成插件 ${reader.id} 读取`)
    this.generators = [...this.generators, generator]
    return () => {
      this.generators = this.generators.filter(other => other !== generator)
    }
  }
}

/** Host-only presentation services; this context does not contain world runtime services. */
export class FrontendServices extends Service implements FrontendHostServices, FrontendServicesApi {
  synthesizeSpeech: SpeechSynthesizer | undefined
  bgm: FrontendBgmService | undefined
  #closed = false
  #unregister: (() => void) | undefined
  #unregisterBgm: (() => void) | undefined

  constructor(ctx: Context) {
    super(ctx, 'frontendServices')
    ctx.effect(() => () => {
      this.#closed = true
      this.#unregister?.()
      this.#unregisterBgm?.()
    })
  }

  /** Own the returned disposer with the registering plugin's ctx.effect(). */
  readonly registerSpeech = (synthesize: SpeechSynthesizer): (() => void) => {
    if (this.#closed) throw new Error('宿主服务已关闭。')
    if (this.synthesizeSpeech) throw new Error('只能加载一个语音合成服务。')
    const lifetime = new AbortController()
    const handler: SpeechSynthesizer = async (input, signal) => {
      const combined = AbortSignal.any([signal, lifetime.signal])
      combined.throwIfAborted()
      const audio = await synthesize(input, combined)
      combined.throwIfAborted()
      return audio
    }
    this.synthesizeSpeech = handler
    const unregister = () => {
      if (this.synthesizeSpeech === handler) this.synthesizeSpeech = undefined
      lifetime.abort()
    }
    this.#unregister = unregister
    return unregister
  }

  /** One curator owns the soundtrack; assets are made public by explicit registration. */
  readonly registerBgm = (plugin: FrontendBgmPlugin): (() => void) => {
    if (this.#closed) throw new Error('Host services are closed')
    if (this.bgm) throw new Error('Only one BGM service can be registered')
    if (
      !Array.isArray(plugin.tracks) ||
      !plugin.tracks.length ||
      plugin.tracks.length > 16 ||
      typeof plugin.selectTrack !== 'function'
    )
      throw new TypeError('BGM requires a selector and 1-16 tracks')
    const tracks = new Map<string, FrontendBgmPlugin['tracks'][number]>()
    for (const track of plugin.tracks) {
      if (!validBgmTrack(track) || tracks.has(track.id)) throw new TypeError('Invalid or duplicate BGM track')
      tracks.set(track.id, { ...track, bytes: new Uint8Array(track.bytes) })
    }
    const lifetime = new AbortController()
    const service: FrontendBgmService = {
      selectTrack: async (input, signal) => {
        const combined = AbortSignal.any([signal, lifetime.signal])
        combined.throwIfAborted()
        const id = await plugin.selectTrack(input, combined)
        combined.throwIfAborted()
        if (id === null) return null
        const track = tracks.get(id)
        if (!track) throw new TypeError('BGM selector returned an unregistered track')
        return { id: track.id, title: track.title }
      },
      getTrack: id => {
        lifetime.signal.throwIfAborted()
        return tracks.get(id)
      },
    }
    this.bgm = service
    const unregister = () => {
      if (this.bgm === service) this.bgm = undefined
      lifetime.abort()
      tracks.clear()
    }
    this.#unregisterBgm = unregister
    return unregister
  }
}

/** Why an enabled plugin did not run. Module error text stays in the host log, never in this record. */
export interface SkippedHostPlugin {
  readonly id: string
  /** `manifest`: the sidecar `.plugin.json` is unreadable or invalid. `config`: saved values or secrets do
   * not fit it. `permission`: the saved record asked to load without native execution consent. `version`:
   * the module's `hostApi` is missing or needs a newer host. */
  readonly reason: HostPluginFailureReason
  /** Host-written manifest, config or dependency diagnostic; never module error text or config values. */
  readonly detail?: string
}

export interface HostPlugins {
  readonly services: FrontendHostServices
  readonly capabilities: CapabilityCatalog
  readonly playerFeed: PlayerFeed
  readonly seams: HostSeams
  readonly skipped: readonly SkippedHostPlugin[]
  /** Each allowed and enabled plugin as its manifest states it; `enabled` is false when it was not loaded. */
  readonly installed: readonly InstalledPlugin[]
  close(): Promise<void>
}

export interface HostPluginLoadOptions {
  /** Gameplay native modules require an explicit pack selection; provider/peripheral choices stay host-owned. */
  readonly gameplayIds?: readonly string[]
  /** A module import or initial apply that exceeds this limit is treated as a failure. */
  readonly initializationTimeoutMs?: number
  /** Startup failure waits at most this long for already-loaded factories to unwind. */
  readonly cleanupTimeoutMs?: number
}

const DEFAULT_INITIALIZATION_TIMEOUT_MS = 10_000
const DEFAULT_CLEANUP_TIMEOUT_MS = 2_000
const OPTIONAL_FAILURE_SERVICES = new Set<PluginManifest['services'][number]>([
  'frontendServices',
  'playerFeed',
  'capabilities',
])
/** Host-generated error with no native exception message or cause attached. */
export class HostPluginLoadError extends Error {
  constructor(
    readonly pluginId: string,
    readonly reason: SkippedHostPlugin['reason'],
    readonly detail?: string,
  ) {
    super(hostPluginLoadFailureMessage(pluginId, reason, detail))
    this.name = 'HostPluginLoadError'
  }
}

function optionalHostPlugin(manifest: PluginManifest | undefined): boolean {
  return (
    manifest !== undefined &&
    manifest.services.length > 0 &&
    manifest.services.every(service => OPTIONAL_FAILURE_SERVICES.has(service))
  )
}

function timeoutMs(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback
}

async function withinDeadline<T>(work: PromiseLike<T>, milliseconds: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      Promise.resolve(work),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), milliseconds)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Load only explicitly allowed, enabled, trusted modules. Explicit mechanisms and gameplay providers fail
 * closed. A parsed manifest may classify a failure as peripheral, in which case it is skipped and reported. */
export async function loadHostPlugins(
  settings: HostPluginSettings[],
  /** Per plugin ID, secret field values the launcher read from the credential store. */
  secrets: Readonly<Record<string, Readonly<Record<string, string>>>> = {},
  /** What fills a seam no plugin took and the bundle cannot assemble alone, such as Core with its models.
   * Called only when needed, so a replacement provider does not initialize the bundled default. */
  defaults: { readonly memory?: () => SeamProvider<MemoryInstance> } = {},
  options: HostPluginLoadOptions = {},
): Promise<HostPlugins> {
  const plugins = hostPluginSettings(settings)
  const unallowedSelection = plugins.find(plugin => plugin.enabled && !hostPluginNativeAllowed(plugin))
  if (unallowedSelection)
    throw new HostPluginLoadError(unallowedSelection.id, 'permission', '请先在插件设置中允许在本机执行')
  const initializationTimeoutMs = timeoutMs(options.initializationTimeoutMs, DEFAULT_INITIALIZATION_TIMEOUT_MS)
  const cleanupTimeoutMs = timeoutMs(options.cleanupTimeoutMs, DEFAULT_CLEANUP_TIMEOUT_MS)
  const root = new Context()
  // Cordis reports callback failures through ctx.logger before rejecting. Keep
  // native exceptions out of its diagnostic buffer; the host emits a closed
  // failure record with no native message or cause.
  root.logger.exporters.clear()
  // Cordis returns a promise wrapper inheriting one Fiber, then clears the
  // Fiber uid when a failed apply is disposed. Keep the registration audit
  // keyed by the uid captured before awaiting the wrapper.
  const coreRegistrations = new Map<number, Set<CoreServiceName>>()
  const recordCoreRegistration: RecordCoreRegistration = (ctx, service) => {
    let owner = ctx.fiber
    const visited = new Set<number>()
    while (owner.uid !== null && !visited.has(owner.uid)) {
      visited.add(owner.uid)
      const registrations = coreRegistrations.get(owner.uid) ?? new Set<CoreServiceName>()
      registrations.add(service)
      coreRegistrations.set(owner.uid, registrations)
      owner = owner.parent.fiber
    }
  }
  const ownsCoreRegistration = (uid: number) => coreRegistrations.has(uid)
  const services = new FrontendServices(root)
  const capabilities = new HostCapabilities(root)
  const playerFeed = new PlayerFeed(root)
  const scheduler = new SchedulerSlot(root, recordCoreRegistration)
  const characterLoop = new CharacterLoopSlot(root, recordCoreRegistration)
  const knowledge = new KnowledgeSlot(root, recordCoreRegistration)
  const status = new StatusSlot(root, recordCoreRegistration)
  const activities = new ActivitiesSlot(root, recordCoreRegistration)
  const communication = new CommunicationSlot(root, recordCoreRegistration)
  const autonomy = new AutonomySlot(root, recordCoreRegistration)
  const pacing = new PacingSlot(root, recordCoreRegistration)
  const dice = new DiceSlot(root, recordCoreRegistration)
  const memory = new MemorySlot(root, recordCoreRegistration)
  const llm = new LlmSlot(root, recordCoreRegistration)
  const decisions = new DecisionRegistry(root, recordCoreRegistration)
  const rules = new RuleRegistry(root, recordCoreRegistration)
  const content = new ContentRegistry(root, recordCoreRegistration)
  const skipped: SkippedHostPlugin[] = []
  const declared = new Map<string, { id?: string; version: string }>()
  const candidates = plugins.filter(plugin => shouldLoadHostPlugin(plugin))
  const loaded = new Set<string>()
  const pending: {
    id: string
    optional: boolean
    uid: number
    fiber: Fiber & PromiseLike<Fiber>
  }[] = []
  let closing: Promise<void> | undefined
  const closeRoot = async (propagate: boolean): Promise<void> => {
    closing ??= root.fiber.dispose()
    try {
      await withinDeadline(closing, cleanupTimeoutMs, '宿主插件清理超时。')
    } catch {
      console.error('[宿主插件] 清理未能在期限内完成，继续当前流程。')
      if (propagate) throw new Error('宿主插件清理未完成。')
    } finally {
      coreRegistrations.clear()
    }
  }
  const skipPeripheral = async (
    id: string,
    reason: SkippedHostPlugin['reason'],
    detail: string | undefined,
    fiber?: Fiber & PromiseLike<Fiber>,
  ): Promise<void> => {
    if (fiber) {
      try {
        await withinDeadline(fiber.dispose(), cleanupTimeoutMs, '外围插件清理超时。')
      } catch {
        console.error(`[宿主插件 ${id}] 清理未能在期限内完成。`)
      }
      const index = pending.findIndex(entry => entry.fiber === fiber)
      if (index >= 0) pending.splice(index, 1)
    }
    const message = `[宿主插件 ${id}] ${HOST_PLUGIN_FAILURE_TEXT[reason]}${detail ? `：${detail}` : ''}；外围功能已跳过。`
    console.warn(message)
    skipped.push({ id, reason, ...(detail ? { detail } : {}) })
  }
  installPluginResolver()
  try {
    for (const plugin of candidates) {
      // Manifest and config are checked before the module is imported, so a misconfigured plugin runs no code.
      let manifest: PluginManifest | undefined
      try {
        manifest = await readPluginManifest(plugin.path)
      } catch (error) {
        const detail = (error as Error).message
        throw new HostPluginLoadError(plugin.id, 'manifest', detail)
      }
      if (options.gameplayIds && !manifest?.id)
        throw new HostPluginLoadError(plugin.id, 'manifest', '世界包入口需要有稳定 ID 的静态插件清单')
      if (manifest) {
        declared.set(plugin.id, {
          ...(manifest.id === undefined ? {} : { id: manifest.id }),
          version: manifest.version,
        })
      }
      if (
        options.gameplayIds &&
        manifest?.services.some(service => ['rules', 'content'].includes(service)) &&
        (!manifest.id || !options.gameplayIds.includes(manifest.id))
      )
        continue
      const optional = optionalHostPlugin(manifest)
      let config: Readonly<Record<string, string | number | boolean>>
      try {
        config = resolvePluginConfig(manifest, plugin.config, secrets[plugin.id])
      } catch (error) {
        const detail = (error as Error).message
        if (optional) {
          await skipPeripheral(plugin.id, 'config', detail)
          continue
        }
        throw new HostPluginLoadError(plugin.id, 'config', detail)
      }
      let module: { default?: unknown; hostApi?: unknown }
      try {
        module = await withinDeadline(import(pathToFileURL(plugin.path).href), initializationTimeoutMs, '导入超时。')
        if (
          typeof module.default !== 'function' &&
          !(
            module.default &&
            typeof module.default === 'object' &&
            'apply' in module.default &&
            typeof module.default.apply === 'function'
          )
        )
          throw new TypeError('缺少 Cordis 默认导出')
      } catch {
        if (optional) {
          await skipPeripheral(plugin.id, 'import', undefined)
          continue
        }
        throw new HostPluginLoadError(plugin.id, 'import')
      }
      // Checked before apply, so an incompatible plugin never touches the host services.
      if (!hostApiCompatible(module.hostApi)) {
        const declaredApi =
          typeof module.hostApi === 'string' && /^(?:0|[1-9]\d{0,3})\.(?:0|[1-9]\d{0,3})$/u.test(module.hostApi)
            ? module.hostApi
            : '未声明或格式无效'
        const detail = `需要宿主 API ${declaredApi}，当前为 ${HOST_API_VERSION}。`
        if (optional) {
          await skipPeripheral(plugin.id, 'version', detail)
          continue
        }
        throw new HostPluginLoadError(plugin.id, 'version', detail)
      }
      let fiber: (Fiber & PromiseLike<Fiber>) | undefined
      let fiberUid: number | undefined
      try {
        fiber = root.plugin(module.default as Plugin, structuredClone(config))
        fiberUid = fiber.uid ?? undefined
        if (fiberUid === undefined) throw new Error('插件实例未获得有效归属。')
        pending.push({ id: plugin.id, optional, uid: fiberUid, fiber })
        // Cordis await settles PENDING immediately; it does not wait for a missing inject service.
        // Finish active setup in settings order so an async first registration retains its priority.
        await withinDeadline(fiber.await(), initializationTimeoutMs, '初始化超时。')
      } catch {
        if (optional && fiber && fiberUid !== undefined && !ownsCoreRegistration(fiberUid)) {
          await skipPeripheral(plugin.id, 'apply', undefined, fiber)
          continue
        }
        throw new HostPluginLoadError(plugin.id, 'apply')
      }
    }
    // Recheck readiness after all registrations: later services may have activated earlier consumers.
    const settle = async () => {
      for (const entry of pending.slice()) {
        try {
          await withinDeadline(entry.fiber, initializationTimeoutMs, '初始化超时。')
        } catch {
          if (entry.optional && !ownsCoreRegistration(entry.uid)) {
            await skipPeripheral(entry.id, 'apply', undefined, entry.fiber)
            continue
          }
          throw new HostPluginLoadError(entry.id, 'apply')
        }
      }
    }
    await settle()
    // Cordis owns dependency readiness. Report stable inactive fibers instead of claiming they ran.
    while (pending.some(entry => entry.fiber.state !== CORDIS_ACTIVE)) {
      for (const entry of pending.slice()) {
        if (entry.fiber.state === CORDIS_ACTIVE) continue
        const missing = Object.keys(entry.fiber.inject).filter(name => !entry.fiber.ctx.get(name, false))
        const detail = `缺少服务或存在循环依赖：${missing.join('、') || '服务未就绪'}`
        if (entry.optional && !ownsCoreRegistration(entry.uid)) {
          await skipPeripheral(entry.id, 'apply', detail, entry.fiber)
          continue
        }
        throw new HostPluginLoadError(entry.id, 'apply', detail)
      }
      await settle()
    }
    if (options.gameplayIds) {
      for (const entry of pending) {
        const registrations = coreRegistrations.get(entry.uid)
        if (
          registrations &&
          ['rules', 'content', 'wakeups'].some(service => registrations.has(service as CoreServiceName))
        ) {
          const id = declared.get(entry.id)?.id
          if (!id || !options.gameplayIds.includes(id))
            throw new HostPluginLoadError(entry.id, 'apply', '玩法注册未在游戏包 plugins 中声明')
        }
      }
    }
    installOfficialBundle(root, defaults.memory)
  } catch (error) {
    await closeRoot(false)
    if (error instanceof HostPluginLoadError) throw error
    throw new HostPluginLoadError('未知', 'apply')
  }
  for (const entry of pending) loaded.add(entry.id)
  skipped.sort(
    (a, b) => plugins.findIndex(plugin => plugin.id === a.id) - plugins.findIndex(plugin => plugin.id === b.id),
  )
  const chosenMemory = memory.current
  return {
    services,
    capabilities,
    playerFeed,
    seams: {
      knowledge: knowledge.current!,
      status: status.current!,
      activities: activities.current!,
      communication: communication.current!,
      autonomy: autonomy.current!,
      pacing: pacing.current!,
      dice: dice.current!,
      scheduler: scheduler.current!,
      ...(scheduler.wakeups.length ? { wakeups: scheduler.wakeups } : {}),
      characterLoop: characterLoop.current!,
      ...(chosenMemory ? { memory: chosenMemory } : {}),
      ...(llm.current ? { llm: llm.current } : {}),
      ...(llm.currentTransport ? { llmTransport: llm.currentTransport } : {}),
      ...(decisions.providers.length ? { decisions: decisions.providers } : {}),
      ...(rules.providers.length ? { rules: rules.providers } : {}),
      content: content.generators,
      packPlugins: candidates
        .filter(plugin => loaded.has(plugin.id))
        .flatMap(plugin => {
          const entry = declared.get(plugin.id)
          return entry?.id ? [{ id: entry.id, version: entry.version }] : []
        }),
    },
    skipped,
    installed: candidates.map(plugin => ({
      ...declared.get(plugin.id),
      nativeAllowed: true,
      enabled: loaded.has(plugin.id),
    })),
    close: () => closeRoot(true),
  }
}
