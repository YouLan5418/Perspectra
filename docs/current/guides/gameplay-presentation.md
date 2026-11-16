# 玩法的默认展示与配置编辑

2026-11-15 B8 源码接通。玩家在行动里搜查房间，精力与线索立即出现在状态抽屉；同场角色只获得翻找的授权观察。作者只修改[搜证定义](../../../examples/gameplay/investigation.cjs)，不用增加 Vue 组件或 Prompt 分支。执行、隐私及浏览器证据见 [B8 记录](../../superpowers/plans/2026-11-15-composable-engine-b8-presentation.md)。这不代表真实模型体验、原生 Tauri 或发行包验收；无头推演属于尚未开始的 B9。

## 操作与参数

OperationDefinition 沿用 argumentSchema、offer、resolve 和 npc，ui.label 与 ui.group 描述默认动作入口。ui.targetKind 是开放的展示分类，实际 targetRef.kind 由核心身份推导，不受展示文案影响；逻辑目标仍通过当前授权 offer 校验。

offer.parameters 可以只给固定字段。例如给定药剂 ID，其余数量由玩家填写。候选阶段校验已提供字段的结构，完整参数的必填、组合条件、数值限制等在执行时校验。存在未填字段时，不提前用正式参数限制隐藏候选；执行时仍执行所有 restrictions。固定字段不能由前端或模型覆盖，结构化固定值按规范 JSON 比较。

| Schema / 描述 | 默认控件 |
| --- | --- |
| string | 文本输入 |
| number / integer | 数值输入；完整数值规则由核心校验 |
| boolean | 是／否，未填与 false 区分 |
| enum | 有限选项，保留值的 JSON 类型 |
| object / array 等复杂字段 | JSON 文本输入，执行时校验完整结构 |
| ui.characterArguments 中的字段 | 当前场景授权角色选择 |

角色候选随当前场景刷新，仍合法的选择和草稿保留，活动输入框的焦点及文字光标位置保留。服务端再次检查当前授权角色和正式候选。该表单不是完整 JSON Schema UI：不根据 allOf／oneOf／条件分支动态生成组件，不支持任意作者组件；默认字段应公开在根 properties 中。

## 两种只读面板

GameplayDefinition.playerView({playerId,state}) 只收到当前玩家已授权的模块状态，不能获得全局真值或其他角色私有状态。返回 panels：

- property-table：id、title、properties:[{key,label,value}]。
- entry-list：id、title、entries:[{id,title,content}]。

Core 检查有限 JSON、结构、重复标识和数据体积，Host 再给 ID 加模块命名空间。面板正文以纯文本渲染，放入默认舞台的状态抽屉，不执行 HTML。单模块展示无效或抛错时隐藏该模块展示并报告已净化的插件故障，其他世界内容继续显示，已提交事实不受影响。

## 玩法控件的正式操作

作者在同一个 playerView 返回 controls。控件有 id、label、可选 description/disabled；kind:'boolean' 使用布尔 value，kind:'select' 使用字符串 value 和有限 options:[{value,label}]。

每个控件必须绑定本模块的公开操作：

~~~ts
operation: { id: 'investigation:set-enabled', argument: 'enabled' }
~~~

该操作应提供唯一的当前候选，绑定参数可填写，其他必填参数须已固定在 offer 内。否则控件不可用。请求采用 Perspectra.setPluginControl(id,value)，经过当前候选、类型／选项、完整 Schema、限制和 Handler 后提交；禁止在展示回调直接改世界。玩家视图使用 pluginControls，只公开展示数据，不暴露内部绑定。

| 保存范围 | 处理 |
| --- | --- |
| 阅读／声音／外观 | 现有本机端侧偏好，即时生效 |
| 剧情节奏 | runtime:pacing，保留既有故事线偏好、下一轮生效和再生语义 |
| 玩法世界设置 | 经绑定操作裁定，作为正常世界事实保存，可被规则拒绝 |

完整视图和 HTTP/SSE → Host 外壳 → MessagePort → SDK 的增量路径统一处理面板和控件；可选字段移除发送 null，消费者清除旧值。旧公共 pacing／setPacing 已移除，内部已有运行偏好实现仍复用。

## Launcher 编辑源包配置

进入本局设置的“玩法配置”，可编辑已启用且公开 configSchema 的插件配置资产，以及共同脚本在 worldpack.source.json 内的配置。常用根字段生成表单，结构化字段和完整配置可用 JSON 编辑；无效 JSON 保留草稿，不会退回旧值保存。

读取和保存复用 B7 已允许的插件元数据、Schema 和实体引用校验，不启动 Provider、Python 或模型。保存校验整个组合，只写当前声明的包内配置，拒绝未知配置、越界真实路径、运行中修改及陈旧包摘要。多个 Launcher 用同源包排他文件锁覆盖“重新读取—校验—原子替换”，失败不覆盖先前内容。

若进程在保存中断开，.perspectra-config.lock 可能保留：先确认相关 Launcher 已退出，再删除残锁并重新载入。B8 没有自动抢锁或强制恢复机制。外部编辑器不参与这把锁，保存前应停止同时编辑源文件。

保存修改源包，刷新 Launcher 包记录；已有实例的包版本／存档不被改写。用新实例验证修改，旧实例可能因原有包摘要保护而拒绝打开。一次保存只改一份配置；若包内其他配置也无效，需要先修复相关配置再通过整包校验。

源码关系：[SDK](../../../packages/sdk/src/gameplay.ts)、[呈现校验](../../../packages/core/src/application/gameplay-presentation.ts)、[公共投影与操作](../../../apps/host/src/runtime/frontend-adapter.ts)、[默认组件](../../../packages/frontend/src/gameplay-widgets.ts)、[配置读写](../../../apps/host/src/pack-config.ts)、[配置编辑器](../../../apps/launcher/src/components/PackConfigEditor.vue)。
