import { Context, Service, type Plugin } from '@deepseek-ai/cordis'
import { pathToFileURL } from 'node:url'
import { hostPluginSettings, type HostPluginSettings } from './host-plugin-settings.ts'
import type { InstalledPlugin } from './plugin-requirements.ts'
import { resolvePluginConfig } from './host-plugin-manifest.ts'
import { readPluginManifest } from './plugin-manifest-file.ts'
import type { FrontendHostServices } from '@harness-world/frontend'
import { validBgmTrack, type FrontendBgmPlugin, type FrontendBgmService } from '@harness-world/frontend'
import { HostCapabilities, type CapabilityCatalog } from './host-capabilities.ts'
import { officialSeams, type HostSeams } from './official-bundle.ts'
import { installPluginResolver } from './plugin-resolve.ts'
import {
  HOST_API_VERSION,
  hostApiCompatible,
  type FrontendServicesApi,
  type MemoryInstance,
  type DecisionInstance,
  type DecisionsApi,
  type LlmInstance,
  type LlmSlotApi,
  type RulesApi,
  type RulesInstance,
  type MemorySlotApi,
  type PlayerFeedApi,
  type PlayerFeedEvent,
  type PlayerFeedLine,
  type SchedulerInstance,
  type SchedulerSlotApi,
  type SeamProvider,
} from '@harness-world/plugin-sdk'

// The SDK declares the services on Cordis' Context; the classes below must satisfy its interfaces.
export type { PlayerFeedEvent, PlayerFeedLine }

type SpeechSynthesizer = NonNullable<FrontendHostServices['synthesizeSpeech']>

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
          void Promise.resolve(listener(structuredClone(event))).catch(error =>
            console.error('[玩家可见事件订阅] 监听器出错：', error),
          )
        } catch (error) {
          console.error('[玩家可见事件订阅] 监听器出错：', error)
        }
      })
  }
}

/** One plugin at a time may replace the scheduler; whatever stays empty falls to the official bundle. */
export class SchedulerSlot extends Service implements SchedulerSlotApi {
  current: SeamProvider<SchedulerInstance> | undefined

  constructor(ctx: Context) {
    super(ctx, 'scheduler')
  }

  /** Own the returned disposer with the registering plugin's ctx.effect(). */
  register(provider: SeamProvider<SchedulerInstance>): () => void {
    if (this.current) throw new Error(`调度器已由 ${this.current.id} 提供`)
    this.current = provider
    return () => {
      if (this.current === provider) this.current = undefined
    }
  }
}

export class MemorySlot extends Service implements MemorySlotApi {
  current: SeamProvider<MemoryInstance> | undefined

  constructor(ctx: Context) {
    super(ctx, 'memory')
  }

  /** Own the returned disposer with the registering plugin's ctx.effect(). */
  register(provider: SeamProvider<MemoryInstance>): () => void {
    if (this.current) throw new Error(`记忆已由 ${this.current.id} 提供`)
    this.current = provider
    return () => {
      if (this.current === provider) this.current = undefined
    }
  }
}

export class LlmSlot extends Service implements LlmSlotApi {
  current: SeamProvider<LlmInstance> | undefined

  constructor(ctx: Context) {
    super(ctx, 'llm')
  }

  /** Own the returned disposer with the registering plugin's ctx.effect(). */
  register(provider: SeamProvider<LlmInstance>): () => void {
    if (this.current) throw new Error(`模型通道已由 ${this.current.id} 提供`)
    this.current = provider
    return () => {
      if (this.current === provider) this.current = undefined
    }
  }
}

export class DecisionRegistry extends Service implements DecisionsApi {
  providers: readonly SeamProvider<DecisionInstance>[] = []

  constructor(ctx: Context) {
    super(ctx, 'decisions')
  }

  /** Own the returned disposer with the registering plugin's ctx.effect(). */
  register(provider: SeamProvider<DecisionInstance>): () => void {
    if (this.providers.some(other => other.id === provider.id)) throw new Error(`决策实现 ${provider.id} 已注册`)
    this.providers = [...this.providers, provider]
    return () => {
      this.providers = this.providers.filter(other => other !== provider)
    }
  }
}

export class RuleRegistry extends Service implements RulesApi {
  providers: readonly SeamProvider<RulesInstance>[] = []

  constructor(ctx: Context) {
    super(ctx, 'rules')
  }

  /** Own the returned disposer with the registering plugin's ctx.effect(). */
  register(provider: SeamProvider<RulesInstance>): () => void {
    if (this.providers.some(other => other.id === provider.id)) throw new Error(`规则层 ${provider.id} 已注册`)
    this.providers = [...this.providers, provider]
    return () => {
      this.providers = this.providers.filter(other => other !== provider)
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
   * not fit it. `version`: the module's `hostApi` is missing or needs a newer host. */
  readonly reason: 'manifest' | 'config' | 'import' | 'version' | 'apply'
  /** Host-written and player-facing, for `manifest` and `config` only; never module error text or a value. */
  readonly detail?: string
}

export interface HostPlugins {
  readonly services: FrontendHostServices
  readonly capabilities: CapabilityCatalog
  readonly playerFeed: PlayerFeed
  readonly seams: HostSeams
  readonly skipped: readonly SkippedHostPlugin[]
  /** Each enabled plugin as its manifest states it, in force unless it was skipped. */
  readonly installed: readonly InstalledPlugin[]
  close(): Promise<void>
}

/** Load only explicitly enabled, trusted modules. As in DSH, one plugin's failure is a warning: Cordis
 * unwinds that plugin's effects and the rest keep running. Whether a world can still open is decided
 * by the pack's required capabilities, not here. Invalid settings still fail the whole launch. */
export async function loadHostPlugins(
  settings: HostPluginSettings[],
  /** Per plugin ID, secret field values the launcher read from the credential store. */
  secrets: Readonly<Record<string, Readonly<Record<string, string>>>> = {},
  /** What fills a seam no plugin took and the bundle cannot assemble alone, such as Core with its models.
   * Called only when needed: a player who replaced Core does not need its Python. */
  defaults: { readonly memory?: () => SeamProvider<MemoryInstance> } = {},
): Promise<HostPlugins> {
  const plugins = hostPluginSettings(settings)
  const root = new Context()
  const services = new FrontendServices(root)
  const capabilities = new HostCapabilities(root)
  const playerFeed = new PlayerFeed(root)
  const scheduler = new SchedulerSlot(root)
  const memory = new MemorySlot(root)
  const llm = new LlmSlot(root)
  const decisions = new DecisionRegistry(root)
  const rules = new RuleRegistry(root)
  const skipped: SkippedHostPlugin[] = []
  const llmPlugins = new Set<string>()
  const declared = new Map<string, { id?: string; version: string }>()
  installPluginResolver()
  for (const plugin of plugins) {
    if (!plugin.enabled) continue
    // Manifest and config are checked before the module is imported, so a misconfigured plugin runs no code.
    let config: Readonly<Record<string, string | number | boolean>>
    try {
      const manifest = await readPluginManifest(plugin.path)
      if (manifest?.services.includes('llm')) llmPlugins.add(plugin.id)
      if (manifest)
        declared.set(plugin.id, {
          ...(manifest.id === undefined ? {} : { id: manifest.id }),
          version: manifest.version,
        })
      try {
        config = resolvePluginConfig(manifest, plugin.config, secrets[plugin.id])
      } catch (error) {
        const detail = (error as Error).message
        console.error(`[宿主插件 ${plugin.id}] 配置无效，本次已跳过：${detail}`)
        skipped.push({ id: plugin.id, reason: 'config', detail })
        continue
      }
    } catch (error) {
      const detail = (error as Error).message
      console.error(`[宿主插件 ${plugin.id}] 清单无效，本次已跳过：${detail}`)
      skipped.push({ id: plugin.id, reason: 'manifest', detail })
      continue
    }
    let module: { default?: unknown; hostApi?: unknown }
    try {
      module = await import(pathToFileURL(plugin.path).href)
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
    } catch (error) {
      console.error(`[宿主插件 ${plugin.id}] 导入失败，本次已跳过：`, error)
      skipped.push({ id: plugin.id, reason: 'import' })
      continue
    }
    // Checked before apply, so an incompatible plugin never touches the host services.
    if (!hostApiCompatible(module.hostApi)) {
      console.error(
        `[宿主插件 ${plugin.id}] 需要宿主 API ${typeof module.hostApi === 'string' ? module.hostApi : '（未声明 hostApi）'}，当前宿主 API 为 ${HOST_API_VERSION}，本次已跳过。`,
      )
      skipped.push({ id: plugin.id, reason: 'version' })
      continue
    }
    const fiber = root.plugin(module.default as Plugin, structuredClone(config))
    try {
      await fiber
    } catch (error) {
      console.error(`[宿主插件 ${plugin.id}] 初始化失败，本次已跳过：`, error)
      await fiber.dispose()
      skipped.push({ id: plugin.id, reason: 'apply' })
    }
  }
  const chosenMemory = memory.current ?? defaults.memory?.()
  // The player chose where the story goes. A channel that failed to load must not quietly become the official one.
  const lostChannel = llm.current ? undefined : skipped.find(plugin => llmPlugins.has(plugin.id))
  return {
    services,
    capabilities,
    playerFeed,
    seams: {
      scheduler: scheduler.current ?? officialSeams().scheduler,
      ...(chosenMemory ? { memory: chosenMemory } : {}),
      ...(llm.current ? { llm: llm.current } : {}),
      ...(lostChannel
        ? {
            llm: {
              id: lostChannel.id,
              version: '0.0.0',
              open: async () => {
                throw new Error(
                  `已跳过（${lostChannel.reason}）。为避免对话发到别的模型，世界没有打开；请修复或停用这个插件。`,
                )
              },
            },
          }
        : {}),
      ...(decisions.providers.length ? { decisions: decisions.providers } : {}),
      ...(rules.providers.length ? { rules: rules.providers } : {}),
    },
    skipped,
    installed: plugins
      .filter(plugin => plugin.enabled)
      .map(plugin => ({ ...declared.get(plugin.id), enabled: !skipped.some(item => item.id === plugin.id) })),
    close: () => root.fiber.dispose(),
  }
}
