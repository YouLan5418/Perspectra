import { readFile } from 'node:fs/promises'
import type { PluginManifest } from '@harness-world/plugin-sdk'
import { parsePluginManifest, pluginManifestPath } from './host-plugin-manifest.ts'

/** Reads `<entry>.plugin.json` without importing the plugin. No file means a plugin without a manifest,
 * which still loads with no config fields. */
export async function readPluginManifest(entry: string): Promise<PluginManifest | undefined> {
  let text: string
  try {
    text = await readFile(pluginManifestPath(entry), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new TypeError('插件清单无法读取。')
  }
  if (text.length > 65536) throw new TypeError('插件清单超过 64 KiB。')
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    throw new TypeError('插件清单不是有效的 JSON。')
  }
  return parsePluginManifest(data)
}
