import type { HostPluginSettings } from '../../../../desktop/host-plugin-settings.ts'

/** The part of a plugin's manifest this needs; a missing or broken manifest has no `manifest`. */
type ManifestInfo = { readonly manifest: { readonly name: string; readonly services: readonly string[] } } | object

export const SEAMS = [
  {
    seam: 'scheduler',
    label: '角色调度',
    single: true,
    description: '决定谁在什么时候获得处理机会。',
    official: 'official-scheduler',
  },
  {
    seam: 'memory',
    label: '长期记忆',
    single: true,
    description: '整理角色的经历，在它决策时取回。',
    official: 'official-memory-core',
  },
  {
    seam: 'llm',
    label: '模型通道',
    single: true,
    description: '把角色的决策发给模型，也管预设。',
    official: 'official-llm',
  },
  { seam: 'decisions', label: '角色决策', single: false, description: '给决策加内容，或包住整个决策。', official: '' },
  { seam: 'rules', label: '世界规则', single: false, description: '在官方规则外再加一层裁定。', official: '' },
] as const
export type Seam = (typeof SEAMS)[number]['seam']

export interface ModuleRow {
  readonly seam: Seam
  readonly label: string
  readonly description: string
  /** The id of whichever implementation is in force; empty when a stacking seam has none. */
  readonly chip: string
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
  return SEAMS.map(({ seam, label, single, description, official }) => {
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
    const chip = enabled.map(provider => provider.pluginId).join('、') || official
    return {
      seam,
      label,
      description,
      chip: single ? (enabled[0]?.pluginId ?? official) : chip,
      single,
      providers,
      effective,
      conflict: single && enabled.length > 1,
    }
  })
}

/** Leaves `pluginId` the only enabled provider of a seam, or none for the official default. */
export function pickProvider(plugins: HostPluginSettings[], row: ModuleRow, pluginId: string | null): void {
  for (const provider of row.providers) {
    const plugin = plugins.find(item => item.id === provider.pluginId)
    if (plugin) plugin.enabled = provider.pluginId === pluginId
  }
}

/** Fills in the manifest's id for a plugin just added. A saved plugin keeps its id: its secrets are stored under it. */
export function filledPluginId(id: string, manifestId: string | undefined, savedIds: readonly string[]): string {
  return manifestId && /^plugin-[0-9a-f-]+$/u.test(id) && !savedIds.includes(id) ? manifestId : id
}
