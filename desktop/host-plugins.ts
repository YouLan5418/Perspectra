import { Context, Service, type Plugin } from '@deepseek-ai/cordis'
import { pathToFileURL } from 'node:url'
import { hostPluginSettings, type HostPluginSettings } from './host-plugin-settings.ts'
import type { FrontendHostServices } from '@harness-world/frontend'
import { validBgmTrack, type FrontendBgmPlugin, type FrontendBgmService } from '@harness-world/frontend'
import { HostCapabilities, type CapabilityCatalog } from './host-capabilities.ts'

type SpeechSynthesizer = NonNullable<FrontendHostServices['synthesizeSpeech']>

declare module '@deepseek-ai/cordis' {
  interface Context {
    frontendServices: FrontendServices
    capabilities: HostCapabilities
  }
}

/** Host-only presentation services; this context does not contain world runtime services. */
export class FrontendServices extends Service implements FrontendHostServices {
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
  readonly reason: 'import' | 'apply'
}

export interface HostPlugins {
  readonly services: FrontendHostServices
  readonly capabilities: CapabilityCatalog
  readonly skipped: readonly SkippedHostPlugin[]
  close(): Promise<void>
}

/** Load only explicitly enabled, trusted modules. As in DSH, one plugin's failure is a warning: Cordis
 * unwinds that plugin's effects and the rest keep running. Whether a world can still open is decided
 * by the pack's required capabilities, not here. Invalid settings still fail the whole launch. */
export async function loadHostPlugins(settings: HostPluginSettings[]): Promise<HostPlugins> {
  const plugins = hostPluginSettings(settings)
  const root = new Context()
  const services = new FrontendServices(root)
  const capabilities = new HostCapabilities(root)
  const skipped: SkippedHostPlugin[] = []
  for (const plugin of plugins) {
    if (!plugin.enabled) continue
    let module: { default?: unknown }
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
    const fiber = root.plugin(module.default as Plugin)
    try {
      await fiber
    } catch (error) {
      console.error(`[宿主插件 ${plugin.id}] 初始化失败，本次已跳过：`, error)
      await fiber.dispose()
      skipped.push({ id: plugin.id, reason: 'apply' })
    }
  }
  return { services, capabilities, skipped, close: () => root.fiber.dispose() }
}
