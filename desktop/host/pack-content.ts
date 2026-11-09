import { createHash } from 'node:crypto'
import type {
  ContentGenerator,
  GeneratedStatusModule,
  RulesInstance,
  SeamProvider,
  StatusModuleSource,
} from '@harness-world/plugin-sdk'
import { generatePackContent, type CompiledWorldPackV5 } from '@harness-world/world-pack'
import { lockedPackAsset } from './pack-modules.ts'

/** What the composition's content generators made for one pack from the config files it registers. The pack
 * itself carries only those config files. */
export interface PackContent {
  /** Each tagged with the generator that made it, for collision messages. */
  readonly statusModules: readonly (GeneratedStatusModule & { readonly generator: string })[]
  readonly activities: readonly { readonly key: string; readonly source: string; readonly generator: string }[]
  /** Rules layers in generator order; they sit inside the rule plugins the player chose. */
  readonly rules: readonly SeamProvider<RulesInstance>[]
  /** Per generator id: sha256 of its id, version, the parsed config and every generated source. A save keeps the
   * ones it was created with. The config covers what only a rules layer reads, such as locked exits. */
  readonly hashes: Readonly<Record<string, string>>
}

/** Generate a pack's content with every generator whose config file it registers; undefined when there is none.
 * Status-module ids and activity keys must not clash between generators; a clash with the pack's own modules and
 * activities is caught where those load. Everything fails before the world opens. */
export function loadPackContent(
  packPath: string,
  pack: CompiledWorldPackV5,
  generators: readonly ContentGenerator[] = [],
): PackContent | undefined {
  const results = generatePackContent(pack, generators, file => lockedPackAsset(packPath, pack, file))
  if (!results.length) return undefined
  const statusModules: (GeneratedStatusModule & { generator: string })[] = []
  const activities: { key: string; source: string; generator: string }[] = []
  const rules: SeamProvider<RulesInstance>[] = []
  const hashes: Record<string, string> = {}
  const moduleBy = new Map<string, string>(),
    activityBy = new Map<string, string>()
  for (const { generator, config, generated } of results) {
    const modules = generated.statusModules ?? [],
      made = generated.activities ?? []
    for (const module of modules) {
      const other = moduleBy.get(module.declaration.id)
      if (other !== undefined)
        throw new TypeError(`${generator.id} 插件生成的模块 ${module.declaration.id} 与 ${other} 插件生成的重名`)
      moduleBy.set(module.declaration.id, generator.id)
      statusModules.push({ ...module, generator: generator.id })
    }
    for (const activity of made) {
      const other = activityBy.get(activity.key)
      if (other !== undefined)
        throw new TypeError(`${generator.id} 插件生成的活动 ${activity.key} 与 ${other} 插件生成的重名`)
      activityBy.set(activity.key, generator.id)
      activities.push({ ...activity, generator: generator.id })
    }
    if (generated.rules) rules.push(generated.rules)
    hashes[generator.id] =
      'sha256:' +
      createHash('sha256')
        .update(
          JSON.stringify({
            plugin: { id: generator.id, version: generator.version },
            config,
            statusModules: modules,
            activities: made,
          }),
        )
        .digest('hex')
  }
  return { statusModules, activities, rules, hashes }
}

/** The generated status modules as a status mechanism receives them, for a caller that opens status without
 * PackModules. */
export function generatedStatusModuleSources(content: PackContent): StatusModuleSource[] {
  return content.statusModules.map(({ declaration, source }) => ({
    id: declaration.id,
    source,
    characters: [...declaration.characters],
    unavailableCapabilities: [],
  }))
}

/** A save opens only with the generated content it was created with; a generator the save has no record of yet
 * takes the current content. */
export function assertSavedPackContent(
  saved: Readonly<Record<string, string>> | undefined,
  current: Readonly<Record<string, string>>,
): void {
  for (const [id, before] of Object.entries(saved ?? {})) {
    const hash = Object.hasOwn(current, id) ? current[id] : undefined
    if (before !== hash) throw new Error(`${id} 插件生成的规则与存档不一致（存档 ${before}，当前 ${hash ?? '缺失'}）`)
  }
}
