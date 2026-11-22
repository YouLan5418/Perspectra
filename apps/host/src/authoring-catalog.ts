import { WORLD_PACK_COMPILER_VERSION_V5, WORLD_PACK_SOURCE_SCHEMA_VERSION_V5 } from '@perspectra/world-pack'
import product from '../../../package.json' with { type: 'json' }
import { officialPackPlugins } from './official-pack-metadata.ts'

const scope = {
  schemaVersion: 'worldpack-authoring-catalog/v1',
  sourceSchemaVersion: WORLD_PACK_SOURCE_SCHEMA_VERSION_V5,
  productVersion: product.version,
  compilerVersion: WORLD_PACK_COMPILER_VERSION_V5,
  scope: 'bundled-authoring-definitions',
  coverage: 'partial',
  authority: 'none',
  packAvailability: 'not-evaluated',
  hostAvailability: 'not-evaluated',
} as const

function entries() {
  return officialPackPlugins.flatMap(plugin =>
    (plugin.authoring ?? []).map(feature => ({
      plugin,
      feature,
      summary: {
        id: plugin.id + '/' + feature.key,
        version: feature.version,
        provider: { kind: 'pack-plugin' as const, id: plugin.id, version: plugin.version },
        title: feature.title,
        summary: feature.summary,
      },
    })),
  )
}

/** Pure, detached projections. No package, save, provider session or execution authority is involved. */
export function listAuthoringCapabilities() {
  return { ...scope, capabilities: entries().map(entry => entry.summary) }
}

export function describeAuthoringCapability(id: string) {
  const entry = entries().find(e => e.summary.id === id)
  if (!entry) throw new TypeError('当前构建的创作目录未列出能力 ' + id + '，可用 worldpack catalog list 查看 ID。')
  const { plugin, feature, summary } = entry
  const exampleFile = feature.exampleFile ?? plugin.configFile
  if (!exampleFile) throw new Error('Missing authoring example file for ' + id)
  const unconditional = feature.requirements.filter(condition => condition.when === 'always')
  const requiredPlugins = [
    ...new Set([...(plugin.requiredPlugins ?? []), ...unconditional.flatMap(r => r.plugin ?? [])]),
  ]
  const selection = Object.fromEntries(requiredPlugins.map(dependency => [dependency, {}]))
  const assets = [exampleFile, ...unconditional.flatMap(r => r.asset ?? [])]
  return structuredClone({
    ...scope,
    capability: {
      ...summary,
      configuration: {
        defaultFile: plugin.configFile ?? null,
        ...feature.configuration,
        ...(plugin.configSchema ? { schema: plugin.configSchema } : {}),
      },
      requiredPlugins,
      requirements: feature.requirements,
      example: {
        manifestFragment: {
          plugins: { ...selection, [plugin.id]: { version: plugin.version, config: exampleFile } },
          assetFiles: assets,
        },
        file: exampleFile,
        config: feature.exampleConfig,
      },
      verify: feature.verify,
    },
  })
}
