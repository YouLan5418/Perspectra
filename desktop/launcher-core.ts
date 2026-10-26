import {
  playSettings,
  readingPreferences,
  DEFAULT_READING,
  audioPreferences,
  DEFAULT_AUDIO,
  launcherPreferencesFromStage,
  type PlaySettings,
  type ReadingPreferences,
  type AudioPreferences,
} from './play-settings.ts'
import { hostPluginSettings, pluginSecretValues, type HostPluginSettings } from './host-plugin-settings.ts'
import { savedPluginConfig } from './host-plugin-manifest.ts'
import { readPluginManifest } from './plugin-manifest-file.ts'
import type { PluginManifest } from '@harness-world/plugin-sdk'
import {
  providerEndpoint,
  providerHeaders,
  nativeMessages,
  nativePayload,
  importPresets,
  exportPresets,
  namedPreset,
  rolePreset,
  assignPackRolePresets,
  type PackRolePresets,
  type RolePreset,
} from '@harness-world/provider-chat'
import { exportStoryNode, importStoryNode } from './story-share.ts'
import { readStoryNodes, restoreStoryNode, storyId } from './story-nodes.ts'
import { ModelPresets, packPreset, packRolePresets, presetChoice } from './model-presets.ts'
import {
  brokenModels,
  instanceModels,
  listModels,
  migrateModels,
  modelConnection,
  modelEnvironment,
  storedModels,
  type InstanceModels,
  type ModelConnection,
} from './model-connections.ts'
import { FrontendAuthorizations, type FrontendIdentity } from './frontend-authorization.ts'
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile, access, copyFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { compileWorldPackSource, type CompiledWorldPackV5 } from '@harness-world/world-pack'
import { interactionPackageDescription } from '@harness-world/contracts'
import { createInstalledInteractionPackages } from '@harness-world/interactions-basic'
import { preflightSave } from './save-preflight.ts'
import { loadPackWeb } from './host/pack-frontend.ts'
import { corePythonExecutable } from './host/memory/python-worker.ts'

interface Pack {
  id: string
  version: string
  title: string
  path: string
  hash: string
}
interface Storyline {
  id: string
  name: string
  parentStorylineId: string | null
  parentNodeId: string | null
}
interface Instance {
  currentStorylineId: string
  storylines: Storyline[]
  id: string
  packageId: string
  packageVersion: string
  packHash: string
  name: string
  lastPlayedAt: string | null
  models?: InstanceModels
}
interface Index {
  packs: Pack[]
  instances: Instance[]
  connections: ModelConnection[]
  lastModels?: InstanceModels
  preferences: {
    largeText: boolean
    theme?: 'system' | 'light' | 'dark'
    reading?: ReadingPreferences
    audio?: AudioPreferences
    hostPlugins?: HostPluginSettings[]
  }
  playSettings?: Record<string, PlaySettings>
}
function packCharacters(pack: CompiledWorldPackV5) {
  const player = pack.content.playerSlots[0]?.characterId
  return pack.content.characters
    .filter(c => c.characterId !== player && c.controllerClass !== 'manual' && (c.lifecycle ?? 'active') === 'active')
    .map(c => ({ id: c.characterId, name: c.displayName }))
}
/** The package's role-presets.json may only name characters the Launcher can map in its instances. */
function checkBundled(characters: readonly { id: string }[], bundled: PackRolePresets): PackRolePresets {
  const ids = new Set(characters.map(c => c.id))
  if ([...Object.keys(bundled.characters), ...bundled.groups.flatMap(g => g.members)].some(id => !ids.has(id)))
    throw new Error('游戏包 role-presets.json 引用了此包之外或不可调用的角色。')
  return bundled
}
/** 世界包根目录的约定封面；只供启动器展示，不进入编译产物与世界事实。 */
const COVER_FILES = [
  ['cover.webp', 'image/webp'],
  ['cover.png', 'image/png'],
  ['cover.jpg', 'image/jpeg'],
  ['cover.jpeg', 'image/jpeg'],
] as const
const COVER_LIMIT = 4 * 1024 * 1024
async function packCover(path: string): Promise<string | null> {
  for (const [name, type] of COVER_FILES) {
    try {
      const bytes = await readFile(join(path, name))
      return bytes.length > COVER_LIMIT ? null : 'data:' + type + ';base64,' + bytes.toString('base64')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null
    }
  }
  return null
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('请求无效。')
  return value as Record<string, unknown>
}
export interface SkippedPlugin {
  id: string
  reason: 'manifest' | 'config' | 'import' | 'version' | 'apply'
  /** Host-written text for manifest and config problems, e.g. which field to fill in. */
  detail?: string
}
const SKIP_REASONS = ['manifest', 'config', 'import', 'version', 'apply']
/** What the settings page shows about a plugin file: its manifest, that it has none, or why it is unreadable. */
export type PluginManifestInfo = { manifest: PluginManifest } | { missing: true } | { error: string }
async function inspectPlugin(path: string): Promise<PluginManifestInfo> {
  try {
    const manifest = await readPluginManifest(path)
    return manifest ? { manifest } : { missing: true }
  } catch (error) {
    return { error: (error as Error).message }
  }
}
/** The game process reports skipped plugins by ID and reason only; anything malformed is dropped. */
function skippedPlugins(value: unknown): SkippedPlugin[] {
  if (!Array.isArray(value)) return []
  return value
    .filter(
      (item): item is SkippedPlugin =>
        !!item &&
        typeof item === 'object' &&
        typeof item.id === 'string' &&
        item.id.length > 0 &&
        item.id.length <= 64 &&
        SKIP_REASONS.includes(item.reason),
    )
    .slice(0, 16)
    .map(item => ({
      id: item.id,
      reason: item.reason,
      ...(typeof item.detail === 'string' && item.detail.length <= 300 ? { detail: item.detail } : {}),
    }))
}
/** A pack whose required capability is missing names it, so the player knows which plugin to fix. */
function startupFailure(data: Record<string, unknown>): string {
  const skipped = skippedPlugins(data.skippedPlugins).map(plugin => plugin.id)
  const missing =
    typeof data.missingCapability === 'string' && /^[a-z][a-z0-9-]{0,40}@[^\s]{1,80}$/u.test(data.missingCapability)
      ? data.missingCapability
      : undefined
  const skippedNote = skipped.length ? `本次加载失败已跳过的插件：${skipped.join('、')}。` : ''
  if (missing)
    return `世界包需要宿主能力 ${missing}，但没有已启用的插件提供它。${skippedNote}请在设置中启用或修复对应插件后重试。`
  if (skipped.length) return `Core 初始化失败。${skippedNote}请检查包、存档、本机记忆依赖与这些插件文件。`
  return 'Core 初始化失败；请检查包、存档及本机记忆依赖。'
}
/** Saved values must fit the manifest beside each plugin file; secrets are refused here (credential store only). */
async function checkedPluginConfig(plugins: HostPluginSettings[]): Promise<HostPluginSettings[]> {
  for (const plugin of plugins) {
    if (plugin.config === undefined || !Object.keys(plugin.config).length) continue
    const info = await inspectPlugin(plugin.path)
    if ('error' in info) throw new TypeError(`插件 ${plugin.id}：${info.error}`)
    try {
      savedPluginConfig('manifest' in info ? info.manifest : undefined, plugin.config)
    } catch (error) {
      throw new TypeError(`插件 ${plugin.id}：${(error as Error).message}`)
    }
  }
  return plugins
}
function text(value: unknown, label: string, max = 4096): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(label + '无效。')
  return value.trim()
}
/** Keys arrive per request from the Tauri credential store and are never kept here. */
function apiKeys(value: unknown): Record<string, string> {
  if (value === undefined) return {}
  const data = object(value)
  for (const key of Object.values(data))
    if (typeof key !== 'string' || key.length > 8192) throw new Error('API Key 无效。')
  return data as Record<string, string>
}
async function terminate(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>(done => {
    const timer = setTimeout(() => {
      if (process.platform === 'win32' && child.pid) {
        const kill = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
        kill.once('close', () => done())
        kill.once('error', () => {
          child.kill()
          done()
        })
      } else {
        child.kill('SIGKILL')
        done()
      }
    }, 10_000)
    child.once('exit', () => {
      clearTimeout(timer)
      done()
    })
    if (child.connected) child.send({ type: 'shutdown' }, () => {})
    else child.kill()
  })
}

/** Local launcher metadata and child ownership only; world state stays in the existing runtime. */
export class LauncherCore {
  #index: Index = { packs: [], instances: [], connections: [], preferences: { largeText: false } }
  #child: ChildProcess | undefined
  #active: { instanceId: string; url: string; frontendMode: 'sandbox' | 'trusted' } | undefined
  #error = ''
  /** From the most recent game launch, kept after it stops so settings can still point at the plugin. */
  #skippedPlugins: SkippedPlugin[] = []
  /** Per saved plugin ID, re-read when settings are saved or a game starts. */
  #pluginManifests: Record<string, PluginManifestInfo> = {}
  async #readPluginManifests(): Promise<void> {
    const plugins = (this.#index.preferences.hostPlugins ?? []).filter(plugin => plugin.path)
    this.#pluginManifests = Object.fromEntries(
      await Promise.all(plugins.map(async plugin => [plugin.id, await inspectPlugin(plugin.path)] as const)),
    )
  }
  #frontends: Record<
    string,
    { kind: 'default' | 'custom'; mode: 'sandbox' | 'trusted'; digest: string; capabilities: string[] }
  > = {}
  #authorizations(): FrontendAuthorizations {
    return new FrontendAuthorizations(this.root)
  }
  async #inspect(instance: Instance) {
    const pack = this.#index.packs.find(p => p.id === instance.packageId)!
    const web = await loadPackWeb(pack.path)
    const identity: FrontendIdentity = {
      instanceId: instance.id,
      packageId: pack.id,
      packageVersion: pack.version,
      digest: web?.digest ?? '',
    }
    const mode = web && (await this.#authorizations().valid(identity)) ? 'trusted' : 'sandbox'
    this.#frontends[instance.id] = {
      kind: web ? 'custom' : 'default',
      mode,
      digest: identity.digest,
      capabilities: web?.manifest.capabilities ?? [],
    }
    if (mode !== 'trusted' && this.#active?.instanceId === instance.id && this.#active.frontendMode === 'trusted')
      await this.#revokeRunning(instance.id)
    return { identity, web, mode }
  }
  async #revokeRunning(instanceId: string): Promise<void> {
    if (this.#active?.instanceId !== instanceId || !this.#child) return
    const child = this.#child
    try {
      await new Promise<void>((done, reject) => {
        const timer = setTimeout(() => finish(new Error('Core 未确认前端撤销。')), 5000)
        const finish = (error?: Error) => {
          clearTimeout(timer)
          child.off('message', message)
          child.off('exit', exited)
          if (error) reject(error)
          else done()
        }
        const message = (value: unknown) => {
          if (value && typeof value === 'object' && 'type' in value && value.type === 'frontend-revoked') finish()
        }
        const exited = () => finish()
        child.on('message', message)
        child.once('exit', exited)
        child.send({ type: 'frontend-revoke' }, error => {
          if (error) finish(new Error('撤销通知失败。'))
        })
      })
      if (this.#active) this.#active.frontendMode = 'sandbox'
    } catch {
      await this.stop()
      throw new Error('授权已撤销，但 Core 未确认切换；已结束游戏，已提交进度保留。')
    }
  }
  #characters: Record<string, { id: string; name: string }[]> = {}
  #presets: ModelPresets
  #recommended: Record<string, RolePreset> = {}
  #bundled: Record<string, PackRolePresets> = {}
  #setBundled(packId: string, bundled: PackRolePresets | undefined) {
    if (bundled) this.#bundled[packId] = checkBundled(this.#characters[packId] ?? [], bundled)
    else delete this.#bundled[packId]
  }
  #details: Record<string, { description: string; hasCover: boolean; error?: string }> = {}
  #covers: Record<string, string> = {}
  async #describe(pack: Pack, compiled: CompiledWorldPackV5) {
    const cover = await packCover(pack.path)
    if (cover) this.#covers[pack.id] = cover
    else delete this.#covers[pack.id]
    this.#details[pack.id] = { description: compiled.content.world.description ?? '', hasCover: cover !== null }
  }
  constructor(
    readonly repository: string,
    readonly root: string,
  ) {
    this.#presets = new ModelPresets(root)
  }
  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true })
    let migrated = false
    try {
      const parsed = object(JSON.parse(await readFile(join(this.root, 'launcher.json'), 'utf8')))
      if (!Array.isArray(parsed.packs) || !Array.isArray(parsed.instances)) throw new Error('index')
      migrated = parsed.connections === undefined && parsed.defaults !== undefined
      const migration = migrated ? migrateModels(parsed) : undefined
      const connections = migration
        ? migration.connections
        : (Array.isArray(parsed.connections) ? parsed.connections : []).map(modelConnection)
      if (new Set(connections.map(c => c.id)).size !== connections.length) throw new Error('connections')
      const packs = parsed.packs.map(value => {
        const p = object(value)
        return {
          id: text(p.id, '包 ID'),
          version: text(p.version, '包版本'),
          title: text(p.title, '包名称'),
          path: text(p.path, '包路径'),
          hash: text(p.hash, '包 Hash'),
        }
      })
      const instances = parsed.instances.map(value => {
        const i = object(value)
        const id = text(i.id, '实例 ID', 40)
        if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('instance id')
        if (!(i.lastPlayedAt === null || typeof i.lastPlayedAt === 'string')) throw new Error('lastPlayedAt')
        const lines: Storyline[] =
          i.storylines === undefined
            ? [{ id: 'main', name: '主故事线', parentStorylineId: null, parentNodeId: null }]
            : (Array.isArray(i.storylines) ? i.storylines : []).map(value => {
                const line = object(value),
                  lineId = line.id === 'main' ? 'main' : storyId(line.id)
                return {
                  id: lineId,
                  name: text(line.name, '故事线名称', 80),
                  parentStorylineId:
                    line.parentStorylineId === null
                      ? null
                      : line.parentStorylineId === 'main'
                        ? 'main'
                        : storyId(line.parentStorylineId),
                  parentNodeId: line.parentNodeId === null ? null : storyId(line.parentNodeId),
                }
              })
        const currentStorylineId =
          i.currentStorylineId === undefined ? 'main' : text(i.currentStorylineId, '故事线 ID', 40)
        if (
          !lines.length ||
          new Set(lines.map(l => l.id)).size !== lines.length ||
          !lines.some(l => l.id === currentStorylineId) ||
          lines.some(l => l.parentStorylineId !== null && !lines.some(p => p.id === l.parentStorylineId))
        )
          throw new Error('storyline references')
        const instance: Instance = {
          currentStorylineId,
          storylines: lines,
          id,
          packageId: text(i.packageId, '包 ID'),
          packageVersion: text(i.packageVersion, '包版本'),
          packHash: text(i.packHash, '包 Hash'),
          name: text(i.name, '实例名称', 80),
          lastPlayedAt: i.lastPlayedAt as string | null,
        }
        const models = migration
          ? migration.instanceModels[id]
          : i.models === undefined
            ? undefined
            : storedModels(i.models)
        return models === undefined ? instance : { ...instance, models }
      })
      const lastModels = migration
        ? migration.lastModels
        : parsed.lastModels === undefined
          ? undefined
          : storedModels(parsed.lastModels)
      if (
        new Set(packs.map(p => p.id)).size !== packs.length ||
        new Set(instances.map(i => i.id)).size !== instances.length ||
        instances.some(i => !packs.some(p => p.id === i.packageId))
      )
        throw new Error('index references')
      const preferences = parsed.preferences === undefined ? { largeText: false } : object(parsed.preferences)
      if (
        preferences.theme !== undefined &&
        (typeof preferences.theme !== 'string' || !['system', 'light', 'dark'].includes(preferences.theme))
      )
        throw new Error('theme')
      if (typeof preferences.largeText !== 'boolean') throw new Error('largeText')
      const settings =
        parsed.playSettings === undefined
          ? {}
          : Object.fromEntries(
              Object.entries(object(parsed.playSettings)).map(([id, value]) => {
                if (!packs.some(pack => pack.id === id)) throw new Error('unknown package settings')
                return [id, playSettings(value)]
              }),
            )
      this.#index = {
        playSettings: settings,
        packs,
        instances,
        connections,
        ...(lastModels === undefined ? {} : { lastModels }),
        preferences: {
          largeText: preferences.largeText,
          ...(preferences.theme === undefined ? {} : { theme: preferences.theme as 'system' | 'light' | 'dark' }),
          ...(preferences.reading === undefined ? {} : { reading: readingPreferences(preferences.reading) }),
          ...(preferences.audio === undefined ? {} : { audio: audioPreferences(preferences.audio) }),
          ...(preferences.hostPlugins === undefined
            ? {}
            : { hostPlugins: hostPluginSettings(preferences.hostPlugins) }),
        },
      }
    } catch (error: unknown) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
        throw new Error('Launcher 配置损坏；请检查 launcher.json，未覆盖已有数据。')
      migrated = false
    }
    if (migrated) {
      // One-time move to model connections; the untouched original stays beside the new index.
      await copyFile(
        join(this.root, 'launcher.json'),
        join(this.root, 'launcher.backup-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json'),
      )
      await this.#save(this.#index)
    }
    await this.#presets.load()
    await this.#presets.loadLibrary()
    await this.#recommendations()
    await this.#readPluginManifests()
  }
  async #recommendations() {
    for (const pack of this.#index.packs) {
      try {
        const recommended = await packPreset(pack.path)
        const bundled = await packRolePresets(pack.path)
        const compiled = (await compileWorldPackSource(
          pack.path,
          createInstalledInteractionPackages().map(interactionPackageDescription),
        )) as CompiledWorldPackV5
        await this.#describe(pack, compiled)
        // The author edited the pack since it was loaded: new instances follow the files as they are now.
        if (compiled.packHash !== pack.hash)
          await this.#save({
            ...this.#index,
            packs: this.#index.packs.map(p => (p.id === pack.id ? { ...p, hash: compiled.packHash } : p)),
          })
        this.#recommended[pack.id] = recommended
        this.#characters[pack.id] = packCharacters(compiled)
        this.#setBundled(pack.id, bundled)
      } catch {
        // Package files are external to the index; one unavailable package must
        // not hide other games or leave stale author metadata available.
        delete this.#recommended[pack.id]
        delete this.#bundled[pack.id]
        delete this.#characters[pack.id]
        delete this.#covers[pack.id]
        this.#details[pack.id] = {
          description: '',
          hasCover: false,
          error: '世界包无法读取或校验，可能已移动、缺失或损坏；请恢复包文件后重新载入。',
        }
      }
    }
  }
  #validMapping(instance: Instance, choice: ReturnType<typeof presetChoice>) {
    const ids = new Set((this.#characters[instance.packageId] ?? []).map(c => c.id))
    if ([...Object.keys(choice.characters ?? {}), ...Object.keys(choice.memberships ?? {})].some(id => !ids.has(id)))
      throw new Error('预设引用了此包之外或不可调用的角色。')
  }
  async #save(next: Index): Promise<void> {
    const temporary = join(this.root, 'launcher.' + randomUUID() + '.tmp')
    await writeFile(temporary, JSON.stringify(next, null, 2) + '\n', 'utf8')
    await rename(temporary, join(this.root, 'launcher.json'))
    this.#index = next
  }
  #instance(id: unknown): Instance {
    const instance = this.#index.instances.find(i => i.id === id)
    if (!instance) throw new Error('实例不存在。')
    return instance
  }
  #idle(): void {
    if (this.#child) throw new Error('请先结束当前游戏。')
  }
  #connection(id: unknown): ModelConnection {
    const connection = this.#index.connections.find(c => c.id === id)
    if (!connection) throw new Error('模型连接不存在。')
    return connection
  }
  /** New instances take the last saved choice, else the launcher's proposal, else wait for one. */
  #newModels(proposed: unknown, packageId: string): InstanceModels | undefined {
    if (this.#index.lastModels && !brokenModels(this.#index.lastModels, this.#index.connections))
      return {
        decision: this.#index.lastModels.decision,
        ...(this.#index.lastModels.memory ? { memory: this.#index.lastModels.memory } : {}),
      }
    return proposed === undefined
      ? undefined
      : instanceModels(
          proposed,
          this.#index.connections,
          (this.#characters[packageId] ?? []).map(c => c.id),
        )
  }
  #storyDirectory(instance: Instance, lineId = instance.currentStorylineId): string {
    if (!instance.storylines.some(l => l.id === lineId)) throw new Error('故事线不存在。')
    const root = join(this.root, 'instances', instance.id)
    return lineId === 'main' ? root : join(root, 'storylines', storyId(lineId))
  }
  #storyHistory(instance: Instance) {
    const nodes = instance.storylines.flatMap(line => readStoryNodes(this.#storyDirectory(instance, line.id)))
    return {
      currentStorylineId: instance.currentStorylineId,
      nodes: nodes.map(n => ({
        id: n.id,
        parentNodeId: n.parentNodeId,
        turn: n.tick,
        title: n.title,
        summary: '',
        createdAt: n.createdAt,
      })),
      storylines: instance.storylines.map(line => {
        const own = readStoryNodes(this.#storyDirectory(instance, line.id))
        const parent = instance.storylines.find(p => p.id === line.parentStorylineId)
        const origin = nodes.find(n => n.id === line.parentNodeId)
        return {
          ...line,
          currentNodeId: own.at(-1)?.id ?? line.parentNodeId ?? '',
          source: {
            kind: parent ? 'local' : 'original',
            label: parent?.name ?? '本地实例',
            storylineId: line.parentStorylineId,
            nodeId: line.parentNodeId,
            turn: origin?.tick ?? 0,
          },
        }
      }),
    }
  }
  #storySnapshot(instance: Instance) {
    try {
      return { ...this.#storyHistory(instance), storyError: undefined }
    } catch {
      return {
        currentStorylineId: instance.currentStorylineId,
        nodes: [],
        storyError: '此实例的故事节点无法读取，可能已损坏。历史恢复与分叉已禁用；原文件未修改。',
        storylines: instance.storylines.map(line => ({
          ...line,
          currentNodeId: '',
          source: {
            kind: 'original',
            label: '本地实例',
            storylineId: line.parentStorylineId,
            nodeId: line.parentNodeId,
            turn: 0,
          },
        })),
      }
    }
  }
  snapshot() {
    return {
      ...this.#index,
      instances: this.#index.instances.map(i => ({
        ...i,
        ...this.#storySnapshot(i),
        needsModel: !i.models,
        brokenConnection: i.models ? brokenModels(i.models, this.#index.connections) : false,
      })),
      presets: {
        library: structuredClone(this.#presets.library),
        characters: this.#characters,
        global: this.#presets.global,
        instances: this.#presets.instances,
        recommended: this.#recommended,
        bundled: this.#bundled,
      },
      packDetails: this.#details,
      frontends: this.#frontends,
      dataDirectory: this.root,
      skippedPlugins: this.#skippedPlugins.map(plugin => ({ ...plugin })),
      pluginManifests: structuredClone(this.#pluginManifests),
      core: this.#active
        ? {
            state: 'running',
            mode: 'real',
            instanceId: this.#active.instanceId,
            frontendMode: this.#active.frontendMode,
          }
        : this.#error
          ? { state: 'error', mode: 'real', message: this.#error }
          : { state: 'idle', mode: 'real' },
    }
  }
  /** Settings the player changed on the default stage come back as the launcher's own reading, sound and
   * appearance preferences, so the next game starts with them. A malformed message is ignored. */
  async #stagePreferences(child: ChildProcess, value: unknown): Promise<void> {
    if (this.#child !== child || object(value).type !== 'stage-preferences') return
    let next: ReturnType<typeof launcherPreferencesFromStage>
    try {
      next = launcherPreferencesFromStage(object(value).preferences)
    } catch {
      return
    }
    await this.#save({ ...this.#index, preferences: { ...this.#index.preferences, ...next } }).catch(() => {})
  }

  async handle(value: unknown): Promise<unknown> {
    const request = object(value)
    switch (request.operation) {
      case 'snapshot':
        return this.snapshot()
      case 'pack-cover':
        return { packageId: request.packageId, dataUrl: this.#covers[text(request.packageId, '包 ID', 200)] ?? null }
      case 'connection-save': {
        const connection = modelConnection(request.connection)
        const exists = this.#index.connections.some(c => c.id === connection.id)
        await this.#save({
          ...this.#index,
          connections: exists
            ? this.#index.connections.map(c => (c.id === connection.id ? connection : c))
            : [...this.#index.connections, connection],
        })
        return this.snapshot()
      }
      case 'connection-remove': {
        const id = this.#connection(request.connectionId).id
        await this.#save({ ...this.#index, connections: this.#index.connections.filter(c => c.id !== id) })
        return this.snapshot()
      }
      case 'list-models': {
        const connection = this.#connection(request.connectionId)
        return { models: await listModels(connection, apiKeys(request.apiKeys)[connection.id]) }
      }
      case 'test-model': {
        const connection = this.#connection(request.connectionId)
        const model = { model: text(request.model, '模型标识', 120), endpoint: connection.endpoint }
        const key = apiKeys(request.apiKeys)[connection.id]
        let response: Response
        const protocol = connection.protocol
        const messages = [{ role: 'user', content: '请只回复 OK。这是连接测试，不包含游戏内容。' }]
        const body =
          protocol === 'openai'
            ? { model: model.model, messages, max_tokens: 128 }
            : protocol === 'anthropic'
              ? { model: model.model, ...nativeMessages(messages, protocol), max_tokens: 128 }
              : { ...nativeMessages(messages, protocol), generationConfig: { maxOutputTokens: 128 } }
        try {
          response = await fetch(providerEndpoint(new URL(model.endpoint), protocol, model.model), {
            method: 'POST',
            redirect: 'error',
            headers: providerHeaders(protocol, key),
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(15000),
          })
        } catch {
          throw new Error('模型连接失败或超过 15 秒；请检查接口地址、服务是否启动和网络。')
        }
        if (response.status === 401 || response.status === 403)
          throw new Error('模型接口拒绝认证；请检查 API Key 与访问权限。')
        if (response.status === 429) throw new Error('模型接口限流或额度不足，请稍后重试并检查额度。')
        if (!response.ok) throw new Error('模型接口返回 HTTP ' + response.status + '；请检查模型标识与接口配置。')
        let data: unknown
        try {
          data = await response.json()
        } catch {
          throw new Error('模型接口未返回有效 JSON。')
        }
        if (protocol === 'openai') {
          const choices = (data as { choices?: { message?: { content?: unknown } }[] } | null)?.choices
          if (
            !Array.isArray(choices) ||
            typeof choices[0]?.message?.content !== 'string' ||
            !choices[0].message.content.trim()
          )
            throw new Error('模型接口未返回有效文本；请检查 chat/completions 协议与模型。')
        } else {
          const payload = nativePayload(data, protocol)
          if (typeof payload !== 'string' || !payload.trim()) throw new Error('模型接口未返回有效文本。')
        }
        return { message: '模型接口已响应。此测试不验证游戏所需的结构化输出。' }
      }
      case 'preset-library-add': {
        await this.#presets.addLibrary([namedPreset(request.entry)])
        return this.snapshot()
      }
      case 'preset-library-update': {
        if (typeof request.id !== 'string') throw new Error('预设不存在。')
        await this.#presets.updateLibrary(request.id, request.entry)
        return this.snapshot()
      }
      case 'preset-library-remove': {
        if (typeof request.id !== 'string') throw new Error('预设不存在。')
        await this.#presets.removeLibrary(request.id)
        return this.snapshot()
      }
      case 'preset-library-import': {
        if (typeof request.text !== 'string') throw new Error('导入内容无效。')
        await this.#presets.addLibrary(
          importPresets(request.text, typeof request.name === 'string' ? request.name : undefined),
        )
        return this.snapshot()
      }
      case 'preset-export-file': {
        if (typeof request.path !== 'string' || !request.path.toLowerCase().endsWith('.json'))
          throw new Error('请选择 JSON 文件。')
        if (typeof request.text !== 'string') throw new Error('导出内容无效。')
        const entries = importPresets(request.text)
        const document = JSON.parse(request.text) as { presets?: unknown }
        const single = !Array.isArray(document) && !Array.isArray(document.presets)
        await writeFile(request.path, exportPresets(entries, single), 'utf8')
        return { saved: true }
      }
      case 'preset-save': {
        const instance = this.#instance(request.instanceId),
          choice = presetChoice(request.choice)
        this.#validMapping(instance, choice)
        await this.#presets.save(rolePreset(request.global), { ...this.#presets.instances, [instance.id]: choice })
        return this.snapshot()
      }
      case 'preset-inspect':
        await this.#recommendations()
        return this.snapshot()
      case 'preset-apply-bundle': {
        // Copies the package's character and group presets into one instance; other mappings stay as they are.
        const instance = this.#instance(request.instanceId)
        const bundle = this.#bundled[instance.packageId]
        if (!bundle) throw new Error('这个游戏包没有随包角色预设。')
        const { mode, override, ...mapping } = this.#presets.instances[instance.id] ?? {
          mode: 'auto' as const,
          override: {},
        }
        const choice = presetChoice({ mode, override, ...assignPackRolePresets(mapping, bundle, randomUUID) })
        this.#validMapping(instance, choice)
        await this.#presets.save(this.#presets.global, { ...this.#presets.instances, [instance.id]: choice })
        if (request.library === true) {
          const title = (this.#index.packs.find(p => p.id === instance.packageId)?.title ?? '游戏包').slice(0, 40)
          const names = new Map((this.#characters[instance.packageId] ?? []).map(c => [c.id, c.name]))
          await this.#presets.addLibrary([
            ...Object.entries(bundle.characters).map(([id, preset]) => ({
              name: title + ' · ' + (names.get(id) ?? id).slice(0, 30) + ' 专属',
              preset,
            })),
            ...bundle.groups.map(group => ({ name: title + ' · ' + group.name.slice(0, 30), preset: group.preset })),
          ])
        }
        return this.snapshot()
      }
      case 'preset-global':
        await this.#presets.save(rolePreset(request.preset), this.#presets.instances)
        return this.snapshot()
      case 'preset-instance': {
        const instance = this.#instance(request.instanceId)
        const choice = presetChoice(request.choice)
        this.#validMapping(instance, choice)
        await this.#presets.save(this.#presets.global, { ...this.#presets.instances, [instance.id]: choice })
        return this.snapshot()
      }
      case 'frontend-inspect': {
        await this.#inspect(this.#instance(request.instanceId))
        return this.snapshot()
      }
      case 'frontend-grant': {
        this.#idle()
        const instance = this.#instance(request.instanceId)
        const { identity, web } = await this.#inspect(instance)
        if (!web) throw new Error('此包使用官方默认前端，无需授权。')
        if (request.confirmed !== true || request.expectedDigest !== web.digest)
          throw new Error('前端已变化或尚未确认；请重新检查后明确授权。')
        await this.#authorizations().grant(identity)
        await this.#inspect(instance)
        return this.snapshot()
      }
      case 'frontend-revoke': {
        const instance = this.#instance(request.instanceId)
        await this.#authorizations().revoke(instance.id)
        await this.#revokeRunning(instance.id)
        await this.#inspect(instance)
        return this.snapshot()
      }
      case 'load': {
        this.#idle()
        const path = resolve(text(request.path, '世界包目录'))
        const compiled = (await compileWorldPackSource(
          path,
          createInstalledInteractionPackages().map(interactionPackageDescription),
        )) as CompiledWorldPackV5
        await loadPackWeb(path)
        const recommended = await packPreset(path)
        const characters = packCharacters(compiled)
        const bundled = await packRolePresets(path)
        if (bundled) checkBundled(characters, bundled)
        const pack: Pack = {
          id: compiled.packId,
          version: compiled.packVersion,
          title: compiled.content.world.title,
          path,
          hash: compiled.packHash,
        }
        // Reloading an edited pack replaces its record; instances keep the hash they were played on.
        await this.#save({ ...this.#index, packs: [...this.#index.packs.filter(p => p.id !== pack.id), pack] })
        this.#recommended[pack.id] = recommended
        this.#characters[pack.id] = characters
        this.#setBundled(pack.id, bundled)
        await this.#describe(pack, compiled)
        return this.snapshot()
      }
      case 'story-export': {
        const instance = this.#instance(request.instanceId),
          nodeId = storyId(request.nodeId)
        const history = this.#storyHistory(instance),
          reachable = new Set<string>()
        let current = history.storylines.find(line => line.id === instance.currentStorylineId)!.currentNodeId
        while (current) {
          if (reachable.has(current)) throw new Error('故事历史关系损坏。')
          reachable.add(current)
          current = history.nodes.find(node => node.id === current)?.parentNodeId ?? ''
        }
        if (!reachable.has(nodeId)) throw new Error('请选择当前线路的历史节点。')
        const owner = instance.storylines.find(line =>
          readStoryNodes(this.#storyDirectory(instance, line.id)).some(node => node.id === nodeId),
        )!
        const pack = this.#index.packs.find(pack => pack.id === instance.packageId)!
        await exportStoryNode(
          this.#storyDirectory(instance, owner.id),
          nodeId,
          text(request.path, '导出路径'),
          pack.path,
        )
        return this.snapshot()
      }
      case 'story-import': {
        this.#idle()
        const pack = this.#index.packs.find(pack => pack.id === request.packageId)
        if (!pack) throw new Error('请先载入对应游戏包。')
        const name = text(request.name, '实例名称', 80)
        const imported = await importStoryNode(
          text(request.path, '故事线文件'),
          join(this.root, 'instances'),
          pack.path,
          pack.hash,
        )
        const instance: Instance = {
          id: imported.id,
          packageId: pack.id,
          packageVersion: pack.version,
          packHash: pack.hash,
          name,
          currentStorylineId: 'main',
          storylines: [
            { id: 'main', name: '导入 · ' + imported.node.title, parentStorylineId: null, parentNodeId: null },
          ],
          lastPlayedAt: null,
        }
        const models = this.#newModels(undefined, pack.id)
        if (models) instance.models = models
        await this.#save({ ...this.#index, instances: [...this.#index.instances, instance] })
        return this.snapshot()
      }
      case 'story-select': {
        this.#idle()
        const instance = this.#instance(request.instanceId)
        if (!instance.storylines.some(l => l.id === request.storylineId)) throw new Error('故事线不存在。')
        await this.#save({
          ...this.#index,
          instances: this.#index.instances.map(i =>
            i === instance ? { ...i, currentStorylineId: String(request.storylineId) } : i,
          ),
        })
        return this.snapshot()
      }
      case 'story-fork': {
        this.#idle()
        const instance = this.#instance(request.instanceId),
          name = text(request.name, '故事线名称', 80)
        const nodeId = storyId(request.nodeId)
        const history = this.#storyHistory(instance)
        const selected = history.storylines.find(l => l.id === instance.currentStorylineId)!
        const reachable = new Set<string>()
        let current = selected.currentNodeId
        while (current) {
          if (reachable.has(current)) throw new Error('故事历史关系损坏。')
          reachable.add(current)
          current = history.nodes.find(n => n.id === current)?.parentNodeId ?? ''
        }
        if (!reachable.has(nodeId)) throw new Error('请选择当前线路的历史节点。')
        const owner = instance.storylines.find(l =>
          readStoryNodes(this.#storyDirectory(instance, l.id)).some(n => n.id === nodeId),
        )!
        const pack = this.#index.packs.find(p => p.id === instance.packageId)!
        const source = this.#storyDirectory(instance, owner.id)
        const preflight = await preflightSave(pack.path, source)
        if (preflight.packHash !== instance.packHash) throw new Error('游戏包内容已变化。')
        const line: Storyline = {
          id: randomUUID(),
          name,
          parentStorylineId: instance.currentStorylineId,
          parentNodeId: nodeId,
        }
        const next = { ...instance, currentStorylineId: line.id, storylines: [...instance.storylines, line] }
        restoreStoryNode(source, nodeId, this.#storyDirectory(next), instance.packHash)
        await this.#save({ ...this.#index, instances: this.#index.instances.map(i => (i === instance ? next : i)) })
        return this.snapshot()
      }
      case 'create': {
        this.#idle()
        const pack = this.#index.packs.find(p => p.id === request.packageId)
        if (!pack) throw new Error('请先载入世界包。')
        const instance: Instance = {
          currentStorylineId: 'main',
          storylines: [{ id: 'main', name: '主故事线', parentStorylineId: null, parentNodeId: null }],
          id: randomUUID(),
          packageId: pack.id,
          packageVersion: pack.version,
          packHash: pack.hash,
          name: text(request.name, '实例名称', 80),
          lastPlayedAt: null,
        }
        const models = this.#newModels(request.models, pack.id)
        if (models) instance.models = models
        await this.#save({ ...this.#index, instances: [...this.#index.instances, instance] })
        return this.snapshot()
      }
      case 'instance-remove': {
        this.#idle()
        const instance = this.#instance(request.instanceId)
        if (request.confirmed !== true) throw new Error('删除实例需要先确认。')
        // The index goes first: if removing files fails halfway, no listed instance points at a broken save.
        await this.#save({ ...this.#index, instances: this.#index.instances.filter(i => i.id !== instance.id) })
        if (instance.id in this.#presets.instances) {
          const { [instance.id]: _removed, ...rest } = this.#presets.instances
          await this.#presets.save(this.#presets.global, rest)
        }
        await this.#authorizations().revoke(instance.id)
        await rm(join(this.root, 'instances', instance.id), { recursive: true, force: true })
        return this.snapshot()
      }
      case 'play-settings': {
        const pack = this.#index.packs.find(pack => pack.id === request.packageId)
        if (!pack) throw new Error('请先载入游戏包。')
        await this.#save({
          ...this.#index,
          playSettings: { ...this.#index.playSettings, [pack.id]: playSettings(request.settings) },
        })
        return this.snapshot()
      }
      case 'preferences': {
        if (
          typeof request.theme !== 'string' ||
          !['system', 'light', 'dark'].includes(request.theme) ||
          typeof request.largeText !== 'boolean'
        )
          throw new TypeError('外观设置无效。')
        await this.#save({
          ...this.#index,
          preferences: {
            ...this.#index.preferences,
            theme: request.theme as 'system' | 'light' | 'dark',
            largeText: request.largeText,
            ...(request.reading === undefined ? {} : { reading: readingPreferences(request.reading) }),
            ...(request.audio === undefined ? {} : { audio: audioPreferences(request.audio) }),
            ...(request.hostPlugins === undefined
              ? {}
              : { hostPlugins: await checkedPluginConfig(hostPluginSettings(request.hostPlugins)) }),
          },
        })
        await this.#readPluginManifests()
        return this.snapshot()
      }
      case 'plugin-inspect': {
        const [plugin] = hostPluginSettings([{ id: 'inspect', path: request.path, enabled: true }])
        return inspectPlugin(plugin!.path)
      }
      case 'settings': {
        if (request.largeText !== undefined && typeof request.largeText !== 'boolean')
          throw new TypeError('字体设置无效。')
        await this.#save({
          ...this.#index,
          preferences: {
            ...this.#index.preferences,
            largeText: request.largeText === undefined ? this.#index.preferences.largeText : request.largeText,
          },
        })
        return this.snapshot()
      }
      case 'configure': {
        const instance = this.#instance(request.instanceId)
        const models = instanceModels(
          request.models,
          this.#index.connections,
          (this.#characters[instance.packageId] ?? []).map(c => c.id),
        )
        await this.#save({
          ...this.#index,
          lastModels: { decision: models.decision, ...(models.memory ? { memory: models.memory } : {}) },
          instances: this.#index.instances.map(i => (i === instance ? { ...i, models } : i)),
        })
        return this.snapshot()
      }
      case 'start': {
        this.#idle()
        this.#error = ''
        this.#skippedPlugins = []
        await this.#readPluginManifests()
        const enabledPlugins = new Set(
          (this.#index.preferences.hostPlugins ?? []).filter(plugin => plugin.enabled).map(plugin => plugin.id),
        )
        const pluginSecrets = Object.fromEntries(
          Object.entries(pluginSecretValues(request.pluginSecrets ?? {})).filter(([id]) => enabledPlugins.has(id)),
        )
        let instance = this.#instance(request.instanceId)
        const packError = this.#details[instance.packageId]?.error
        if (packError) throw new Error(packError)
        if (!instance.models) throw new Error('请先在模型配置中选择模型。')
        const modelEnv = modelEnvironment(instance.models, this.#index.connections, apiKeys(request.apiKeys))
        const pack = this.#index.packs.find(p => p.id === instance.packageId)!
        const directory = this.#storyDirectory(instance)
        const preflight = await preflightSave(pack.path, directory)
        if (preflight.packHash !== instance.packHash) {
          // An instance that has never been played has no world yet, so it simply takes the pack as it is now.
          if (preflight.kind === 'resume')
            throw new Error('这个实例创建于世界包修改之前，已有进度不能在改过的包上继续；请新建实例，或恢复原包。')
          instance = { ...instance, packHash: preflight.packHash }
          await this.#save({
            ...this.#index,
            instances: this.#index.instances.map(i => (i.id === instance.id ? instance : i)),
          })
        }
        try {
          await access(corePythonExecutable())
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code
          if (code === 'ENOENT')
            throw new Error(
              '本机记忆所需的 Python 环境不存在。请准备开发环境，或设置 HCW_HINDSIGHT_PYTHON 后重启启动器。',
            )
          if (code === 'EACCES' || code === 'EPERM')
            throw new Error('无法访问本机记忆所需的 Python 环境（权限不足）。请检查运行环境的访问权限。')
          throw error
        }
        try {
          await mkdir(directory, { recursive: true })
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code
          if (code === 'EACCES' || code === 'EPERM') {
            throw new Error(
              '无法创建游戏存档目录（权限不足）。请检查启动器的运行权限，或在全局设置选择可写的数据目录。',
            )
          }
          throw error
        }
        const frontend = await this.#inspect(instance)
        const recommended = await packPreset(pack.path)
        this.#recommended[pack.id] = recommended
        const choice = this.#presets.instances[instance.id]
        if (choice) this.#validMapping(instance, choice)
        const child = spawn(
          process.execPath,
          [
            ...(process.env.PERSPECTRA_RUNTIME_ROOT
              ? [join(process.env.PERSPECTRA_RUNTIME_ROOT, 'playtest.mjs')]
              : ['--import', 'tsx', join(this.repository, 'desktop/host/web-entry.ts')]),
            '--pack',
            pack.path,
            '--data-dir',
            directory,
            '--memory-core',
            '--play-settings',
            JSON.stringify(this.#index.playSettings?.[pack.id] ?? playSettings({})),
          ],
          {
            cwd: this.repository,
            windowsHide: true,
            env: {
              ...process.env,
              HCW_THINKING_LEVEL: undefined,
              ...modelEnv,
              PERSPECTRA_STORY_PARENT_NODE:
                instance.storylines.find(l => l.id === instance.currentStorylineId)?.parentNodeId ?? '',
              PERSPECTRA_STORY_NAME: instance.storylines.find(l => l.id === instance.currentStorylineId)!.name,
              PERSPECTRA_READING: JSON.stringify(this.#index.preferences.reading ?? DEFAULT_READING),
              PERSPECTRA_AUDIO: JSON.stringify(this.#index.preferences.audio ?? DEFAULT_AUDIO),
              PERSPECTRA_APPEARANCE: this.#index.preferences.theme ?? 'system',
              PERSPECTRA_HOST_PLUGINS: JSON.stringify(this.#index.preferences.hostPlugins ?? []),
              // Read from the credential store by the desktop shell for this launch only; never saved here.
              PERSPECTRA_PLUGIN_SECRETS: JSON.stringify(pluginSecrets),
              PERSPECTRA_PRESET_ROOT: this.root,
              PERSPECTRA_PRESET_INSTANCE: instance.id,
              PERSPECTRA_ROLE_PRESET: undefined,
              PERSPECTRA_ROLE_MAPPING: undefined,
              PERSPECTRA_FRONTEND_APPROVED_SHA256: frontend.mode === 'trusted' ? frontend.identity.digest : '',
            },
            stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
          },
        )
        this.#child = child
        child.stdout?.resume()
        child.stderr?.resume()
        child.once('exit', () => {
          if (this.#child !== child) return
          this.#child = undefined
          this.#active = undefined
          this.#error = '游戏进程已退出，请重新启动；已提交进度保留。'
        })
        try {
          const ready = await new Promise<{ port: number; token: string; frontendMode: 'sandbox' | 'trusted' }>(
            (done, reject) => {
              const timer = setTimeout(() => finish(new Error('Core 启动或故事线恢复超时；原线保留，可重试。')), 60_000)
              const finish = (
                error?: Error,
                result?: { port: number; token: string; frontendMode: 'sandbox' | 'trusted' },
              ) => {
                clearTimeout(timer)
                child.off('message', message)
                child.off('exit', exit)
                child.off('error', failed)
                if (error) reject(error)
                else done(result!)
              }
              const exit = () => finish(new Error('Core 在就绪前退出；请检查包和本机记忆依赖。'))
              const failed = () => finish(new Error('无法启动本机 Node/Core 进程。'))
              const message = (value: unknown) => {
                const data = object(value)
                if (data.type === 'startup-error') {
                  this.#skippedPlugins = skippedPlugins(data.skippedPlugins)
                  finish(new Error(startupFailure(data)))
                }
                if (
                  data.type === 'ready' &&
                  Number.isInteger(data.port) &&
                  Number(data.port) > 0 &&
                  Number(data.port) <= 65535 &&
                  typeof data.token === 'string' &&
                  /^[a-f0-9]{64}$/.test(data.token)
                ) {
                  this.#skippedPlugins = skippedPlugins(data.skippedPlugins)
                  finish(undefined, {
                    port: Number(data.port),
                    token: data.token,
                    frontendMode: data.frontendMode === 'trusted' ? 'trusted' : 'sandbox',
                  })
                }
              }
              child.on('message', message)
              child.once('exit', exit)
              child.once('error', failed)
            },
          )
          await this.#save({
            ...this.#index,
            instances: this.#index.instances.map(i =>
              i.id === instance.id ? { ...i, lastPlayedAt: new Date().toISOString() } : i,
            ),
          })
          child.on('message', value => void this.#stagePreferences(child, value))
          this.#active = {
            instanceId: instance.id,
            url: 'http://127.0.0.1:' + ready.port + '/#token=' + ready.token,
            frontendMode: ready.frontendMode,
          }
          return this.snapshot()
        } catch (error) {
          await this.stop()
          throw error
        }
      }
      case 'open-creator': {
        if (!this.#active) throw new Error('游戏尚未启动。')
        const target = new URL(this.#active.url)
        target.pathname = '/creator/'
        return { url: target.href }
      }
      case 'open': {
        if (!this.#active) throw new Error('游戏尚未启动。')
        return { url: this.#active.url }
      }
      case 'stop':
        await this.stop()
        return this.snapshot()
      default:
        throw new Error('不支持的 Launcher 操作。')
    }
  }
  async stop(): Promise<void> {
    const child = this.#child
    this.#child = undefined
    this.#active = undefined
    this.#error = ''
    if (child) await terminate(child)
  }
}
