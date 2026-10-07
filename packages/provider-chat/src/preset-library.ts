import { rolePreset, type RolePreset } from './preset.ts'
export const PRESET_FORMAT = 'perspectra-model-preset'
export const PRESET_SCHEMA_VERSION = 1
export interface NamedPreset { name: string; preset: RolePreset }
export interface LibraryPreset extends NamedPreset { id: string }
export function namedPreset(value: unknown, checkMacros = true): NamedPreset {
 if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('命名预设必须是对象。')
 const r = value as Record<string, unknown>
 if (Object.keys(r).some(key => !['name','preset'].includes(key))) throw new TypeError('命名预设只包含 name 和 preset。')
 if (typeof r.name !== 'string' || !r.name.trim() || r.name.trim().length > 80) throw new TypeError('预设名称须为 1–80 个字符。')
 return {name:r.name.trim(),preset:rolePreset(r.preset, checkMacros)}
}
/** Versioned exchange files; existing unversioned native inputs remain importable. */
function exchangeEntries(value: Record<string, unknown>): NamedPreset[] {
 if(value.format !== PRESET_FORMAT)throw new TypeError('预设交换 format 无效，应为 perspectra-model-preset。')
 if(value.schemaVersion !== PRESET_SCHEMA_VERSION)throw new TypeError('预设交换版本不受支持，目前只支持 schemaVersion: 1。')
 const {format: _format,schemaVersion: _version,...payload}=value
 if(Object.hasOwn(payload,'presets')){
  if(Object.keys(payload).length!==1 || !Array.isArray(payload.presets))throw new TypeError('整库交换内容只包含 presets 数组。')
  return payload.presets.map(value=>namedPreset(value))
 }
 return [namedPreset(payload)]
}
export function importPresets(text: string, fallbackName = '导入预设'): NamedPreset[] {
 if (text.length > 1_000_000) throw new TypeError('预设文件超过 100 万字符。')
 let value: unknown
 try { value=JSON.parse(text) } catch { throw new TypeError('无法解析 JSON，请检查文件内容。') }
 const marked = value && typeof value === 'object' && !Array.isArray(value) && ('format' in value || 'schemaVersion' in value)
 const entries = marked ? exchangeEntries(value as Record<string,unknown>)
  : Array.isArray(value) ? value.map(value=>namedPreset(value))
  : value && typeof value === 'object' && ('name' in value || 'preset' in value) ? [namedPreset(value)]
  : [namedPreset({name:fallbackName,preset:value})]
 if (!entries.length) throw new TypeError('导入文件没有预设。')
 return entries
}
export function exportPresets(entries: readonly NamedPreset[], single = false): string {
 const clean = entries.map(entry => namedPreset({name:entry.name,preset:entry.preset}))
 if (!clean.length || single && clean.length !== 1) throw new TypeError('请选择要导出的预设。')
 const document={format:PRESET_FORMAT,schemaVersion:PRESET_SCHEMA_VERSION,...(single?clean[0]:{presets:clean})}
 const text=JSON.stringify(document,null,2)+'\n'
 if(text.length>1_000_000)throw new TypeError('导出内容超过 100 万字符，请分开导出所选预设。')
 return text
}
