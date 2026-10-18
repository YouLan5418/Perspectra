/** Trusted local host modules. Credentials belong to each plugin, never this metadata. */
export interface HostPluginSettings { id: string; path: string; enabled: boolean }

export function hostPluginSettings(value: unknown): HostPluginSettings[] {
  if (!Array.isArray(value) || value.length > 16) throw new TypeError('宿主插件须为列表，最多 16 项。')
  const ids = new Set<string>()
  return value.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new TypeError('宿主插件配置无效。')
    const plugin = item as Record<string, unknown>
    if (Object.keys(plugin).sort().join(',') !== 'enabled,id,path'
      || typeof plugin.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(plugin.id)
      || ids.has(plugin.id) || typeof plugin.enabled !== 'boolean'
      || typeof plugin.path !== 'string' || plugin.path.length > 4096 || plugin.path.includes('\0')) {
      throw new TypeError('插件 ID 须为不重复的小写字母、数字或连字符，加载开关与路径须有效。')
    }
    const path = plugin.path.trim()
    if ((plugin.enabled || path) && (!/^(?:[a-z]:[\\/]|\/|\\\\)/i.test(path) || !/\.(?:mjs|js)$/i.test(path))) {
      throw new TypeError('请选择本地插件 .mjs / .js 文件的绝对路径。')
    }
    ids.add(plugin.id)
    return { id: plugin.id, path, enabled: plugin.enabled }
  })
}
