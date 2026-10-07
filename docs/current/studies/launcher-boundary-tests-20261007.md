# Launcher 边界功能测试记录（2026-10-07）

## 1. 结论与范围

主要功能试玩之后，本轮使用独立数据进行边界验证。已有边界测试 10 个文件、76 项全部通过；新增接口探测及 Windows 原生 Launcher 交互发现 2 个可复现问题。本轮没有修改业务代码，也没有修改历史试玩数据。

测试数据与脚本：`.tmp/launcher-boundaries-20261007/`。模型失败探测使用受控传输，未请求真实模型服务。此前主流程的真实模型验证不代替本轮边界验证。

## 2. 已通过的边界

| 模块 | 验证内容与结果 |
| --- | --- |
| 预设参数 | 数值上下界及 16000 字符提示可接受；越界、非整数 Token、NaN、超过 4 个停止词等 8 类输入被拒绝。 |
| 预设导入 | 损坏 JSON、不支持版本、批次含非法项、超长内容被拒绝，磁盘原内容不变。80 字符同名预设生成互不重复的名称，导出再导入保留全部内容。 |
| 原生预设编辑 | 非法温度不落盘；实例与全局切换保留各自草稿；“继续编辑”保留草稿；“放弃修改”不写入配置；重新打开恢复已保存内容。 |
| 原生预设导入 | 连续导入损坏 JSON、错误版本、合法项与非法项混合批次，不留下可提交的部分内容；取消合法导入不修改库。 |
| 预设处理 | 已有测试覆盖宏、请求私有变量、文本规则顺序、原数据不变、空输出拒绝、病态正则有界终止。病态正则本轮通过自动化测试，未额外做原生长时间压力测试。 |
| 公共玩家接口 | 已有测试覆盖伪造或失效选项、重复请求去重、同请求 ID 内容冲突、失败请求 ID、私有信息不进入公开快照与流。 |
| 社区前端及授权 | 已有测试覆盖不可信来源、路径越界、符号链接、内容变化授权失效、授权复制至其他实例、损坏授权密钥、启动前内容变化、撤销和独立来源隔离。 |
| 活动 | 已有测试覆盖过期版本、重复动作、越权位置与变量、事务失败无部分提交、暂停/逃生幂等、等待模型期间取消及迟到结果不提交。取消发生在格式纠正的第二次调用期间，本轮未新增专项场景。 |
| 故事线 | 已有测试覆盖完整节点恢复、原未来保留、伪造或缺失文件、摘要错误、运行忙时限制，以及已有节点发布和分叉中断场景。 |

执行命令：

```powershell
corepack pnpm@11.7.0 test:related tests/prototype/preset-library.test.ts tests/prototype/preset-content.test.ts tests/prototype/model-presets.test.ts tests/prototype/story-nodes.test.ts tests/prototype/storyline-crash.test.ts tests/prototype/frontend-api.test.ts tests/prototype/frontend-trusted.test.ts tests/prototype/frontend-authorization.test.ts tests/prototype/pack-activity.test.ts tests/prototype/launcher-core.test.ts
```

结果：10 个测试文件、76 项通过。另执行 `.tmp/launcher-boundaries-20261007/probes.ts` 和 Playwright CLI 原生 WebView 交互脚本。原生验证使用临时开启调试端口的构建，结束后恢复普通构建。

## 3. 问题一：单个损坏故事节点阻断整个 Launcher（P1）

**复现**：独立根目录内存在两个实例；将其中一个实例下、合法 UUID 节点目录的 `node.json` 写成截断 JSON `{`。重新启动 Launcher。

**实际结果**：索引内仍有两个实例，初始化对象能创建，但全局 `snapshot()` 抛出 JSON 解析异常。原生界面显示“我的游戏 0”“本机初始化未完成”，健康实例也不可选择。未观察到索引被改写或健康实例数据丢失。

**原因**：`desktop/story-nodes.ts:17–22` 对可见节点直接读取并解析；`desktop/launcher-core.ts:149–161` 构建全局快照时同步读取所有实例故事节点，任意一个错误向上传播到整个快照。`apps/launcher/src/stores/launcher.ts:134` 在快照失败时无法完成初始化。

**建议修复边界**：读取列表时将错误限定在对应实例/节点，显示明确的损坏提示并保留健康实例可用性；损坏节点继续禁止恢复、分叉和导出。不要自动修复、删除或将损坏文件视作有效节点，也不要吞掉错误假装正常。无需增加全局恢复系统。

证据：[损坏节点启动界面](../../../.tmp/launcher-boundaries-20261007/corrupt-node-startup.png)、`probe-results.json` 的 `corrupt-one-node-launcher-availability`。

## 4. 问题二：不支持的预设宏允许保存，运行时误报服务失败（P2）

**复现**：添加启用的系统提示节点，内容 `{{unknown}}`。示例预览已提示“不支持的预设宏”，但点击“保存全部配置”仍成功并关闭编辑器。运行此预设，提交一次玩家叙述。

**实际结果**：玩家输入已提交；角色预设展开失败。受控传输计数为 **0**，即没有实际模型请求，却显示“角色模型服务未完成请求”，调试结果为 `provider_failed`。失败角色没有提交后续行动或表达，未发现权限越界。

**原因**：保存校验检查结构与长度，没有复用宏语法检查；宏在 `packages/provider-chat/src/preset-macros.ts:22` 展开时才拒绝。`tests/experiments/playtest-frozen-runtime.ts:196–197` 在请求准备阶段展开预设，抛出错误后被角色调用路径的 `provider_failed` 分类及 `playtest-frozen-runtime.ts:608` 提示覆盖。

**建议修复边界**：为启用节点复用宏解析规则，保存与导入前拒绝确定无效的宏，指出节点和错误；不应依赖玩家手动打开预览。保留调用前的运行校验，并将预设准备失败与网络/模型服务失败分开提示。不要通过猜测替换未知宏，或调用模型修复配置。需要明确语法检查与依赖实际上下文的求值检查的区别。

证据：[错误宏预览界面](../../../.tmp/launcher-boundaries-20261007/unknown-macro-preview.png)、`probe-results.json` 的 `unknown-macro-save-and-runtime`；原生交互脚本 `ui.js`。

## 5. 有意识保留的验证限制

本轮不是穷举、模糊测试或长期压力测试；未重新执行全部仓库测试，也未宣称真实模型在所有异常输入下都稳定。没有修改角色协议、持久化或权限实现，因此没有新增崩溃测试。文档仅记录测试证据和修复建议，两个问题尚未修复。


## 6. 修复与复验（2026-10-07）

用户批准后，以上两个问题已修复。

### 6.1 故事节点错误隔离

Launcher 的全局快照在每个实例的故事历史读取边界捕获错误，返回明确的 `storyError`；其他实例正常读取。主界面和故事线窗口展示错误。受影响实例的节点列表不用于恢复/分叉，后端严格读取仍拒绝损坏节点。原文件不修改、不删除、不自动补写。

有意识接受的粒度：一个节点损坏时，该实例整份历史暂不可用于分叉，不尝试拼接不完整的父子链。该实例的当前游戏进度不是由快照错误自动判定为损坏；启动仍经过原有运行校验。健康实例不受影响。

变更：`desktop/launcher-core.ts`、Launcher 的 `core-types.ts` / `types.ts`、`GameDetail.vue` / `StorylineDialog.vue`。

### 6.2 宏输入校验与错误分类

保存和导入预设复用同一宏解析规则，检查启用提示节点，错误包含节点名称。停用节点保留为草稿，启用后需通过检查。校验不读取角色上下文、不执行随机抽取或骰子求值，不把变量尚未赋值当成错误。依赖具体请求的展开长度仍在运行时检查。

已存在且结构有效的错误宏配置仍可载入、编辑；此载入只做原有结构校验，不自动改写。新保存/导入默认严格检查宏。结构损坏或非法字段仍拒绝，未引入存档版本迁移。

请求准备期间的预设展开或文本处理失败分类为 `preset_failed`，使用“角色预设处理失败，请检查提示节点与文本规则”；网络请求失败仍为 `provider_failed`。取消信号保持原有中断行为，详细错误原因不进入玩家输出。

变更：`desktop/model-presets.ts`、`packages/provider-chat/src/preset.ts` / `preset-macros.ts` / `preset-library.ts`、`packages/application/src/prototype-character-turn.ts`、`tests/experiments/playtest-frozen-runtime.ts`。

### 6.3 复验结果

- 新增 5 项最小回归测试：损坏实例与健康实例共存、错误宏保存/导入整体拒绝、启用节点宏语法、依赖请求的展开失败且无模型调用、已有错误宏可读可修。
- 最终 `corepack pnpm@11.7.0 check`：类型检查、lint、37 个文件 / 264 项测试通过。
- `corepack pnpm@11.7.0 launcher:check`：Vue 类型检查、10 项测试通过。
- 原生 Windows Launcher：两个实例均显示；损坏实例明确警告且分叉禁用；健康实例无损坏警告且启动按钮可用。未再次启动健康实例进行完整真实模型试玩。
- 原生预设窗口：已有错误宏可打开；保存被拒绝且配置不变；非法宏混合导入无部分内容；修正后保存成功。
- 请求依赖的超长展开场景：受控模型传输调用 0 次，返回 `preset_failed`，失败角色不提交行动/表达。
- 普通 Tauri debug 构建恢复；临时调试窗口和端口关闭。本轮无新真实模型调用。

界面复验脚本：`.tmp/launcher-boundaries-20261007/fixes-ui.js`。截图：`fixed-macro-save.png`、`fixed-story-startup.png`。此前章节的“尚未修复”是发现问题时的记录，以本节修复状态为准。
