import type { PluginConfig, PluginConfigField, PluginManifest } from '@harness-world/plugin-sdk'

/** Browser-safe: the launcher page validates its form with the same rules the host applies at launch. */

const SERVICES = ['frontendServices', 'capabilities', 'playerFeed'] as const
const FIELD_NAME = /^[a-zA-Z][a-zA-Z0-9_]{0,39}$/u
const text = (value: unknown, max: number) =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= max

/** `D:/plugins/tts.mjs` → `D:/plugins/tts.plugin.json`. */
export function pluginManifestPath(entry: string): string {
  return entry.replace(/\.(?:mjs|js)$/iu, '') + '.plugin.json'
}

export function parsePluginManifest(value: unknown): PluginManifest {
  const fail = (detail: string): never => {
    throw new TypeError('插件清单无效：' + detail)
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('须为 JSON 对象')
  const data = value as Record<string, unknown>
  const unknown = Object.keys(data).filter(
    key => !['name', 'version', 'author', 'description', 'services', 'config'].includes(key),
  )
  if (unknown.length) fail('不认识的字段 ' + unknown.join('、'))
  if (!text(data.name, 80)) fail('name 须为 1–80 字')
  if (!text(data.version, 40)) fail('version 须为 1–40 字')
  if (data.author !== undefined && !text(data.author, 80)) fail('author 须为 1–80 字')
  if (data.description !== undefined && !text(data.description, 500)) fail('description 须为 1–500 字')
  if (
    !Array.isArray(data.services) ||
    data.services.some(service => !SERVICES.includes(service)) ||
    new Set(data.services).size !== data.services.length
  )
    fail('services 须列出 ' + SERVICES.join('、') + ' 中用到的项，不能重复')
  let config: Record<string, PluginConfigField> | undefined
  if (data.config !== undefined) {
    if (!data.config || typeof data.config !== 'object' || Array.isArray(data.config)) fail('config 须为对象')
    const entries = Object.entries(data.config as Record<string, unknown>)
    if (entries.length > 24) fail('config 最多 24 个字段')
    config = Object.fromEntries(entries.map(([name, field]) => [name, configField(name, field, fail)]))
  }
  return {
    name: String(data.name).trim(),
    version: String(data.version).trim(),
    ...(data.author === undefined ? {} : { author: String(data.author).trim() }),
    ...(data.description === undefined ? {} : { description: String(data.description).trim() }),
    services: data.services as PluginManifest['services'],
    ...(config ? { config } : {}),
  }
}

function configField(name: string, value: unknown, fail: (detail: string) => never): PluginConfigField {
  if (!FIELD_NAME.test(name)) fail(`配置字段名 ${name} 须为字母开头的字母、数字或下划线`)
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`配置字段 ${name} 须为对象`)
  const field = value as Record<string, unknown>
  const allowed: Record<string, readonly string[]> = {
    string: ['default', 'enum', 'maxLength', 'secret'],
    number: ['default', 'minimum', 'maximum'],
    integer: ['default', 'minimum', 'maximum'],
    boolean: ['default'],
  }
  const extra = allowed[String(field.type)]
  if (!extra) fail(`配置字段 ${name} 的 type 须为 string、number、integer 或 boolean`)
  const unknown = Object.keys(field).filter(
    key => !['type', 'title', 'description', 'required', ...extra!].includes(key),
  )
  if (unknown.length) fail(`配置字段 ${name} 不支持 ${unknown.join('、')}`)
  if (!text(field.title, 60)) fail(`配置字段 ${name} 的 title 须为 1–60 字`)
  if (field.description !== undefined && !text(field.description, 300))
    fail(`配置字段 ${name} 的 description 须为 1–300 字`)
  if (field.required !== undefined && typeof field.required !== 'boolean')
    fail(`配置字段 ${name} 的 required 须为布尔值`)
  if (field.secret !== undefined && typeof field.secret !== 'boolean') fail(`配置字段 ${name} 的 secret 须为布尔值`)
  if (field.secret && (field.default !== undefined || field.enum !== undefined))
    fail(`密钥字段 ${name} 不能有默认值或选项`)
  if (
    field.enum !== undefined &&
    (!Array.isArray(field.enum) ||
      !field.enum.length ||
      field.enum.length > 32 ||
      field.enum.some(option => !text(option, 80)) ||
      new Set(field.enum).size !== field.enum.length)
  )
    fail(`配置字段 ${name} 的 enum 须为 1–32 个不重复的文字`)
  if (
    field.maxLength !== undefined &&
    !(Number.isSafeInteger(field.maxLength) && Number(field.maxLength) >= 1 && Number(field.maxLength) <= 4096)
  )
    fail(`配置字段 ${name} 的 maxLength 须为 1–4096`)
  for (const bound of ['minimum', 'maximum'] as const)
    if (field[bound] !== undefined && !Number.isFinite(field[bound])) fail(`配置字段 ${name} 的 ${bound} 须为数字`)
  const typed = field as unknown as PluginConfigField
  if (field.default !== undefined) {
    const problem = fieldProblem(typed, field.default)
    if (problem) fail(`配置字段 ${name} 的默认值${problem}`)
  }
  return typed
}

/** Why a value does not fit its field, or undefined. */
function fieldProblem(field: PluginConfigField, value: unknown): string | undefined {
  switch (field.type) {
    case 'string':
      if (typeof value !== 'string') return '须为文字'
      if (value.length > (field.maxLength ?? 4096)) return `最多 ${field.maxLength ?? 4096} 字`
      if (field.enum && !field.enum.includes(value)) return '不在可选项中'
      return undefined
    case 'boolean':
      return typeof value === 'boolean' ? undefined : '须为是或否'
    default:
      if (typeof value !== 'number' || !Number.isFinite(value)) return '须为数字'
      if (field.type === 'integer' && !Number.isSafeInteger(value)) return '须为整数'
      if (field.minimum !== undefined && value < field.minimum) return `不能小于 ${field.minimum}`
      if (field.maximum !== undefined && value > field.maximum) return `不能大于 ${field.maximum}`
      return undefined
  }
}

/** Non-secret values a player saved for this plugin; checked again at every launch. */
export function savedPluginConfig(manifest: PluginManifest | undefined, values: unknown): PluginConfig {
  if (values === undefined) return {}
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw new TypeError('插件配置须为对象。')
  const fields = manifest?.config ?? {}
  const result: Record<string, string | number | boolean> = {}
  for (const [name, value] of Object.entries(values as Record<string, unknown>)) {
    const field = fields[name]
    if (!field) throw new TypeError(`插件没有配置项 ${name}。`)
    if (field.type === 'string' && field.secret) throw new TypeError(`${field.title} 是密钥，不能保存在设置里。`)
    const problem = fieldProblem(field, value)
    if (problem) throw new TypeError(`${field.title}${problem}。`)
    result[name] = value as string | number | boolean
  }
  return result
}

/** The object the plugin receives: defaults, then saved values, then secrets; required fields present. */
export function resolvePluginConfig(
  manifest: PluginManifest | undefined,
  values: unknown,
  secrets: Readonly<Record<string, string>> = {},
): PluginConfig {
  const fields = manifest?.config ?? {}
  const result: Record<string, string | number | boolean> = {}
  for (const [name, field] of Object.entries(fields)) if (field.default !== undefined) result[name] = field.default
  Object.assign(result, savedPluginConfig(manifest, values))
  for (const [name, value] of Object.entries(secrets)) {
    const field = fields[name]
    if (!field || field.type !== 'string' || !field.secret) throw new TypeError(`插件没有密钥项 ${name}。`)
    const problem = fieldProblem(field, value)
    if (problem) throw new TypeError(`${field.title}${problem}。`)
    if (value) result[name] = value
  }
  const missing = Object.entries(fields).filter(
    ([name, field]) => field.required && (result[name] === undefined || result[name] === ''),
  )
  if (missing.length) throw new TypeError('请先填写：' + missing.map(([, field]) => field.title).join('、') + '。')
  return result
}

/** Field names whose values live in the credential store. */
export function pluginSecretFields(manifest: PluginManifest | undefined): string[] {
  return Object.entries(manifest?.config ?? {})
    .filter(([, field]) => field.type === 'string' && field.secret)
    .map(([name]) => name)
}
