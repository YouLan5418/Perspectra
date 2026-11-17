import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  compileWorldPackSource,
  validatePackAuthoring,
  parseWorldPackSourceManifestV5,
  type WorldPackComposition,
  type PackPluginDescriptor,
} from '@perspectra/world-pack'
import { hostPluginSettings, hostPluginNativeAllowed, type HostPluginSettings } from './host-plugin-settings.ts'
import { readPluginManifest } from './plugin-manifest-file.ts'
import { officialPackPlugins, validatePackScript } from './official-pack-metadata.ts'
import { installPluginResolver } from './plugin-resolve.ts'

/** Discovery is data-only. Permission, enablement and version are checked before importing validators. */
export async function packValidationCatalog(
  pack: WorldPackComposition,
  settingsInput: readonly HostPluginSettings[],
): Promise<readonly PackPluginDescriptor[]> {
  const settings = hostPluginSettings([...settingsInput])
  const catalog = new Map(officialPackPlugins.map(plugin => [plugin.id, plugin]))
  const discovered = await Promise.all(
    settings.map(async setting => ({
      setting,
      manifest: await readPluginManifest(setting.path).catch(() => undefined),
    })),
  )
  const selected: typeof discovered = []
  for (const [id, wanted] of Object.entries(pack.plugins ?? {})) {
    if (catalog.has(id)) continue
    const entries = discovered.filter(entry => entry.manifest?.id === id)
    if (entries.length !== 1) throw new TypeError(id + ': missing or duplicate installed native plugin')
    const entry = entries[0]!
    if (!entry.setting.enabled || !hostPluginNativeAllowed(entry.setting))
      throw new TypeError(id + ': native execution is not allowed or enabled')
    if (wanted.version !== undefined && wanted.version !== entry.manifest!.version)
      throw new TypeError(id + ': native version does not match pack selection')
    selected.push(entry)
  }
  // All selections passed the permission check before any executable validator is imported.
  installPluginResolver()
  for (const { setting, manifest } of selected) {
    let imported: { packPlugin?: PackPluginDescriptor }
    try {
      imported = await import(pathToFileURL(setting.path).href)
    } catch {
      throw new TypeError(manifest!.id + ': native validator module import failed')
    }
    const descriptor = imported.packPlugin
    if (!descriptor || descriptor.id !== manifest!.id || descriptor.version !== manifest!.version)
      throw new TypeError(manifest!.id + ': export packPlugin with matching manifest identity for author validation')
    catalog.set(descriptor.id, descriptor)
  }
  return [...catalog.values()]
}

export async function validateInstalledPack(
  packPath: string,
  settings: readonly HostPluginSettings[],
): Promise<string> {
  const source = parseWorldPackSourceManifestV5(
    JSON.parse(readFileSync(join(packPath, 'worldpack.source.json'), 'utf8')),
  )
  const content = await packValidationCatalog(source, settings)
  const pack = await compileWorldPackSource(packPath, [])
  validatePackAuthoring(pack, file => readFileSync(join(packPath, file), 'utf8'), {
    content,
    validateScript: validatePackScript,
  })
  return Object.keys(pack.services ?? {}).length
    ? '尚待宿主核对 services：' +
        Object.entries(pack.services ?? {})
          .map(([key, id]) => key + '=' + id)
          .join('、')
    : ''
}
