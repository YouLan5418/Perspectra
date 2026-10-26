import { Context, Service, type Plugin } from '@deepseek-ai/cordis'
import { pathToFileURL } from 'node:url'
import { hostPluginSettings, type HostPluginSettings } from './host-plugin-settings.ts'
import type { FrontendHostServices } from '@harness-world/frontend'
import { validBgmTrack, type FrontendBgmPlugin, type FrontendBgmService } from '@harness-world/frontend'

type SpeechSynthesizer = NonNullable<FrontendHostServices['synthesizeSpeech']>

declare module '@deepseek-ai/cordis' {
  interface Context {
    frontendServices: FrontendServices
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

export interface HostPlugins {
  readonly services: FrontendHostServices
  close(): Promise<void>
}

/** Load only explicitly enabled, trusted modules; failures unwind all mounted effects. */
export async function loadHostPlugins(settings: HostPluginSettings[]): Promise<HostPlugins> {
  const plugins = hostPluginSettings(settings)
  const root = new Context()
  const services = new FrontendServices(root)
  try {
    for (const plugin of plugins) {
      if (!plugin.enabled) continue
      try {
        const module: { default?: unknown } = await import(pathToFileURL(plugin.path).href)
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
        await root.plugin(module.default as Plugin)
      } catch {
        throw new Error(`宿主插件 ${plugin.id} 加载失败，请检查插件文件；也可在设置中停用后重试。`)
      }
    }
    return { services, close: () => root.fiber.dispose() }
  } catch (error) {
    await root.fiber.dispose()
    throw error
  }
}
