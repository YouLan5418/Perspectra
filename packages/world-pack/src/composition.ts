import Ajv from 'ajv'
import type { CompiledWorldPackV5, WorldPackComposition } from './contracts.ts'
import { packContentFacts, type PackContentFacts } from './pack-content.ts'

export const PACK_CONFIG_BYTE_LIMIT = 1024 * 1024

export interface PackConfigIssue {
  readonly path: string
  readonly message: string
}
/** Installed metadata and pure validators, injected by the process entry. No runtime is opened. */
export interface PackPluginDescriptor {
  readonly id: string
  readonly version: string
  readonly configFile?: string
  readonly requiredPlugins?: readonly string[]
  readonly configSchema?: object
  readonly validateConfig?: (config: unknown, pack: PackContentFacts) => readonly PackConfigIssue[]
}

export class PackCompositionError extends Error {
  constructor(
    readonly code: 'PACK_COMPOSITION_INVALID' | 'PLUGIN_VALIDATOR_FAULT',
    message: string,
  ) {
    super(message)
    this.name = 'PackCompositionError'
  }
}
const invalid = (message: string): never => {
  throw new PackCompositionError('PACK_COMPOSITION_INVALID', message)
}
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

/** Paths refer to locked assets; this also validates the compiled envelope on read. */
export function parsePackComposition(root: Record<string, unknown>, assets: readonly string[]): WorldPackComposition {
  const result: WorldPackComposition = {}
  const paths: string[] = []
  if (root.plugins !== undefined) {
    if (!object(root.plugins)) invalid('/plugins must be an object')
    const plugins: Record<string, { version?: string; config?: string }> = {}
    for (const [id, entry] of Object.entries(root.plugins as Record<string, unknown>)) {
      if (!/^[a-z][a-z0-9.:_-]{0,127}$/u.test(id) || !object(entry)) invalid('/plugins/' + id + ' is invalid')
      const value = entry as Record<string, unknown>
      if (Object.keys(value).some(key => !['version', 'config'].includes(key)))
        invalid('/plugins/' + id + ' has unknown fields')
      for (const key of ['version', 'config'])
        if (value[key] !== undefined && (typeof value[key] !== 'string' || !(value[key] as string).trim()))
          invalid('/plugins/' + id + '/' + key + ' must be nonempty')
      if (value.config !== undefined) paths.push(value.config as string)
      plugins[id] = value as { version?: string; config?: string }
    }
    Object.assign(result, { plugins })
  }
  if (root.services !== undefined) {
    if (!object(root.services)) invalid('/services must be an object')
    for (const [key, value] of Object.entries(root.services as Record<string, unknown>))
      if (
        !['scheduler', 'characterLoop', 'memory', 'llm', 'status', 'activities', 'communication', 'knowledge'].includes(
          key,
        ) ||
        typeof value !== 'string' ||
        !value.trim()
      )
        invalid('/services/' + key + ' is invalid')
    Object.assign(result, { services: root.services })
  }
  if (root.scripts !== undefined) {
    if (!object(root.scripts) || Object.keys(root.scripts).some(key => key !== 'gameplay'))
      invalid('/scripts is invalid')
    const script = (root.scripts as Record<string, unknown>).gameplay
    if (
      !object(script) ||
      typeof script.entry !== 'string' ||
      Object.keys(script).some(key => !['entry', 'config'].includes(key)) ||
      (script.config !== undefined && !object(script.config))
    )
      invalid('/scripts/gameplay is invalid')
    paths.push((script as Record<string, unknown>).entry as string)
    Object.assign(result, { scripts: root.scripts })
  }
  for (const path of paths)
    if (
      !assets.includes(path) ||
      path.includes('\\') ||
      path.startsWith('/') ||
      path.split('/').some(part => !part || part === '.' || part === '..')
    )
      invalid(path + ' must name an assetFiles entry inside the pack')
  return result
}

export function selectedPluginConfig(pack: CompiledWorldPackV5, plugin: PackPluginDescriptor): string | undefined {
  return pack.plugins?.[plugin.id]?.config ?? plugin.configFile
}

/** Explicit selection only. A dependency is never silently enabled and a validator never opens a provider. */
export function validatePackComposition(
  pack: CompiledWorldPackV5,
  installed: readonly PackPluginDescriptor[],
  read: (file: string) => string,
): void {
  const byId = new Map<string, PackPluginDescriptor>()
  for (const descriptor of installed) {
    if (byId.has(descriptor.id)) invalid('Duplicate installed plugin: ' + descriptor.id)
    byId.set(descriptor.id, descriptor)
  }
  const facts = packContentFacts(pack)
  for (const [id, selection] of Object.entries(pack.plugins ?? {})) {
    const plugin = byId.get(id)
    if (!plugin) invalid('Selected plugin is not installed or allowed: ' + id)
    const selected = plugin!
    if (selection.version !== undefined && selection.version !== selected.version)
      invalid(id + ': required version ' + selection.version + ', installed ' + selected.version)
    for (const dependency of selected.requiredPlugins ?? [])
      if (!Object.hasOwn(pack.plugins ?? {}, dependency)) invalid(id + ': explicitly declare dependency ' + dependency)
    const file = selectedPluginConfig(pack, selected)
    let config: unknown = {}
    if (file !== undefined) {
      if (!pack.assets.some(asset => asset.path === file)) invalid(id + ': missing config asset ' + file)
      let text: string
      try {
        text = read(file)
      } catch {
        invalid(id + ': cannot read config asset ' + file)
      }
      if (Buffer.byteLength(text!) > PACK_CONFIG_BYTE_LIMIT) invalid(id + ': config exceeds 1 MiB: ' + file)
      try {
        config = JSON.parse(text!)
      } catch {
        invalid(id + ': invalid JSON config ' + file)
      }
    }
    validatePluginConfig(selected, config, facts, file)
  }
}

export function assertServiceRequirements(
  pack: WorldPackComposition,
  selected: Readonly<Record<string, { readonly id: string } | undefined>>,
): void {
  for (const [service, id] of Object.entries(pack.services ?? {}))
    if (selected[service]?.id !== id)
      invalid('/services/' + service + ' requires ' + id + ', selected ' + (selected[service]?.id ?? 'none'))
}

export function validatePluginConfig(
  plugin: PackPluginDescriptor,
  config: unknown,
  facts: PackContentFacts,
  file?: string,
): void {
  const ajv = new Ajv({ strict: true, coerceTypes: false, removeAdditional: false })
  let issues: readonly PackConfigIssue[] = []
  try {
    if (plugin.configSchema) {
      const validate = ajv.compile(plugin.configSchema)
      if (!validate(config))
        issues = (validate.errors ?? []).map(error => ({
          path: error.instancePath,
          message: error.message ?? 'invalid',
        }))
    }
    if (!issues.length && plugin.validateConfig)
      issues = plugin.validateConfig(structuredClone(config), structuredClone(facts))
    if (
      !Array.isArray(issues) ||
      issues.some(issue => !object(issue) || typeof issue.path !== 'string' || typeof issue.message !== 'string')
    )
      throw new TypeError('invalid validator result')
  } catch {
    throw new PackCompositionError('PLUGIN_VALIDATOR_FAULT', plugin.id + ': config validator failed')
  }
  if (issues.length)
    invalid(
      plugin.id +
        ' ' +
        (file ?? '/plugins/' + plugin.id) +
        ': ' +
        issues.map(issue => issue.path + ' ' + issue.message).join('; '),
    )
}
