import { invoke, isTauri } from '@tauri-apps/api/core'
import type { CoreSnapshot } from '../core-types.ts'
export async function coreRequest(operation: string, data: Record<string, unknown> = {}): Promise<CoreSnapshot> {
  return invoke<CoreSnapshot>('launcher_request', { request: { operation, ...data } })
}
export async function openGame(): Promise<void> {
  await invoke('launcher_request', { request: { operation: 'open' } })
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

export async function testModelConnection(model: import('../core-types.ts').LocalModel, apiKey: string): Promise<string> {
 const result=await invoke<{message:string}>('launcher_request',{request:{operation:'test-model',model,apiKey}})
 return result.message
}
