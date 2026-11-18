import { GameplayScript } from '../official-bundle.ts'
import { officialPackPlugins, validatePackScript } from '../official-pack-metadata.ts'
import { createHash } from 'node:crypto'
import { canonicalizeWorldJson, type WorldJsonValue } from '@perspectra/sdk/contracts'
import {
  parseEventBook,
  type EventBook,
  resolveSupportedDataVersions,
  type ContentGenerator,
  type GeneratedActivity,
  type GeneratedStatusModule,
  type RulesInstance,
  type SeamProvider,
  type StatusModuleSource,
  type ContentGameplay,
} from '@perspectra/sdk'
import {
  packContentFacts,
  generatePackContent,
  validatePackComposition,
  type PackPluginDescriptor,
  type CompiledWorldPackV5,
} from '@perspectra/world-pack'
import { lockedPackAsset } from './pack-modules.ts'
import type {
  PluginSetRecord,
  SavedPluginDataActivity,
  SavedPluginDataRecord,
  SavedPluginDataState,
} from './plugin-set.ts'

export interface LoadedPluginDataCompatibility {
  readonly record: SavedPluginDataRecord
  readonly supportedDataVersions: readonly number[]
}

/** 玩法插件为当前包构造的原生状态模块、原生活动、规则层与持久数据兼容声明。 */
export interface PackContent {
  readonly worldEvents?: EventBook
  readonly scriptDefinitions: ReadonlySet<ContentGameplay>
  readonly configs: ReadonlyMap<ContentGameplay, import('@perspectra/sdk/contracts').WorldJsonObject>
  close(): void
  readonly gameplay: readonly ContentGameplay[]
  /** 每个状态模块标记来源插件 id，用于重名诊断。 */
  readonly statusModules: readonly (GeneratedStatusModule & { readonly generator: string })[]
  /** 每个活动标记来源插件 id，用于重名诊断。 */
  readonly activities: readonly (GeneratedActivity & { readonly generator: string })[]
  /** 按插件顺序排列的规则层。 */
  readonly rules: readonly SeamProvider<RulesInstance>[]
  /** 按插件 id 记录的持久数据兼容声明与当前元信息。 */
  readonly compatibility: Readonly<Record<string, LoadedPluginDataCompatibility>>
  /** 写入 plugin-set.json 的结构化持久数据兼容记录。 */
  readonly gameplayData: Readonly<Record<string, SavedPluginDataRecord>>
  /** 按插件 id 汇总的配置与实现标识摘要，供诊断与尾部重生成候选比较使用。 */
  readonly hashes: Readonly<Record<string, string>>
}

/** 解析包内声明的玩法配置文件，构造原生状态、活动和规则层，并生成持久数据兼容声明与摘要。 */
export function loadPackContent(
  packPath: string,
  pack: CompiledWorldPackV5,
  generators: readonly ContentGenerator[] = [],
  installed: readonly PackPluginDescriptor[] = [],
): PackContent | undefined {
  const catalog = new Map(
    officialPackPlugins.filter(plugin => !('generate' in plugin)).map(plugin => [plugin.id, plugin]),
  )
  for (const plugin of [...installed, ...generators]) catalog.set(plugin.id, plugin)
  validatePackComposition(pack, [...catalog.values()], file => lockedPackAsset(packPath, pack, file))
  const results = generatePackContent(pack, generators, file => lockedPackAsset(packPath, pack, file))
  const scriptDefinitions = new Set<ContentGameplay>()
  const configs = new Map<ContentGameplay, import('@perspectra/sdk/contracts').WorldJsonObject>()
  let script: GameplayScript | undefined
  if (pack.scripts?.gameplay) {
    const { entry, config = {} } = pack.scripts.gameplay
    const source = lockedPackAsset(packPath, pack, entry)
    validatePackScript(source, config, pack)
    script = new GameplayScript(source, entry)
    const definition = script.definition
    scriptDefinitions.add(definition)
    configs.set(definition, config)
    if (results.some(result => result.generator.id === definition.id))
      throw new TypeError('Duplicate gameplay ID: ' + definition.id)
    results.push({
      generator: {
        id: definition.id,
        version: definition.version,
        configFile: entry,
        dataVersion: definition.dataVersion,
        ...(definition.supportedDataVersions ? { supportedDataVersions: definition.supportedDataVersions } : {}),
        identity: 'sha256:' + createHash('sha256').update(source).digest('hex'),
        generate: () => ({ gameplay: [definition] }),
      },
      config,
      generated: { gameplay: [definition] },
    })
  }
  if (!results.length) return undefined
  const statusModules: (GeneratedStatusModule & { generator: string })[] = []
  const activities: (GeneratedActivity & { generator: string })[] = []
  const rules: SeamProvider<RulesInstance>[] = []
  const gameplay: ContentGameplay[] = []
  const compatibility: Record<string, LoadedPluginDataCompatibility> = {}
  const gameplayData: Record<string, SavedPluginDataRecord> = {}
  const hashes: Record<string, string> = {}
  const moduleBy = new Map<string, string>(),
    activityBy = new Map<string, string>()

  let worldEvents: EventBook | undefined
  for (const { generator, config, generated } of results) {
    if (generated.worldEventRules !== undefined) {
      if (worldEvents || (pack.plugins?.[generator.id]?.config ?? generator.configFile) !== 'world-events.json')
        throw new TypeError('world-events requires one selected producer for world-events.json')
      const book = parseEventBook(
        JSON.parse(lockedPackAsset(packPath, pack, 'world-events.json')),
        packContentFacts(pack),
      )
      if (!Array.isArray(generated.worldEventRules) || generated.worldEventRules.length > book.rules.length)
        throw new TypeError('world-events: invalid candidate rule IDs')
      const ids = new Set(generated.worldEventRules)
      if ([...ids].some(id => !book.rules.some(rule => rule.id === id)))
        throw new TypeError('undeclared world event rule')
      worldEvents = {
        rules: book.rules.filter(rule => ids.has(rule.id)),
        grants: book.grants.filter(grant => Object.hasOwn(pack.plugins ?? {}, grant.plugin)),
      }
    }
    gameplay.push(...(generated.gameplay ?? []))
    for (const definition of generated.gameplay ?? [])
      if (!configs.has(definition))
        configs.set(
          definition,
          generated.gameplayConfig ?? (config as import('@perspectra/sdk/contracts').WorldJsonObject),
        )
    const supportedDataVersions = resolveSupportedDataVersions(generator, generator.id)
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

    const statuses: SavedPluginDataState[] = generated.gameplay?.length
      ? generated.gameplay.flatMap(def =>
          (def.states ?? []).map(status => ({ key: status.key, type: status.type, owner: status.owner })),
        )
      : modules.flatMap(entry =>
          entry.module.definition.statuses.map(status => ({
            key: String(status.key),
            type: String(status.type),
            owner: String(status.owner),
          })),
        )
    const activityRecords: SavedPluginDataActivity[] = generated.gameplay?.length
      ? generated.gameplay.flatMap(def =>
          (def.activities ?? []).map(activity => ({
            key: activity.key,
            ...(activity.behavior?.phases ? { phases: [...activity.behavior.phases] } : {}),
          })),
        )
      : made.map(entry => ({
          key: entry.key,
          ...(entry.activity.phases ? { phases: [...entry.activity.phases] } : {}),
        }))

    const digest =
      'sha256:' +
      createHash('sha256')
        .update(
          canonicalizeWorldJson({
            plugin: {
              id: generator.id,
              version: generator.version,
              ...(generator.identity === undefined ? {} : { identity: generator.identity }),
            },
            dataVersion: generator.dataVersion,
            config: config as WorldJsonValue,
            statuses: statuses as unknown as WorldJsonValue,
            activities: activityRecords as unknown as WorldJsonValue,
          }),
        )
        .digest('hex')

    const record: SavedPluginDataRecord = {
      pluginVersion: generator.version,
      dataVersion: generator.dataVersion,
      statuses,
      activities: activityRecords,
      digest,
    }
    compatibility[generator.id] = { record, supportedDataVersions }
    gameplayData[generator.id] = record
    hashes[generator.id] = digest
  }
  return {
    ...(worldEvents ? { worldEvents } : {}),
    gameplay,
    statusModules,
    activities,
    rules,
    compatibility,
    gameplayData,
    hashes,
    scriptDefinitions,
    configs,
    close: () => script?.close(),
  }
}

/** 将玩法插件构造的原生状态模块转为状态机制输入（供分享预检等不经 PackModules 的调用方使用）。 */
export function generatedStatusModuleSources(content: PackContent): StatusModuleSource[] {
  return content.statusModules.map(({ declaration, module }) => ({
    id: declaration.id,
    module,
    characters: [...declaration.characters],
    unavailableCapabilities: [],
  }))
}

/**
 * 普通读档与分享节点导入预检的持久数据兼容检查：
 * 校验插件存在、supportedDataVersions 覆盖、持久状态键与归属／类型一致、活动标识与阶段覆盖；
 * 文案、标签与兼容逻辑或数值修复不会仅因摘要变化导致存档失效。
 */
export function assertSavedPackContent(
  saved: Pick<PluginSetRecord, 'gameplayData' | 'generatedContent'> | undefined,
  current: Readonly<Record<string, LoadedPluginDataCompatibility>>,
): void {
  if (saved?.generatedContent && Object.keys(saved.generatedContent).length > 0 && !saved.gameplayData) {
    throw new Error(
      '存档记录使用旧版生成脚本摘要（generatedContent），缺少插件数据兼容版本声明；当前版本不自动迁移旧实验存档',
    )
  }
  for (const [id, before] of Object.entries(saved?.gameplayData ?? {})) {
    const after = Object.hasOwn(current, id) ? current[id] : undefined
    if (!after) {
      throw new Error(
        `${id} 插件未启用或当前包不再声明其配置，无法打开依赖该插件数据（dataVersion ${before.dataVersion}）的存档`,
      )
    }
    if (!after.supportedDataVersions.includes(before.dataVersion)) {
      throw new Error(
        `${id} 插件的数据版本与存档不兼容（存档 dataVersion ${before.dataVersion}，当前支持 ${after.supportedDataVersions.join(', ')}）`,
      )
    }
    for (const savedStatus of before.statuses) {
      const nowStatus = after.record.statuses.find(item => item.key === savedStatus.key)
      if (!nowStatus) throw new Error(`${id} 插件缺少存档所需的状态标识 ${savedStatus.key}`)
      if (nowStatus.type !== savedStatus.type || nowStatus.owner !== savedStatus.owner) {
        throw new Error(
          `${id} 插件的状态 ${savedStatus.key} 含义与存档不兼容（存档 ${savedStatus.owner}/${savedStatus.type}，当前 ${nowStatus.owner}/${nowStatus.type}）`,
        )
      }
    }
    for (const savedActivity of before.activities) {
      const nowActivity = after.record.activities.find(item => item.key === savedActivity.key)
      if (!nowActivity) throw new Error(`${id} 插件缺少存档所需的活动标识 ${savedActivity.key}`)
      if (savedActivity.phases?.length) {
        const nowPhases = nowActivity.phases ?? []
        const missingPhase = savedActivity.phases.find(phase => !nowPhases.includes(phase))
        if (missingPhase !== undefined) {
          throw new Error(`${id} 插件的活动 ${savedActivity.key} 缺少存档所需的阶段标识 ${missingPhase}`)
        }
      }
    }
  }
}
