# 创作者字段：共同玩法脚本与展示

例如创作者想让玩家搜查房间并消耗精力，可以在包内共同玩法脚本里声明精力状态、搜查操作和玩家面板。状态、操作和展示使用同一份定义；角色是否选择搜查仍由角色决定。这个入口与 [status／activity 脚本](creator-fields-gameplay.md)可以同时存在，但状态键、操作、活动等注册标识不能冲突。

以下按当前 [SDK 定义](../../../packages/sdk/src/gameplay.ts)、[共同执行器](../../../packages/core/src/application/gameplay-runtime.ts)和[脚本加载器](../../../packages/providers/src/activities/gameplay-script.ts)整理。**必填**指定义所在对象出现时必须提供；`?` 为可选。下面的输入字段是宿主传给函数的数据，不是要另写在清单中的配置。[搜证示例](../../../examples/world-packs/investigation/scripts/gameplay.cjs)和[牵手模板](../../../examples/templates/hand-contact.cjs)可直接查看可运行写法。

## 如何启用

在创作工作台的「日常交互」页可直接读取原脚本、添加自己命名的操作并从玩家舞台试玩。清单和资源登记会在保存时写入。外部 Agent 可以用同一套 `worldpack editor interaction-script` 命令完成创作。[交互创作步骤](world-workbench.md#只添加作品需要的日常交互)

源清单写 `scripts: { gameplay: { entry: 'scripts/gameplay.cjs', config: {...} } }`，并在 `assetFiles` 登记 `entry`。`entry` 必填且为包内已登记的相对路径；`config` 可选，默认 `{}`，内容须符合脚本导出的 `configSchema`。`scripts` 目前只接受 `gameplay`，`gameplay` 只接受 `entry`、`config`。路径并非必须叫 `gameplay.cjs`；不要把文件放在目录里就以为自动启用。

文件通过 `module.exports = { ... }` 导出一个 `ContentGameplay`。脚本自包含、同步、最多 1 MiB；不支持 `async`、`await`、动态 `import()`，也不提供普通 Node 模块加载或网络／数据库接口。每次 VM 同步执行限时 100 ms，输入／输出有限制；`Math.random` 被禁用，需使用回调中提供的记录随机能力。脚本是可信作者代码，正式效果仍须经核心检查和提交。

## 导出对象 `module.exports`

| 字段 | 必填 | 含义／默认 |
| --- | --- | --- |
| `id` | 是 | 稳定模块 ID，`^[a-z][a-z0-9.:-]{0,159}$`，不能与其他玩法模块重复 |
| `version` | 是 | 模块版本字符串 |
| `dataVersion` | 是 | 不小于 1 的整数，表示持久状态与活动数据语义版本 |
| `supportedDataVersions` | 否 | 非空正整数数组，须包含当前 `dataVersion`；省略默认仅支持当前版本，重复项归一化 |
| `requiredServices` | 是 | 所需宿主服务名数组，可为空；服务必须在当前组合中可用。服务名见 [HostServices](../../../packages/sdk/src/host.ts) |
| `configSchema` | 是 | 配置的 JSON Schema，以 AJV 严格模式检查；由作者决定属性、必填项和 `additionalProperties` |
| `validateConfig` | 否 | 纯函数 `({config, entities}) => [{path, message}]`；`entities` 为 `{id, kind}`，kind 为 `character`／`location`／`entity`。返回空数组表示通过，用于检查实体引用等跨字段约束 |
| `states` | 否 | 状态声明数组，默认 `[]`；字段、数量和 schema 检查沿用[状态声明](creator-fields-gameplay.md#definition)；模块间状态键不能重复 |
| `initializeState` | 条件 | 声明了 `states` 时必需；`({playerId, characterIds, config}) => {public, characters}`，为每个声明的公共／角色状态填写初值 |
| `projectState` | 否 | `({actorId, state}) => 对象`；把本模块状态投影给操作。候选／玩家展示只获得观察者已获授权的值；规则执行使用模块所属真实状态 |
| `validateState` | 否 | `(state, activities) => void`；检查本模块状态与活动之间的约束，抛错使候选失败 |
| `combineChanges` | 否 | `({state, changes}) => changes`；显式合并同一所属状态地址上的竞争写入 |
| `operations` | 是 | 公开操作定义数组，可为空；见下节 |
| `methods` | 否 | 仅供受控 `compute` 调用的操作定义数组，默认 `[]`，不可当作公开玩家操作 |
| `restrictions` | 否 | 限制数组，默认 `[]`，见下文；多个适用限制共同生效 |
| `activities` | 否 | 自己拥有的活动定义数组，默认 `[]`；见下文 |
| `afterAction` | 否 | `input => effects[]`；根据行动前、主结果候选后快照提出一层派生效果，和主结果一起验证 |
| `onCycleEnd` | 否 | `({cycleId, state, actors, activities}) => effects[]`；合格执行周期结束时对所属状态和活动进行结算 |
| `wakeupSources` | 否 | `{id, nominate}` 数组；纯函数只提出角色机会和该角色已有观察序号，不能写台词或新增观察 |
| `physicalEffects` | 否 | `{characters: [角色ID], entities: [物品ID]}`；声明规则会影响的额外实体，不等于跳过场景、托管或提交校验 |
| `statusPolicy` | 否 | `{characterIds, operations, policy}`；给绑定了 `status` 的共同操作提供原有状态操作许可与目标校验。模块例子和桥接方式见[扩展字段](creator-fields-extensions.md) |
| `playerView` | 否 | `({playerId, state, activities?}) => {panels?, controls?, stage?}`；只产出授权展示数据，详见下文 |

`afterAction` 输入包括 `operationId`、`actorId`、`outcome`、`before`、`candidate`、`beforeActivities`、`candidateActivities`、`compute`，以及可用时的 `beforeWorld`／`candidateWorld`。它收到的是只读候选，不直接写状态，也不会递归触发第二层 `afterAction`。`onCycleEnd.state` 是所属真值，`actors` 是各角色的模块投影，`activities` 是所属活动。

## 操作和限制

`operations[]`、`methods[]` 的每一项采用同一操作定义。公开操作 ID 和方法 ID 必须唯一，满足模块稳定 ID 格式且包含 `.` 或 `:` 命名空间，例如 `investigation:search`。

| 操作字段 | 必填 | 含义 |
| --- | --- | --- |
| `id` | 是 | 带命名空间的稳定 ID |
| `argumentSchema` | 是 | 参数 JSON Schema；执行时验证完整参数，候选阶段验证已提供的部分属性 |
| `resultSchema` | 是 | `outcome` 的 JSON Schema |
| `resolve` | 是 | `input => {status: 'accepted', outcome, effects}` 或 `{status: 'rejected', rejection}`；`rejection` 含字符串 `code`、`message`，可附对象 `details` |
| `offer` | 否 | `({actorId, state, candidates, locationId}) => offers[]`；省略时没有公开候选。每项 `{id, label, parameters, targetId?}`，`parameters` 可只固定部分参数，执行时其余参数由玩家／角色填写并重新校验 |
| `activity` | 否 | `{key, operationId}`，将该操作绑定到所属活动的参与者、轮次和操作许可 |
| `status` | 否 | `{operationId}`，绑定模块 `statusPolicy.operations` 已声明的本地状态操作并重查资格 |
| `npc` | 否 | `{whenToUse, formatResult, projectResult?}`；`whenToUse` 为用途文字，`formatResult({actorId, recipientId, outcome})` 返回文字；`projectResult` 控制每位收件者看到的结果，省略时只有行动者获得 typed outcome |
| `ui` | 否 | `{label, group?, targetKind?, characterArguments?}`；展示名、分组、展示目标类别和作为同场角色选择的字符串参数名；实际目标资格仍由核心检查 |

`resolve` 的 `input` 包括宿主绑定的 `actorId`、已通过 schema 的 `parameters`、所属 `state`、`compute`；按场景可能有 `locationId`、`activity`、`world`、`truth`、`targetId`、`rollDice`。`truth` 是模块所属状态，不是其他模块的私有状态。`rollDice` 与 `compute` 只在同步调用期间有效；骰子语法见[活动字段](creator-fields-gameplay.md#活动数据回调和结果)。接受时的 `effects` 必须为数组，即使没有变化也写 `[]`。拒绝是正常业务结果；非法返回、越权效果或 schema 失败是插件故障，不应伪装成接受。

`restrictions[]` 项为 `{id, operations, check, showBlocked?}`：`id` 稳定且唯一；`operations` 为受影响操作 ID 数组，`interact` 可覆盖交互类操作；`check({actorId, operationId, parameters, state, world})` 返回 `undefined` 允许，或 `{code, message}` 拒绝。`showBlocked: true` 使被拦截的目标在候选阶段保留，以便尝试时说明拒绝；强制逃生活动绕过作者限制。

`wakeupSources[]` 项的 `nominate({afterSeq, throughSeq, characterIds, observations})` 返回 `[{characterId, stimulusSeqs, opportunities?}]`；`observations` 每项含 `seq`、`characterId`、`substantive`。被引用的刺激须属于该角色，机会默认 1，实际数量受核心预算限制。[调度契约](../../../packages/sdk/src/scheduler.ts)

## 效果 `effects[]`

| `kind` | 必填字段 | 作用与边界 |
| --- | --- | --- |
| `status` | `changes`, `reveals` | 改所属状态；`changes` 项为 `{holderId, key, value}`，`reveals` 项为 `{observerId, holderId, key, value}`，值须与实际候选一致。可选 `description`；周期结算的告知只能给归属者本人 |
| `activity` | `activityKey`, `state`, `description` | 更新本模块所属活动的完整状态；同活动修订号递增、参与者不变，须通过活动校验 |
| `event` | `event` | 核心认识的 `WorldEventDraft`，含 `eventType`、`eventVersion: 1`、`data`；当前只接受受控观察或有限物理事件，并重查权限、场景及托管，不是任意事件发布接口 |
| `status-result` | `result` | 使用[状态操作接受结果](creator-fields-gameplay.md#回调参数和返回值)格式，由共同执行器复用原有检查；只能在操作中使用，拒绝应由操作返回 |
| `activity-result` | `activityKey`, `result` | 使用[活动操作接受结果](creator-fields-gameplay.md#活动数据回调和结果)格式，只能用于本模块拥有且实现行为的活动；移动其他参与者／物品需相应 `physicalEffects` 声明 |

`status` 与旧脚本的 `reveals` 有区别：共同玩法的直接 `status` 效果写完整的 `{observerId, holderId, key, value}`，旧脚本和 `status-result` 的告知项不写 `value`，由宿主填入。所有效果只是候选，不意味着权限检查已通过；单次原子提交中的无效效果会拒绝本次候选。

直接 `event` 效果当前支持的类型及 `data` 核心字段如下；不在此表中的事件类型不能靠写入名称来扩展核心。物品的来源、去向和行动者均须符合提交前的真实事实，操作结果里的 `items` 通常更容易使用。

| `event.eventType` | `data` 的关键字段与检查 |
| --- | --- |
| `observation.upsert` | `{value: {observerId, content}}`；`content` 为观察内容对象，收件人必须属于本次允许的受众。宿主生成观察 ID，并填入实际行动者／周期来源和 `status: 'accepted'` |
| `character.moved` | `{characterId, fromLocationId, toLocationId}`；来源为当前地点或 `null`，目的地为已声明地点；移动其他角色需声明并通过适用的效果校验 |
| `entity.upsert` | `{entityId, kind, locationId, holderId?}`；地上物品写有效 `locationId`，持有物品写 `locationId: null` 和 `holderId`；只改外观，不得借此转移物品 |
| `entity.taken` | `{entityId, characterId, fromLocationId}`；物品须实际在该地点地上，效果后由 `characterId` 持有 |
| `entity.transferred` | `{entityId, characterId, interactionId, fromHolderId, fromLocationId, toHolderId, toLocationId}`；来源必须与当前托管一致，目标恰为角色或地点之一，另一字段为 `null` |

周期结算的直接 `event` 只允许上述观察类型；物理事件需走操作结果，相关源码见[物理效果检查](../../../packages/core/src/application/item-effects.ts)和[当前物品状态推导](../../../packages/core/src/kernel/rulebook.ts)。

## 共同活动定义 `activities[]`

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `key`、`title` | 是 | 活动标识和标题；标识不能与其他活动重复 |
| `opening` | 否 | 开场文案 |
| `operations` | 是 | 活动操作定义列表，格式见[活动 `definition`](creator-fields-gameplay.md#definition-1) |
| `initialize` | 是 | `({playerId, participantIds, random, activityId?, world?, truth?, previous?}) => ActivityState`；返回完整 `{id, revision, participants, game}`，参与者须与宿主给定名单一致 |
| `resultSchema` | 是 | 活动结果的 JSON Schema |
| `projectResult` | 否 | 对每个接收者投影操作结果；缺少投影保持私有 |
| `formatResult` | 是 | 根据投影生成活动结果文字 |
| `behavior` | 否 | 活动行为钩子，形状为旧活动 `ActivityHooks` 除 `resolve` 外的部分：含 `definition`、`initialize`、`policy`、`schedule`、`onOutcome`，可选 `phases`、`autoStart`、`resume`、`simulate`、`onPublished`。需要走对应旧活动桥和 `activity-result` 时需提供；操作裁定仍在共同 `operations` 中 |

`phases` 是非空且不重复的阶段字符串列表，用于检查持久活动阶段。`game` 的公共／私有／内部数据结构、自动开始条件及活动钩子见[活动数据](creator-fields-gameplay.md#活动数据回调和结果)。

## 玩家展示 `playerView`

输入只含玩家已授权的模块状态；`activities` 仅含本模块当前活动且玩家为参与者的 scoped 数据，不含 internal 或其他人的 private。返回有限 JSON 对象，可同时包含：

| 字段 | 形状与限制 |
| --- | --- |
| `panels` | 最多 256 项，ID 不重复。属性表为 `{kind: 'property-table', id, title, properties: [{key, label, value}]}`；列表为 `{kind: 'entry-list', id, title, entries: [{id, title, content}]}`，每组最多 256 项且 entries 的 ID 不重复。value 为有限 World JSON |
| `controls` | 最多 256 项、ID 不重复。共同字段 `{id, label, operation: {id, argument}, disabled?, description?}`；布尔控件再写 `{kind: 'boolean', value: 布尔}`；选择控件写 `{kind: 'select', value: 字符串, options: [{value, label}]}`，选项非空、值不重复且含当前值 |
| `stage` | `{renderer, activityKey, activityId, revision, payload}`；`renderer` 为已由可信宿主注册的渲染器 ID，`revision` 为正安全整数，`payload` 为最多 65,536 字符的有限对象，活动身份须匹配当前玩家活动。包不能上传新的执行代码来注册舞台 |

面板／控件文本上限各 16,384 字符，整个展示上限 262,144 字符；面板和控件 ID 非空。控件的 `operation.id` 须属于本模块、`argument` 须是操作参数属性，且当前有唯一可执行候选，其他必填参数已经固定。展示无效时该模块展示被隔离，不改变已提交状态。[展示校验](../../../packages/core/src/application/gameplay-presentation.ts) · [舞台边界](activity-stages.md)

当前展示校验并非对每一层都统一拒绝未知属性；上表列出有定义的字段，不应依靠额外字段产生行为。参数和值内部是否允许扩展键则以作者自己的 JSON Schema 为准。

## 校验范围

源码工具的包校验会执行共同脚本的配置预检与 `validateConfig`，宿主打开时还会注册操作、检查服务、状态与活动冲突和运行时效果。校验通过不能证明每个分支、私有信息范围或模型行为已验收；创建新世界后应使用正式操作和角色视图验证。[配置预检](../../../apps/host/src/official-pack-metadata.ts) · [操作 schema 编译](../../../packages/core/src/application/gameplay-contract.ts) · [展示指南](gameplay-presentation.md)
