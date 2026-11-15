# B6 RPG／TRPG 原生迁移与持久数据兼容施工记录

2026-11-15 后续复核：发现并修正九项接通缺口，详见[本轮记录](2026-11-15-composable-engine-b6-followup.md)。此前 PASS 为当时证据；本轮九项及复审发现的三处残留均已修复，三位新的独立 GPT-6.1 Sol 最终复验全部 PASS，12 项独立探针通过。保持在 B6，不进入 B7。

**当前已通过独立 GPT‑6.1 Sol 收口复审，停在 B6。** 用户要求补齐 B6.3 后再停，不进入 B7。官方内容现已构造并注册实际 GameplayDefinition；正式状态和活动操作、RPG 限制与随行派生已进入 GameplayRuntime。下文原六项保留最初部分迁移方案与过程；最新接通和验证以末尾“B6.3 公共执行路径”小节为准，首轮不通过报告保留为历史证据，最终结论以末尾收口记录为准。

2026-11-15，B5 收口后开始 B6。本批按[重构实施计划](2026-11-11-composable-engine-refactor.md)第 10 节与[可组合游戏引擎架构定稿](../../current/architecture/composable-engine.md)第 8.3、9.1、12.1、12.4、15.6、16.1、17.1 节推进，把官方 RPG 与 TRPG 从生成脚本文本迁移到原生 TypeScript 状态、活动与规则实现，并建立覆盖状态含义、活动阶段和必要标识的持久数据兼容契约。

例如玩家带着同伴澄用铁钥匙打开遗迹铁门进入一层地图，随行移动、锁门复核、地图遭遇战、战利品从金库转移到现场以及战败／撤退全队回到客厅，都直接运行原生 TypeScript 模块与规则，不再拼接 `install(...)` 脚本文本或送入 `node:vm`；之后创作者修正锁门提示文案或调整火球术数值，已有存档与分享故事节点仍可正常打开并按新文案和数值继续推进，而未提交的尾部重生成候选仍因配置摘要变化被安全拦截；若插件删除了存档依赖的持久状态键、地图活动标识或升至不兼容的 `dataVersion`，读档则给出点名插件与字段的明确诊断。

## 实施落点

1. **公开 SDK 原生钩子与数据兼容契约**：在 `@harness-world/plugin-sdk` 增补强类型原生状态模块钩子（`StatusModuleHooks`）、原生活动钩子（`ActivityHooks`，可选声明持久 `phases`）与持久数据兼容声明（`GameplayDataCompatibility`：`dataVersion`、`supportedDataVersions` 及可选 `identity`），统一连接 `GameplayDefinition` 与 `ContentGenerator`，替代 `GeneratedContent` 生成源码字符串字段。
2. **状态与活动执行器原生直通**：`@harness-world/official-status` 在内存层直接组合可选包内基础 `scripts/status.js`、脚本模块与原生 `StatusModuleHooks`，对原生钩子执行同步返回检查与输入／输出深拷贝隔离，不再把原生模块拼成 JS 源码送进 `node:vm`；`@harness-world/official-activities` 新增 `NativeActivity` 实现 `ActivityInstance`，在 `initialize` 传入受控随机源、在 `resolve` 传入经核心记录的 `ctx.dice` 掷骰回调，保持输入／输出隔离且与脚本活动共用同一前景／自动开启选择逻辑。
3. **官方 RPG 原生拆分与共同演化组织**：保留 `parseRpgConfig` 配置解析与实体／地点／角色／金库引用检查，删除 `runtime/status-rules.js` 与 `runtime/map-battle.js`；按背包与消耗／装备／解锁／入队离队状态模块、队伍与装备属性辅助、地图探索／战斗状态机（含状态异常、脚本化敌人演出、金库掉落去重、战败／逃跑全队位移与战斗锁队策略）及锁门／金库隐藏／随行移动规则层组织纯 TypeScript 模块。
4. **官方 TRPG 原生迁移与受控骰子／私有笔记保护**：保留 `parseTrpgConfig` 与 `isDiceExpression`，删除 `runtime/trpg.js`；以纯 TypeScript 原生活动实现主持人开场邀请、角色卡初始化与更新、经 `roll` 参数调用 `official-dice` 受控随机记录的明骰／暗骰检定、主持人私有笔记（`rolls`、`secret`、`instructions`）、全桌发言／旁白同步（`onPublished`）与聚光灯轮次交接（`schedule`）。
5. **持久数据兼容校验与摘要职责分离**：`plugin-set.json` 以结构化 `gameplayData`（记录 `pluginVersion`、`dataVersion`、持久 `statuses` 的 `key/type/owner`、持久 `activities` 的 `key/phases` 以及规范化配置与插件标识摘要 `digest`）替代原先锁死源码文本的 `generatedContent` 哈希。普通读档与故事节点导入预检校验插件存在、`supportedDataVersions` 覆盖、状态标识与含义一致以及活动标识与阶段覆盖，允许文案、标签与兼容逻辑修复直接读档；`TailRoundRuntime` 环境指纹纳入 `gameplayData` 的 `digest`，在配置或规则实现摘要变化时继续拒绝重放过期的未提交重生成候选。
6. **历史存档边界与构建脚本清理**：依据[B0 基线盘点](2026-11-11-composable-engine-b0-baseline.md)，`D:/worlds` 无声明保留迁移对象，不编写推测性旧存档迁移器；对仍携带旧实验字段 `generatedContent` 而缺少 `gameplayData` 的未发布旧档返回明确版本边界说明。同步清理仅为内联 `runtime/*.js` 存在的 `scripts/build/inline-adjacent-scripts.mjs` 构建插件。

## 验证门槛

1. 根级 `tsc --noEmit`、`node scripts/check-host-boundaries.mjs`、`packages/plugin-sdk/src/contract-imports.test.ts` 通过。
2. 官方 RPG／TRPG 单元测试与宿主集成回归通过：`rpg-perform-path`、`rpg-party`、`trpg-activity`、`trpg-dice-agreement`、`activity-private-notes`、`plugin-set`、`pack-content`、`rpg-pack`、`trpg-pack`、`rpg-story-share`、`lens-rpg`、`entry-layout`、`capability-plugin-entry`，以及 B4／B5 核心回归。
3. 新增并验证 B6 兼容与边界场景：
   - 兼容文案修改（如锁门提示、技能数值或逻辑微调）可正常打开已有 RPG／TRPG 存档与分享节点，新规则立即生效；
   - 未提交尾部重生成候选在 `gameplayData` 摘要变化时拒绝重放旧候选；
   - 不兼容 `dataVersion`、缺失必需插件、删除持久状态／活动标识、改变状态归属／类型或移除活动阶段时，读档在落盘修改前给出清晰诊断；
   - 原生迁移前后同一装备／药水／掉落／随行移动／暗骰与主持人私有笔记受众隔离保持一致。
4. 游戏包 `perspectra-pack/v1` 清单与共同脚本导出留给 B7，默认通用表单与面板留给 B8，本批不越界提前展开。

## 本次验证与缺陷修正

根类型检查通过，生产边界 423 文件通过。首轮正式 19 文件 155 项中 153 项通过；RPG／TRPG 单元、行动、队伍、暗骰、私有笔记、读档与分享兼容回归均在该集合中，具体范围见 `.tmp/composable-engine/b6/initial-tests.log`。两项失败保持原日志，不通过改回生产语义掩盖：

- Lens 的自动开场提交后 `started` 诊断未更新：现仅在完整已提交事件区间确认对应 start 后更新，不能仅凭 prepare 成功宣称已提交，也不能只看可能已被后续活动修订覆盖的最新事件。Lens／自动开场回归 2 文件 11 项通过。
- capability-plugin-entry 仍假设启用而未授权插件、导入失败插件可静默跳过。fixture 已显式授予本地执行许可，并将失败插件场景留在原插件边界测试，不恢复生产回退。修正清理阶段 EPIPE 遮蔽原始启动错误后，源码和打包入口正式用例通过。

独立审查者为 Mill（`01a1de5f-dd96-7130-a885-097c25c38ac7`），审查报告与探针保存在 `.tmp/composable-engine/b6/sol-review/`。B6.3 为实质阻断；需要把官方操作、状态效果、活动权限与受众接入公共引擎，而非给旧适配链装饰性注册一个空定义。未进行真实模型、GUI 或发行验收；未提交或推送。后续止于 B6，不进入 B7。

## 独立审查发现与当前修正边界

Mill 的首轮正式报告为 `.tmp/composable-engine/b6/sol-review/review.md`，结论不放行。14 项独立探针分别记录边界验证和缺陷复现，不能把探针进程 exit 0 解读为产品已通过。

- R1（未修复）：官方定义仍没有由实例所属 GameplayRuntime 注册和实际裁定；状态、活动与规则层仍依赖旧链。公共接口还需承接真实所需的局内 policy／schedule／发布后处理、自动开始、裁定所需的物理与自有状态投影、受控掷骰和指定受众的结果；不能通过新加另一套 Hooks 代替。具体端口建议见独立报告。
- R2（已修部分，待复核）：readPluginSet 不再吞掉损坏 JSON 或非法兼容结构，除文件不存在外均明确失败；测试验证坏记录不会被覆盖。已有世界缺失必要兼容记录的边界仍需随正式公共接入收口，不能视为完整关闭。
- R3（已修部分，待复核）：状态初始化入口遇到已有 status.updated 时调用现有 validateSnapshot。原生 phases 经 ActivityInstance／受保护活动实例送到共享 ActivityStateRules，恢复和新结果均检查实际阶段，保留核心 host-aborted。分享预检也校验实际状态值与活动阶段；所有恢复检查在任何写入之前完成的整体时序仍需独立复核。

恢复修正正式 4 文件 67 项、阶段／读档／私有笔记／分享／公共原生核心 6 文件 80 项及 TRPG 实际阶段恢复 1 文件 3 项通过，集合重叠不相加。新阶段测试最初使用了带额外字段和错误初始化参数的夹具，已按真实持久形状与 npcIds 输入修正，生产校验未放宽。B4／B5 扩展集首轮 7 文件 131 项中 130 项通过；旧 autoStartError 断言已按现行周期失败与脱敏归属调整，该文件后续通过。根类型、423 生产边界、最后修改文件 Lint 通过。文档保持历史 103 条断链，新增 0；全源码格式检查此前通过，后续修改文件均已格式化。

本记录明确保留未完成状态，不将上述局部修复登记为 B6 验收通过。

独立审查结束：Mill 在 closure-note.md 明确不放行，R1／B6.3 未关闭；R2 拒绝损坏记录、R3 状态值与实际 phase 校验通过局部复核。必要兼容记录缺失和完整 Host／分享流程的写入前校验时机仍保留限制。所有独立探针已退出，没有在途测试进程。B6 尚未完成，不进入 B7。

## B6.3 公共执行路径（2026-11-15，复审准备）

例如 NPC 在地图战斗中提交技能，Host 把现有活动 ID／revision 信封转换为公共注册的操作 ID；GameplayRuntime 重算当前参与者、轮次和活动 policy 后执行该 Handler。提案中的状态变化、活动更新、可信队伍移动、战利品和私有笔记复用共同核心校验，随后与原动作原子提交。旧原生活动 resolve 代理明确拒绝执行，不能回到另一条业务链。界面／指令的旧信封暂由 Host 转换；包清单与脚本格式迁移仍留 B7。

nativeGameplay 仅把动态配置的纯计算展开为 GameplayDefinition／OperationDefinition，不执行或提交事实。官方 RPG 的锁门和金库权限使用 restrictions，随行移动使用单层 afterAction；不再返回额外 RulesInstance。活动的 policy／初始化／自动开始／调度／发布后处理由所属注册定义调用，发布后的状态变化与表达处于同一候选提交。新增结构化 status-result／activity-result 提案先经过已有解析器，再进入共同所有权、冲突归并、owner merge 和最终不变量；不是第二个提交器。

中间独立架构核对 A1–A3 已据此修正：普通状态操作也重算当前活动的许可；结构化变化与原有变化共用冲突容器，自动告知值按归并后的结果生成；公共 startActivity 获得核心分配的新活动身份，并绑定玩家和所选 NPC。保留原有受控随机记录与调用期资格。实际兼容记录从公共定义的 states／activities／phases 生成；普通读档和分享预检用只读前缀验证，预检的公共执行器不具备写入事实的 execute 实现。

目前根类型检查与 425 生产边界通过。最近 10 文件 135 项中 134 通过，新增 Handler 旁路探针因 fixture 未把参与者放在地图场景而失败，已修夹具。随后额外地图／分享集发现旧周期来源断言、重复 status open 和新开活动后续调度缺口，正在收口；不据局部绿色提前宣称完成。所有失败日志保留在 `.tmp/composable-engine/b6/port-*.log`，正式复审仍由独立 Sol 负责。


### 正式复审冻结

正式冻结后主代理定向 4 文件 57 项通过，包含公共原生执行器、官方真实 Handler 旁路防回退、恢复前文件不变、RPG 地图活动和故事分享。B6 扩展 18 文件 154 项通过，覆盖官方 RPG／TRPG 计算、正式行动、队伍、跑团、暗骰、私有笔记、兼容记录、内容装配、Lens、源码与打包插件入口及 SDK 导入闭包。根类型检查、全源码格式与 425 生产边界通过；Lint 退出 0，发现物理投影下沉遗留的一条未使用导入，待安全编辑窗口清理。日志分别为 port-focused.log、port-b6-regression.log、port-typecheck9.log、port-final-format.log 和 port-final-lint.log。

公共物理投影已从 Host 下沉至 application/world-view，由 WorldApplication 默认绑定资源；核心读取不在作者回调保护内执行。新活动只有确属本周期新提交的 start 才获得结算后自身调度，继续使用原预算。公开活动开始和恢复复用真实定义的参与者／phase／恢复条件，TRPG 显式声明 dice 依赖。Mill 已开始正式复审，仍不能登记为通过。


### 公共准入复审修正

Mill 正式复审 r1-final-review.md 确认 R2／R3 写入前检查、实际 Handler 和公共规则接通；独立 13 文件 161 项通过，10 探针中 8 通过、2 失败，因此未放行。两项真实缺陷为状态 Handler 缺模块角色／policy 准入，及公共 startActivity 未检查作者开始条件。

修正把现有 status 角色／action／纯 policy 元数据纳入实际注册定义，公共裁定复用 admitStatusOperation／parseStatusOffers 和 StatusState，不增加 RPG 专用旁路。policy 读取 knownStatusView 与共同保守 place 投影，实际目标单独传递且复核可达。公开开始在同一前缀执行注册 autoStart 的条件解析，失败不调用 initialize 或使用初始化随机。新增正式回归验证拒绝前事实不变、Handler 未调用、合法目标成功、条件恢复后能开始且活动身份更新。首轮修正曾把结构化 world.items 直接交给 policy，导致 10 项回归失败；现已复用 Host 原有平面 place 形状，未放宽许可或改变预期。


准入修正后正式 5 文件 69 项通过（admission-tests2.log），根类型 admission-typecheck3.log 通过；全源码格式、425 生产边界、根 Lint 通过，新增未使用导入已清理，余下为历史警告。已重新冻结交 Mill 复核。新增 statusPolicy 只是现有 action 声明／纯 policy 在注册定义中的数据，不负责执行与提交；真正 Handler 仍唯一，core admission 先行。


交叉回归又发现纯自选状态机制的新节点未携带插件记录：saveStoryNode 原先仅在额外 gameplayData/generatedContent 存在时保存记录，而现在任何新节点都应携带调用者提供的实际组合。现保存全部已提供 PluginSetRecord；分享重复检查尊重 readPluginSet 已校验过的合法空数据契约，不能把没有额外持久玩法误报为损坏。现行缺失必要记录、损坏记录及不兼容玩法数据继续拒绝，未增加旧档兼容。world-composition 通过真实保存／导出／导入覆盖该场景，并断言节点文件包含记录；status-market-items 旧原文 TypeError 断言按 B2 脱敏 PluginFault 契约调整。该组首次 7 文件 57 项中 2 失败、修后 8 文件 59 项中 1 失败日志均保留，最后针对性回归另记。


## 最终收口：B6 PASS，停在 B6

2026-11-15，独立 GPT‑6.1 Sol 审查者 Mill 在 `.tmp/composable-engine/b6/sol-review/b6-pass-closure.md` 给出最终 PASS。R1／R2／R3、A1／A2／A3、F1／F2 全部闭合，本批范围内无剩余已证实阻断；所有主代理及独立测试／探针进程均已退出。旧失败日志和审查报告保留，不能外推为当前状态。

最终独立证据为 11 项实际入口／只读恢复探针全部通过，以及最后 5 文件 88 项正式回归通过；F1／F2 修正后的前一独立组为 7 文件 116 项通过，更早 B6 相关组为 13 文件 161 项通过，集合有重叠，不相加。独立探针确认模块外角色和错误地点开始被拒绝、合法公共活动开始成立、缺记录／坏记录／非法 Schema／phase 在写入前失败，数据库字节保持不变；所选状态预检只开关一次实例。

主代理最终根类型 closeout-typecheck.log 通过，根 Lint 与全格式通过，最后修改文件再经定向 Lint／格式检查，425 生产边界通过。主代理 18 文件 154 项 B6 回归、准入修正后 5 文件 69 项及最后保存／分享／真实 Handler 3 文件 19 项通过；共享状态交叉组其余用例通过，唯一保存缺陷已由最后针对性及独立组复核。文档链接检查保留历史 103 条源码导航断链，新增 0；另 103 项本地历史实验产物缺失单独报告。

源码能力和上述机械验证满足本批计划，不代表真实模型体验、Tauri／GUI、干净机器或发行包已验收。未读写 D:/worlds 历史数据；全部变更未提交、未推送；原工作树不改。按用户最新要求，B6 完成后停下，不进入 B7。
