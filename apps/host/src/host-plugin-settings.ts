/** Trusted local host modules. Credentials belong to each plugin, never this metadata. */
export interface HostPluginSettings {
  id: string
  path: string
  enabled: boolean
  /** Persistent consent to run this exact local file. Missing legacy values always mean false. */
  nativeAllowed?: boolean
  /** Non-secret values for the fields the plugin's manifest declares; secrets live in the credential store. */
  config?: Record<string, string | number | boolean>
}

export type HostPluginFailureReason = 'permission' | 'manifest' | 'config' | 'import' | 'version' | 'apply'

export const HOST_PLUGIN_FAILURE_TEXT: Record<HostPluginFailureReason, string> = {
  permission: '尚未允许在本机执行',
  manifest: '清单无效',
  config: '配置无效',
  import: '导入失败',
  version: '宿主 API 版本不兼容',
  apply: '初始化失败',
}

export function hostPluginLoadFailureMessage(
  pluginId: string,
  reason: HostPluginFailureReason,
  detail?: string,
): string {
  return (
    `插件 ${pluginId} ${HOST_PLUGIN_FAILURE_TEXT[reason]}${detail ? `（${detail}）` : ''}。` +
    '为避免改用其他实现，本次启动已停止。'
  )
}

/** Recognize only the exact host-generated message before crossing a child-process boundary. */
export function isSafeHostPluginFailureMessage(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 1000 || /[\r\n]/u.test(value)) return false
  const match =
    /^插件 ([a-z0-9][a-z0-9-]{0,63}) (.+?)(?:（([^\r\n）]{1,300})）)?。为避免改用其他实现，本次启动已停止。$/u.exec(
      value,
    )
  return !!match && Object.values(HOST_PLUGIN_FAILURE_TEXT).includes(match[2]!)
}

/** Installed and explicitly allowed. Future config-only checks use this without requiring `enabled`. */
export function hostPluginNativeAllowed(plugin: Pick<HostPluginSettings, 'path' | 'nativeAllowed'>): boolean {
  return plugin.path.trim().length > 0 && plugin.nativeAllowed === true
}

/** A module may be imported or applied only when it is installed, allowed and selected for this launch. */
export function shouldLoadHostPlugin(plugin: Pick<HostPluginSettings, 'path' | 'nativeAllowed' | 'enabled'>): boolean {
  return hostPluginNativeAllowed(plugin) && plugin.enabled
}

/** `{ pluginId: { field: value } }` handed over at launch. Values are never echoed in errors. */
export function pluginSecretValues(value: unknown): Record<string, Record<string, string>> {
  const fail = () => {
    throw new TypeError('插件密钥格式无效。')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail()
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([id, fields]) => {
      if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id) || !fields || typeof fields !== 'object' || Array.isArray(fields))
        fail()
      const entries = Object.entries(fields as Record<string, unknown>)
      if (
        entries.some(
          ([name, secret]) =>
            !/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/u.test(name) || typeof secret !== 'string' || secret.length > 8192,
        )
      )
        fail()
      return [id, Object.fromEntries(entries) as Record<string, string>]
    }),
  )
}

export function hostPluginSettings(value: unknown): HostPluginSettings[] {
  if (!Array.isArray(value) || value.length > 16) throw new TypeError('宿主插件须为列表，最多 16 项。')
  const ids = new Set<string>()
  return value.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new TypeError('宿主插件配置无效。')
    const plugin = item as Record<string, unknown>
    const keys = Object.keys(plugin)
      .filter(key => key !== 'config')
      .sort()
      .join(',')
    if (
      !['enabled,id,path', 'enabled,id,nativeAllowed,path'].includes(keys) ||
      typeof plugin.id !== 'string' ||
      !/^[a-z0-9][a-z0-9-]{0,63}$/.test(plugin.id) ||
      ids.has(plugin.id) ||
      typeof plugin.enabled !== 'boolean' ||
      (plugin.nativeAllowed !== undefined && typeof plugin.nativeAllowed !== 'boolean') ||
      typeof plugin.path !== 'string' ||
      plugin.path.length > 4096 ||
      plugin.path.includes('\0')
    ) {
      throw new TypeError('插件 ID 须为不重复的小写字母、数字或连字符，本机执行许可、加载开关与路径须有效。')
    }
    const path = plugin.path.trim()
    const nativeAllowed = plugin.nativeAllowed === true
    if (
      (plugin.enabled || nativeAllowed || path) &&
      (!/^(?:[a-z]:[\\/]|\/|\\\\)/i.test(path) || !/\.(?:mjs|js)$/i.test(path))
    ) {
      throw new TypeError('请选择本地插件 .mjs / .js 文件的绝对路径。')
    }
    // The shape only; whether each value fits the plugin's manifest is checked where the manifest is read.
    let config: Record<string, string | number | boolean> | undefined
    if (plugin.config !== undefined) {
      const entries =
        plugin.config && typeof plugin.config === 'object' && !Array.isArray(plugin.config)
          ? Object.entries(plugin.config as Record<string, unknown>)
          : undefined
      if (
        !entries ||
        entries.length > 24 ||
        entries.some(
          ([name, field]) =>
            !/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/u.test(name) ||
            !(
              (typeof field === 'string' && field.length <= 4096) ||
              typeof field === 'boolean' ||
              (typeof field === 'number' && Number.isFinite(field))
            ),
        )
      )
        throw new TypeError('插件配置须为最多 24 项的文字、数字或开关。')
      config = Object.fromEntries(entries) as Record<string, string | number | boolean>
    }
    ids.add(plugin.id)
    return { id: plugin.id, path, nativeAllowed, enabled: plugin.enabled, ...(config ? { config } : {}) }
  })
}
