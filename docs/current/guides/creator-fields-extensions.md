# 通信、插件模块与试玩推演的字段

当阿林离开门廊后，要让她仍能给玩家发短信，需要配置有向联系人。要验证只有收件人读到短信，可以另写一份推演剧本。联系人随作品发布，剧本可留在作者工作区。[创作者字段总览](creator-fields.md)

## 通信

在创作工作台的「角色通讯录」选择角色即可设置收信和发信方向。启用时自动登记配置文件，以后也可以在角色记录直接打开自己的联系人。[设置单向或双向通讯录](world-workbench.md#设置单向或双向通讯录)

选择 `plugins.official-communication`，将 `communication.json` 或该选择的 `config` 路径列入 `assetFiles`。文件本身对普通世界选填，启用该玩法时必填。[配置入口](../../../apps/host/src/runtime/gameplay-source.ts) · [格式校验](../../../packages/sdk/src/contracts/gameplay.ts) · [角色引用校验](../../../packages/core/src/application/communication-state.ts)

| 字段 | 要求 | 填什么 |
| --- | --- | --- |
| `medium` | 必填 | 媒介显示名，例如“短信”。非空白字符串，最多 40 个字符。 |
| `contacts` | 必填 | 从发送角色 ID 到收件角色 ID 数组的对象，可为 `{}`。 |
| `contacts.<发送者ID>[]` | 选填每个发送者 | 值中的角色和键中的角色须在世界中存在。可以设单向联系，双向需各写一条。名单不能有本人或重复项。 |

## 包内插件模块

选择 `plugins.pack-scripts`，将 `plugins.json` 和其中引用的 JS 都列入 `assetFiles`。包可以通过这些模块声明状态操作，以及向已安装能力提交请求。[加载器](../../../apps/host/src/runtime/pack-modules.ts) · [包内模块实例](../../../examples/world-packs/plugin-capabilities-demo/plugins/greetings.js)

| 对象 | 必填 | 选填或条件 | 说明 |
| --- | --- | --- | --- |
| `plugins.json` 根 | `modules` | — | 数组，最多 16 个模块。 |
| `modules[]` | `id`, `entry`, `characters`, `capabilities` | — | JS 路径采用 `plugins/*.js`。角色 ID 不重复。没有原生依赖时也填 `capabilities: []`。 |
| `capabilities[]` | `id`, `version`, `required`, `config` | — | 精确能力 ID 和版本、布尔值、配置对象（可为 `{}`）。`required: true` 的能力缺失会阻止开局；`false` 时缺失会隐藏对应操作。多个模块引用同一能力，声明要一致。 |
| JS 的 `packPlugin` | `definition`, `initialize`, `policy`, `resolve` | 外部能力操作需实现 `prepare` | `definition` 是定义，其他成员是同步函数。按初始化、生成候选、裁定操作等调用点执行。 |
| `definition` | `statuses`, `actions` | — | 两个数组。状态键以模块 ID 加连字符开头，模块内操作 ID 会由宿主加此前缀。状态与操作字段见[玩法字段](creator-fields-gameplay.md)。 |
| `definition.actions[]` 的外部调用扩展 | 使用能力时 `capability` 和 `method` 两者必填 | 普通操作可都省略 | 所指能力要先声明，方法名要与提供方一致。 |
| `initialize` 返回 | `public`, `characters` | `reveals` | 公共初值、按角色分组的初值、初始揭示。 |
| `policy` 返回 | `operations` | — | 本次允许的模块内操作 ID 列表。当前包模块合并器从这项返回值取候选。 |
| `prepare` 返回 | 方法接受的参数对象 | 由所选方法的 Schema 决定子字段 | 只在外部操作使用。 |
| `resolve` 返回 | 拒绝时 `rejectReason`，接受时按状态操作结算格式 | 见[玩法字段](creator-fields-gameplay.md) | 只有原生完成结果进入此处裁定。函数参数中的角色、授权视图、真值及外部返回均由宿主传入。 |

模块初始化与执行方式见[脚本调用](../../../packages/providers/src/status/modules.ts)、[状态模块合并](../../../packages/providers/src/status/index.ts)和[作者指南](dual-plugin-entrypoints.md)。

## 原生插件作者为 Launcher 定义的设置

需要让玩家配置一个独立原生插件时，插件作者可在入口 JS 旁提供同名 `.plugin.json`。它由 Launcher/Host 单独读取。世界包作者在源清单中选择插件或要求依赖即可。[清单定位](../../../apps/host/src/plugin-manifest-file.ts) · [字段解析和输入校验](../../../apps/host/src/host-plugin-manifest.ts)

| 对象 | 必填 | 选填或条件 | 说明 |
| --- | --- | --- | --- |
| 清单根 | `name`, `version`, `services` | `id`, `author`, `description`, `config`, `llmMode` | 名称、版本、使用的服务名单。只有声明 `llm` 服务时可填 `llmMode: "transport"`。 |
| `services[]` | 每项为一个受支持的名称 | 允许空列表 | 可选值为 `frontendServices`, `capabilities`, `playerFeed`, `scheduler`, `knowledge`, `status`, `activities`, `communication`, `autonomy`, `pacing`, `dice`, `characterLoop`, `llm`, `decisions`, `rules`, `content`, `worldEvents`, `memory`。源包顶层 `services` 有单独的取值范围。 |
| `config.<自定义设置名>` | `type`, `title` | `description`, `required`, `default` | 最多 24 个设置。类型 `string/number/integer/boolean`。这里的 `required` 控制玩家使用插件时是否需要提供值。 |
| 上项的类型专属字段 | — | 字符串专属 `enum`, `maxLength`, `secret`；数字或整数专属 `minimum`, `maximum` | 声明为密钥时不能附默认值或枚举。玩家在本机输入实际值。布尔类型没有额外约束字段。 |

如果插件为作品另设配置（如自定义牌组），插件的 `configSchema` 和 `validateConfig` 共同规定可用字段。编辑器可读取已选插件的 Schema，再调用正式校验以检查角色、地点等跨文件引用。[组合校验](../../../packages/world-pack/src/composition.ts) · [原生插件开发指南](host-plugin-authoring.md)

## 无头推演

推演 JSON 可以单独传给 `worldpack simulate`。例如要验证“玩家拿到开信刀后才能拆信”，用 `steps` 安排拿取、拆信，在相应步骤的 `expect` 核对正式裁定。[剧本解析器](../../../apps/host/src/simulation/scenario.ts) · [动作匹配器](../../../apps/host/src/simulation/simulation.ts)

| 对象 | 必填 | 选填或条件 | 用法 |
| --- | --- | --- | --- |
| 剧本根 | `title`, `steps` | `start`, `npcPlans` | 标题和至少一步玩家行动。 |
| `start` | — | `status`, `scenes`, `skipAutoStart` | 覆盖推演初值。场景映射为角色 ID → 场景 ID，跳过自动开始的是活动键数组。 |
| `start.status` | — | `public`, `characters` | 前者按状态键写值，后者按角色 ID 再按状态键写值。 |
| `npcPlans.<角色ID>[]` | `kind` | 取决于 `kind` | `abstain` 无附加字段。`say` 必填 `text`。`perform` 必须从 `move/interact/action` 中选一个。 |
| NPC 的 `perform` | `move` 为地点、`interact` 为交互 ID，或 `action` 为完整动作 | `interact` 可加 `target`, `arguments` | 完整动作必填 `actionType`（`move/interact`）和 `parameters` 对象。 |
| `steps[]` | 从 `say/move/interact/activity/wait/action` 中恰选一个 | 所有类型均可附 `expect` | `say` 是发言，`move` 是地点，`wait` 取 `true`。 |
| 玩家步骤的 `interact` | 交互 ID | `target`, `arguments` | 目标和参数按当前操作选择。 |
| 玩家步骤的 `activity` | 活动键和同级 `operation` | 同级 `parameters` | 活动内操作。 |
| 玩家步骤的 `action` | `actionType`, `parameters` | 内部参数取决于动作类型 | 交由引擎裁定完整提案。 |
| `expect` | — | `started`, `notStarted`, `status`, `resolution`, `fault`, `error`, `knows`, `doesNotKnow`, `contextContains`, `contextExcludes`, `panelsContain`, `panelsExclude` | 活动键、状态预期值、裁定、错误文本、感知、请求内容或玩家面板内容都可独立检查。 |
| `expect.resolution` | `status`（`accepted/rejected`） | `code` | 玩家操作正式裁定，可额外核对拒绝码。 |
| `expect.fault` | `pluginId`, `operation`, `invalidResult` | — | 三项分别是插件、操作和布尔值。 |
| `expect.status` | 各待检查键及预期值 | 自选键 | 公共键直接填写，角色键用 `character:角色.状态键`。 |
| `knows/doesNotKnow/contextContains/contextExcludes` | 各待检查角色 ID 及文本 | 自选角色 | 各值为一句文本或非空句子数组。前两项检查已授权的感知，后两项检查本步该角色实际收到的模型请求。 |
| `panelsContain/panelsExclude` | 使用时给非空文本数组 | — | 检查玩家玩法面板。`expect.error` 单独取一个期望包含的字符串。 |

结果中的 `passed`、`timings`、逐步轨迹和未消费的计划由工具生成。推演使用预定的 NPC 计划，角色对白质量仍需通过真实试玩判断。
