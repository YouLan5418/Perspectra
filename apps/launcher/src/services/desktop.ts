import { invoke, isTauri } from '@tauri-apps/api/core'
import type { CoreSnapshot, PluginManifestInfo, ThinkingLevel } from '../core-types.ts'
export async function coreRequest(operation: string, data: Record<string, unknown> = {}): Promise<CoreSnapshot> {
  return invoke<CoreSnapshot>('launcher_request', { request: { operation, ...data } })
}
export async function openGame(): Promise<void> {
  await invoke('launcher_request', { request: { operation: 'open' } })
}
/** 创作者页面与玩家页面同一本地服务器；地址由桌面端校验后交给系统浏览器。 */
export async function openCreator(): Promise<void> {
  await invoke('launcher_request', { request: { operation: 'open-creator' } })
}
export async function packCover(packageId: string): Promise<string | null> {
  const result = await invoke<{ dataUrl: string | null }>('launcher_request', {
    request: { operation: 'pack-cover', packageId },
  })
  return result.dataUrl
}
export async function choosePackageDirectory(): Promise<string | null> {
  if (!isTauri()) return null
  const { open } = await import('@tauri-apps/plugin-dialog')
  const path = await open({ title: '选择 v5 世界包目录', directory: true, multiple: false })
  return typeof path === 'string' ? path : null
}
/** Retained only for browser Mock preview compatibility. */
export async function choosePackageFile(): Promise<string | null> {
  return choosePackageDirectory()
}

export async function savePresetFile(text: string, name: string): Promise<boolean> {
  if (isTauri()) {
    const { save } = await import('@tauri-apps/plugin-dialog')
    const path = await save({ title: '导出预设', defaultPath: name, filters: [{ name: 'JSON', extensions: ['json'] }] })
    if (!path) return false
    await invoke('launcher_request', { request: { operation: 'preset-export-file', path, text } })
  } else {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
    const link = document.createElement('a')
    link.href = url
    link.download = name
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  return true
}

/** Keys are added by the desktop shell from the credential store; the page never sends them here. */
export async function testModelConnection(connectionId: string, model: string): Promise<string> {
  const result = await invoke<{ message: string }>('launcher_request', {
    request: { operation: 'test-model', connectionId, model },
  })
  return result.message
}
export async function listConnectionModels(connectionId: string): Promise<string[]> {
  const result = await invoke<{ models: string[] }>('launcher_request', {
    request: { operation: 'list-models', connectionId },
  })
  return result.models
}
/** The thinking levels the model's declaration offers; the Node backend reads them from the model catalog. */
export async function thinkingLevels(connectionId: string, model: string): Promise<ThinkingLevel[]> {
  const result = await invoke<{ levels: ThinkingLevel[] }>('launcher_request', {
    request: { operation: 'thinking-levels', connectionId, model },
  })
  return result.levels
}
export async function setConnectionKey(connectionId: string, apiKey: string): Promise<void> {
  await invoke('launcher_request', { request: { operation: 'connection-key-set', connectionId, apiKey } })
}
export async function connectionKeyStatus(connectionIds: string[]): Promise<string[]> {
  const result = await invoke<{ stored: string[] }>('launcher_request', {
    request: { operation: 'connection-key-status', connectionIds },
  })
  return result.stored
}
/** Secret plugin fields go straight to the system credential store; an empty value clears one. */
export async function setPluginSecret(pluginId: string, field: string, value: string): Promise<void> {
  await invoke('launcher_request', { request: { operation: 'plugin-secret-set', pluginId, field, value } })
}
export async function pluginSecretStatus(pluginId: string, fields: string[]): Promise<string[]> {
  const result = await invoke<{ stored: string[] }>('launcher_request', {
    request: { operation: 'plugin-secret-status', pluginId, fields },
  })
  return result.stored
}
/** Reads the manifest beside a plugin file the player just picked, before settings are saved. */
export async function inspectPlugin(path: string): Promise<PluginManifestInfo> {
  return invoke('launcher_request', { request: { operation: 'plugin-inspect', path } })
}

export async function chooseStoryFile(): Promise<string | null> {
  if (!isTauri()) return null
  const { open } = await import('@tauri-apps/plugin-dialog')
  const path = await open({
    title: '导入故事节点',
    multiple: false,
    filters: [{ name: 'Perspectra 故事节点', extensions: ['perspectra-story'] }],
  })
  return typeof path === 'string' ? path : null
}
export async function chooseStoryDestination(): Promise<string | null> {
  if (!isTauri()) return null
  const { save } = await import('@tauri-apps/plugin-dialog')
  return save({
    title: '导出故事节点',
    defaultPath: '故事节点.perspectra-story',
    filters: [{ name: 'Perspectra 故事节点', extensions: ['perspectra-story'] }],
  })
}

export interface DataLocation {
  current: string
  next: string
  locked: boolean
}
export async function dataLocation(
  operation = 'data-location',
  data: Record<string, unknown> = {},
): Promise<DataLocation> {
  return invoke('launcher_request', { request: { operation, ...data } })
}
export async function chooseDataDirectory(): Promise<string | null> {
  if (!isTauri()) return null
  const { open } = await import('@tauri-apps/plugin-dialog')
  const path = await open({ title: '选择新的数据目录（重启后生效）', directory: true, multiple: false })
  return typeof path === 'string' ? path : null
}
