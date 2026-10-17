import { invoke, isTauri } from '@tauri-apps/api/core'
import type { CreatorDebugQuery, CreatorDebugSnapshot } from '../../../../tests/experiments/creator-debug.ts'
import type { CreatorRecordsQuery, CreatorRecordsSnapshot } from '../../../../tests/experiments/creator-records.ts'
import type { CreatorHistoryQuery, CreatorHistorySnapshot } from '../../../../tests/experiments/creator-history.ts'
import type { CoreSnapshot } from '../core-types.ts'
export async function coreRequest(operation: string, data: Record<string, unknown> = {}): Promise<CoreSnapshot> {
  return invoke<CoreSnapshot>('launcher_request', { request: { operation, ...data } })
}
export async function openGame(): Promise<void> {
  await invoke('launcher_request', { request: { operation: 'open' } })
}
export async function packCover(packageId: string): Promise<string | null> {
  const result = await invoke<{ dataUrl: string | null }>('launcher_request', { request: { operation: 'pack-cover', packageId } })
  return result.dataUrl
}
export async function choosePackageDirectory(): Promise<string | null> {
  if (!isTauri()) return null
  const { open } = await import('@tauri-apps/plugin-dialog')
  const path = await open({ title: '选择 v5 世界包目录', directory: true, multiple: false })
  return typeof path === 'string' ? path : null
}
/** Retained only for browser Mock preview compatibility. */
export async function choosePackageFile(): Promise<string | null> { return choosePackageDirectory() }

export async function inspectRequests(instanceId: string, enabled?: boolean): Promise<import('../../../../packages/provider-chat/src/request-inspector.ts').InspectorSnapshot> {
 return invoke('launcher_request', { request: { operation: 'request-inspector', instanceId, ...(enabled === undefined ? {} : { enabled }) } })
}
export async function inspectCreator(instanceId: string, query: CreatorDebugQuery = {}): Promise<CreatorDebugSnapshot> {
 return invoke('launcher_request', { request: { operation: 'creator-debug', instanceId, query } })
}
export async function inspectCreatorRecords(instanceId: string, query: CreatorRecordsQuery = {}): Promise<CreatorRecordsSnapshot> {
 return invoke('launcher_request', {request:{operation:'creator-records',instanceId,query}})
}
export async function inspectCreatorHistory(instanceId: string, query: CreatorHistoryQuery = {}): Promise<CreatorHistorySnapshot> {
 return invoke('launcher_request', {request:{operation:'creator-history',instanceId,query}})
}

export async function savePresetFile(text: string, name: string): Promise<boolean> {
 if (isTauri()) {
  const { save } = await import('@tauri-apps/plugin-dialog')
  const path = await save({ title:'导出预设',defaultPath:name,filters:[{name:'JSON',extensions:['json']}] })
  if (!path) return false
  await invoke('launcher_request',{request:{operation:'preset-export-file',path,text}})
 } else {
  const url=URL.createObjectURL(new Blob([text],{type:'application/json'}))
  const link=document.createElement('a');link.href=url;link.download=name;link.click()
  setTimeout(()=>URL.revokeObjectURL(url),1000)
 }
 return true
}

/** Keys are added by the desktop shell from the credential store; the page never sends them here. */
export async function testModelConnection(connectionId: string, model: string): Promise<string> {
 const result=await invoke<{message:string}>('launcher_request',{request:{operation:'test-model',connectionId,model}})
 return result.message
}
export async function listConnectionModels(connectionId: string): Promise<string[]> {
 const result=await invoke<{models:string[]}>('launcher_request',{request:{operation:'list-models',connectionId}})
 return result.models
}
export async function setConnectionKey(connectionId: string, apiKey: string): Promise<void> {
 await invoke('launcher_request',{request:{operation:'connection-key-set',connectionId,apiKey}})
}
export async function connectionKeyStatus(connectionIds: string[]): Promise<string[]> {
 const result=await invoke<{stored:string[]}>('launcher_request',{request:{operation:'connection-key-status',connectionIds}})
 return result.stored
}

export async function chooseStoryFile(): Promise<string | null> {
  if (!isTauri()) return null
  const { open } = await import('@tauri-apps/plugin-dialog')
  const path = await open({ title: '导入故事节点', multiple: false, filters: [{ name: 'Perspectra 故事节点', extensions: ['perspectra-story'] }] })
  return typeof path === 'string' ? path : null
}
export async function chooseStoryDestination(): Promise<string | null> {
  if (!isTauri()) return null
  const { save } = await import('@tauri-apps/plugin-dialog')
  return save({ title: '导出故事节点', defaultPath: '故事节点.perspectra-story', filters: [{ name: 'Perspectra 故事节点', extensions: ['perspectra-story'] }] })
}

export interface DataLocation { current: string; next: string; locked: boolean }
export async function dataLocation(operation = 'data-location', data: Record<string, unknown> = {}): Promise<DataLocation> {
 return invoke('launcher_request', { request: { operation, ...data } })
}
export async function chooseDataDirectory(): Promise<string | null> {
 if (!isTauri()) return null
 const { open } = await import('@tauri-apps/plugin-dialog')
 const path = await open({ title: '选择新的数据目录（重启后生效）', directory: true, multiple: false })
 return typeof path === 'string' ? path : null
}
