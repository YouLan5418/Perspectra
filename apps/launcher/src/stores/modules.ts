import type { HostPluginSettings } from '../../../../desktop/host-plugin-settings.ts'

/** The part of a plugin's manifest this needs; a missing or broken manifest has no `manifest`. */
type ManifestInfo = { readonly manifest: { readonly name: string; readonly services: readonly string[] } } | object

export const SEAMS = [
  { seam: 'scheduler', label: '角色调度', single: true },
  { seam: 'memory', label: '长期记忆', single: true },
  { seam: 'llm', label: '模型通道', single: true },
  { seam: 'decisions', label: '角色决策', single: false },
  { seam: 'rules', label: '世界规则', single: false },
] as const
export type Seam = (typeof SEAMS)[number]['seam']

export interface ModuleRow {
  readonly seam: Seam
  readonly label: string
  /** Only one plugin can hold this seam; the others stack. */
  readonly single: boolean
  readonly providers: readonly { readonly pluginId: string; readonly name: string; readonly enabled: boolean }[]
  /** What is in force, as the host decides it: the first enabled provider, in list order. */
  readonly effective: string
  /** More than one enabled for a seam that takes one: the host would skip all but the first. */
  readonly conflict: boolean
}

function manifestOf(info: ManifestInfo | undefined) {
  return info && 'manifest' in info ? info.manifest : undefined
}

export function moduleRows(
  plugins: readonly HostPluginSettings[],
  manifests: Readonly<Record<string, ManifestInfo>>,
): ModuleRow[] {
  return SEAMS.map(({ seam, label, single }) => {
    const providers = plugins.flatMap(plugin => {
      const manifest = manifestOf(manifests[plugin.id])
      return manifest?.services.includes(seam)
        ? [{ pluginId: plugin.id, name: manifest.name, enabled: plugin.enabled }]
        : []
    })
    const enabled = providers.filter(provider => provider.enabled)
    const effective = !enabled.length
      ? single
        ? '官方默认'
        : '无'
      : single
        ? enabled[0]!.name
        : enabled.map(provider => provider.name).join('、')
    return { seam, label, single, providers, effective, conflict: single && enabled.length > 1 }
  })
}

/** Leaves `pluginId` the only enabled provider of a seam, or none for the official default. */
export function pickProvider(plugins: HostPluginSettings[], row: ModuleRow, pluginId: string | null): void {
  for (const provider of row.providers) {
    const plugin = plugins.find(item => item.id === provider.pluginId)
    if (plugin) plugin.enabled = provider.pluginId === pluginId
  }
}
