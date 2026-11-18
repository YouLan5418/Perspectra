import type { WorldJsonValue } from '@perspectra/sdk/contracts'
import type { ActivityHooks } from './activities.ts'
import type { GameplayDataCompatibility } from './gameplay.ts'
import type { GameplayDefinition, OperationDefinition } from './gameplay.ts'
import type { WorldJsonObject } from '@perspectra/sdk/contracts'

export type ContentGameplay = GameplayDefinition<
  WorldJsonObject,
  readonly OperationDefinition<WorldJsonObject, WorldJsonObject, WorldJsonValue>[],
  WorldJsonObject,
  WorldJsonValue,
  readonly OperationDefinition<WorldJsonObject, WorldJsonObject, WorldJsonValue>[]
>
import type { RulesInstance } from './rules.ts'
import type { StatusModuleHooks } from './status.ts'
import type { SeamProvider } from './world.ts'

/** 玩法插件从配置构造的原生状态模块定义，不落地也不拼接脚本文本。 */
export interface GeneratedStatusModule {
  readonly declaration: {
    readonly id: string
    readonly characters: readonly string[]
    readonly capabilities?: readonly []
  }
  readonly module: StatusModuleHooks
}

/** 玩法插件从配置构造的原生活动定义。 */
export interface GeneratedActivity {
  readonly key: string
  readonly activity: ActivityHooks
}

/** 玩法插件根据包内配置文件构造的原生状态模块、原生活动与规则层。 */
export interface GeneratedContent {
  readonly worldEventRules?: readonly string[]
  /** Override the generator input only when generated definitions close over config rather than consuming it. */
  readonly gameplayConfig?: WorldJsonObject
  readonly gameplay?: readonly ContentGameplay[]
  readonly statusModules?: readonly GeneratedStatusModule[]
  readonly activities?: readonly GeneratedActivity[]
  readonly rules?: SeamProvider<RulesInstance>
}

/** The pack facts a generator may check its config against and use in the text it generates. */
export interface ContentPackFacts {
  characterIds: string[]
  locationIds: string[]
  entityIds: string[]
  /** Where each entity starts: a location, or null when a character holds it. */
  entityLocations: Record<string, string | null>
  /** The pack's first player slot; absent when the pack has none. */
  playerId?: string
  /** Display names of characters and locations. */
  names: Record<string, string>
}

/** 将包内声明的玩法配置文件解析为原生状态、活动和规则层，并声明持久数据兼容版本。 */
export interface ContentGenerator extends GameplayDataCompatibility {
  readonly id: string
  readonly version: string
  /** Pack-relative config file, registered in assetFiles, e.g. 'rpg.json'. */
  readonly configFile: string
  /** Dependencies are required declarations, never automatically enabled. */
  readonly requiredPlugins?: readonly string[]
  readonly configSchema?: object
  /** Expected invalid author input returns issues; unexpected throws are plugin faults. */
  readonly validateConfig?: (
    config: unknown,
    pack: ContentPackFacts,
  ) => readonly { readonly path: string; readonly message: string }[]
  /** 可选规则实现标识，纳入配置与环境摘要用于重生成候选比较与诊断。 */
  readonly identity?: WorldJsonValue
  /** Parse and generate; throw a TypeError whose message starts with the JSON path on bad config. */
  generate(config: unknown, pack: ContentPackFacts): GeneratedContent
}

/** `ctx.content`: any number of generators, one per id and per config file. Wrap `register` in `ctx.effect()`. */
export interface ContentApi {
  register(generator: ContentGenerator): () => void
  readonly generators: readonly ContentGenerator[]
}
