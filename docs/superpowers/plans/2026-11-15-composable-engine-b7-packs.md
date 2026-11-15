# B7 游戏包显式组合与共同脚本

状态：B7 已完成并通过主代理源码／自动化验收。三组独立 GPT-6.1 Sol 审查最终全部 PASS；停在 B7，不进入 B8。

本批按[架构定稿](../../current/architecture/composable-engine.md)验收。用户允许调整[实施计划](2026-11-11-composable-engine-refactor.md)的具体做法；保留 v5 文件组织和既有世界时间，不同时重写全部内容格式。

## 本批结果

例如搜查房间消耗精力、找到私有线索，同房者看到翻找：[单文件定义](../../../examples/gameplay/investigation.cjs)可原生加载，也能由包内 VM 适配器加载。二者使用同一 SDK 定义及核心注册、授权候选、裁定、提交和结果投影。测试覆盖扣精力、私有线索、同场观察、耗尽拒绝与真实 Host 再打开已提交状态。默认按钮／线索面板留 B8，新的无头推演命令留 B9。

源及编译清单新增可省略的 plugins、services、scripts。plugins 缺省为空；配置文件不再隐式启用 RPG、TRPG、自主、节拍或通信，依赖要求显式列出。services 是实际 SDK 服务名到 Provider ID 的硬要求，普通包省略，由宿主与玩家选择；模型凭据不写进包。选中实现缺失、版本冲突或配置错误中止开档。

沿用角色、地点、资产、认知、记忆种子、知识和作者断言文件及其真实语义。本批不重新执行历史作者断言，也不把这些材料统称为权威事实。既有 interactionFile 已显式选择交互目录，保持其注册与绑定校验。

configSchema 提供声明式结构；validateConfig 返回路径及问题，承担实体引用和跨字段检查。CLI、Launcher 注入已安装校验器，world-pack 库不导入具体玩法。导入第三方可执行校验器前检查安装、启用、原生允许状态和版本。配置问题与校验器抛错分别报告 PACK_COMPOSITION_INVALID 和 PLUGIN_VALIDATOR_FAULT。生成器不参与纯校验。纯 CLI／Launcher 不能确定最终玩家 Provider 时，明确报告服务硬要求 pending-host-selection；正式 Host 根据实际所选实现检查，默认 LLM 也在打开前核对。

## 作者契约与取舍

在既有 worldpack.source.json 中加入：

    "plugins": {
      "official-rpg": { "version": "1", "config": "rpg.json" },
      "official-dice": {}
    },
    "scripts": {
      "gameplay": { "entry": "scripts/gameplay.cjs", "config": { "energy": 1 } }
    }

config 路径和脚本 entry 同时列入 assetFiles，沿用包内路径、资产摘要和大小校验。共同配置读取上限为 1 MiB；TRPG 展开玩家和名称后的活动配置上限为 256 KiB，两者都在纯校验与正式打开一致检查。版本若填写是精确版本；旧 requiresPlugins 的范围语法只检查安装依赖，不能启用玩法。

共同脚本以自包含 CommonJS 的 module.exports 导出 ContentGameplay，可用 JSDoc 引用 SDK 类型。脚本不导入 npm 模块；需要 npm／文件／网络能力的扩展使用用户信任的原生插件。原生生成器默认把原始配置传给共同定义；已在闭包中展开的生成器可用 gameplayConfig 指定定义配置，官方 RPG／TRPG 使用空对象。函数留在所属 VM；输入和结果使用有限 JSON 拷贝，调用超时 100 ms，单次数据上限 1 MiB。compute、random、rollDice 只在调用期间转调核心能力。普通时钟与未记录随机不可用。Acorn 在执行前拒绝 async／await／动态 import；VM 仅保留同步算法和数据全局，Promise、WebAssembly、Atomics、Array.fromAsync 等异步入口不可用，避免未返回的拒绝终止共享宿主。node:vm 不构成对恶意代码的进程安全沙箱。

既有 status.js、plugins.json 和 activity 脚本由显式 pack-scripts 选项继续支持，保留当前实际玩法。新玩法优先共同定义；不要求一次性重写所有旧内容。pacing.js 由 official-pacing 选择。这是内容迁移取舍，不增加永久兼容保证。

第三方原生插件在 Cordis 默认导出之外，导出 packPlugin 元数据（可直接导出 ContentGenerator），ID／版本与旁置 .plugin.json 一致。CLI validate／compile／test 可在末尾加 --plugins settings.json，文件使用现有 HostPluginSettings；Launcher 使用已有插件设置。安装、允许和包选择仍是不同操作。

## 修改与验证

- world-pack 新增 composition 与注入校验；保留 v5 内容文件和编译／资产链。
- official-activities 新增 gameplay-script；SDK ContentGameplay 支持公开 methods。
- Host、CLI、Launcher 接通选择与预检；示例、模板清单显式迁移。
- 组合失败、授权前导入、脚本隔离／超时、原生／脚本同路径及实际 Host 读档测试。
- 本批前副本和日志在 .tmp/composable-engine/b7；B0–B6 已有未提交工作保留。

## 独立审查闭环

审查依据是架构定稿及真实调用路径，不以实施计划中的包数量、命名或文件拆法作为硬指标。三个独立审查者分别负责组合装配、脚本／宿主接线、作者工具链；均只写隔离探针，生产修复由主代理完成。

| 编号 | 首轮问题 | 已落实修正 |
| --- | --- | --- |
| 组合 R1 / P1 | 无清单模块可绕过空玩法选择 | 正式装配在导入前要求稳定清单；按实际 Fiber 注册审计 rules、content、wakeups，包含子 Fiber／异步 apply |
| 组合 R2 / P1 | 官方玩法开关静默删除替代 Provider | 包选择控制内容来源，能力选择尊重宿主；被选 Provider 的 open 故障正常阻止启动 |
| 组合 R3 / P1 | 尾轮遗漏第三方元数据 | 尾轮、分享、Lens 传入同一 catalog，关闭短期脚本实例 |
| 组合 R4 / P2 | 默认 LLM 硬要求被误判 | 在有效模型 Provider 构造后、open 前检查其实际身份 |
| 脚本 R1 / P1 | 未返回 Promise 拒绝可终止共享进程 | 同步语法预检、同步内置白名单及限时 VM 调用；复验遗漏的 WebAssembly／Atomics 异步入口一并关闭 |
| 脚本 R2 / P2 | 原生定义丢失配置 | 原始配置或明确 gameplayConfig 传入注册，正式打开与读档预检一致 |
| 作者 A1 / P2 | 静态合法被误当运行服务满足 | 输出待宿主验证及所需实现，实际冲突 fail-closed |
| 作者 A2 / P2 | 作者／运行时大小限制不一致 | 统一 1 MiB 读取限制并保留真实文件错误；TRPG 256 KiB 展开限制也进入纯校验 |
| 作者 A3 / P2 | 原生校验模块导入失败不含插件身份 | 安全诊断保留插件 ID 和校验模块导入阶段，不回显内部栈 |

组合审查最终 PASS，11 项独立注册审计通过；脚本审查最终 PASS，原三条进程退出探针均改为同步可捕获故障且宿主存活；作者审查最终 PASS，75,334 字节合法 TRPG 配置可打开，597,934 字节配置在 CLI／Launcher／Host 一致拒绝，纯校验 generate 调用数为 0。复验中两处遗漏均已关闭，不把首轮发现计作仍未解决的问题。

审查报告保留在工作树 .tmp/composable-engine/b7-review-composition/REVIEW-FINAL.md、b7-review-scripts/REVERIFY-2.md、b7-review-authoring/recheck.md。正式回归与本记录保留可交付证据，临时探针不作为新增公开 API。

## 最终验证

执行命令均在独立工作树中，测试使用新的临时数据和本地假模型；不读取历史试玩数据或发送真实角色私密上下文。

| 检查 | 实际结果与证据 |
| --- | --- |
| 根类型检查 | corepack pnpm@11.7.0 typecheck 通过；typecheck-acceptance.log |
| B7 主验收回归 | Vitest 24 文件、427 项通过；acceptance-tests.log |
| 受影响入口扩展回归 | Vitest 17 文件、248 项通过；extended-tests-final.log |
| 保存发布强杀复验 | 1 项通过、同文件其他 12 项未在此命令重跑；crash-recheck-final.log |
| 真实 CLI 进程 | 新建搜证包 validate、compile、test 退出码均 0；cli-validate／compile／test.log |
| 生产依赖边界 | node scripts/check-host-boundaries.mjs：429 生产文件通过 |
| 本批 Lint／格式 | 定向 oxlint 与 prettier 检查通过；lint-acceptance.log、format-check-acceptance.log |
| 文档链接与模块地图 | check-links 仍退出 1；103 条既有缺失报告、85 条去重错误，与 B6 基线完全相同，新增断链 0；docs-comparison.json |

两组最终回归互不重叠，共 41 文件、675 项通过；独立审查者的测试与之重叠，不累计。worldpack test 仍只做现有编译／适配，本次输出 assertionsExecuted: 0；搜证行为由共同执行器和真实 Host 的自动化测试证明，不能把该命令冒充 B9 剧本推演。

初轮广泛回归并非全绿。B7 显式选择导致的 fixture 迁移已修复；扩展复验又将 BGM／TTS 正例补齐原生允许状态，旧异常文本断言改为精确 PluginFault 身份／阶段，JEV 审计在实例能力有效期间完成再关闭。原来的不阻塞提交、结果／事件一致和失败后可继续操作断言保留，独立审查确认没有弱化测试意图。

强杀保存测试的旧注入条件把草稿内部 plugin-set.json 原子重命名当作节点发布，错误地提前杀进程；现只在隐藏草稿目录重命名为正式节点目录后暂停。未改生产保存逻辑、未扩展恢复承诺。最终重新运行的是上表范围，没有重跑完整 104 文件广泛集合或根 check，因此不宣称全仓全绿。

## 主代理验收与停点

B7 的包显式组合、安装信任门禁、共同定义脚本、注入式配置校验及各正式入口接线达到定稿本批目标；九项首轮发现及复验遗漏已关闭。主代理接受三组独立 PASS，并核对最终回归、类型和边界结果，B7 验收通过。

保留的限制：同步自包含包内脚本，不支持 npm 导入或异步工作；node:vm 不是恶意代码安全沙箱；可信原生插件仍需用户允许。静态服务预检不替代玩家运行环境选型。旧 pack-scripts 明确选择后继续使用，未新增永久兼容或跨重启继续未完成周期的承诺。世界时间不改。

B8 默认按钮／表单／面板与作者配置界面、B9 新无头推演、真实模型体验、Tauri GUI、干净机器和发行包验收均未进行。源码和文件改动留在 codex/composable-engine-implementation 独立工作树；没有提交、合并或推送。B0–B6 原有工作保留，按用户要求停在 B7。
