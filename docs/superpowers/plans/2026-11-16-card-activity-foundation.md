# 2026-11-16 卡牌活动底座实施与验收

## 实施范围与基线

实际问题是已有活动容易把「回合所有者」「当前响应者」「控制者」混为一人，也没有独立可测的牌区和密封多席请求。此次用三个小规则样板验证同一个牌局底座；没有实现完整三国杀、联机、棋盘、商店或规则 DSL。

- 本地分支：`codex/card-activity-foundation`。
- 工作树：`/workspace/Perspectra-card`。
- 远端：`https://github.com/YouLan5418/Perspectra.git`。
- 基线：`8c6a33f03e444275e031870656ee98d5da150942`，来自远端 `codex/integrated-b10-rpg-save-tree`。
- 实跑 `git ls-remote origin refs/heads/codex/integrated-b10-rpg-save-tree` 与 `git fetch origin codex/integrated-b10-rpg-save-tree`，二者均核对到上述 SHA，随后从该 SHA 创建独立工作树/分支。没有改用 main，没有接触 Node 记忆迁移工作树。
- 执行器恢复后先用 `pwd` 验证成功；原 `/workspace/Perspectra` 工作树保持干净。本工作仅本地提交，不推送、开 PR、合并、部署或改 CI。

已阅读根 AGENTS、当前统一规范/可组合引擎/模块/创作者/舞台说明、SDK Gameplay/Activity、nativeGameplay、RPG/TRPG 内容适配、Activity 提交和授权投影、节点与树备份实现。checkout 中没有 `.agents/skills`；没有因缺少该目录跳过现有原生接口。

## 最终变更

| 层 | 变更 | 复用与理由 |
| --- | --- | --- |
| 纯牌局 | [engine](../../../packages/plugins/src/cards/engine.ts)：牌定义/实例、牌区、克隆后提交、可序列化请求/帧、记录随机、输入重放和投影 | 不导入 Host/SDK/Node；共同 submit 保证三个规则不是各写一份提交状态机 |
| 规则包 | [colors/identity/auction](../../../packages/plugins/src/cards/rules) | 自己决定顺序、候选、选色/多目标/整数、费用、触发顺序与胜负 |
| 原生活动适配 | [activity](../../../packages/plugins/src/cards/activity.ts)、[content](../../../packages/plugins/src/cards/content.ts) | 使用 nativeGameplay/Operation、Activity 状态归属、Host 校验和原子提交；角色/NPC共用 submit |
| 显示 | [可信渲染器](../../../packages/plugins/src/cards/stage-renderer.ts) | 普通玩家有限 payload；现有 perform，暂停/恢复/中止不另建执行通道 |
| 装配/示例 | Host 官方内容/舞台清单登记；[原创样板](../../../examples/world-packs/card-table) | 必要的通用登记；没有在 Host 前端新增玩法判断 |
| 文档/验证 | 本记录、[指南](../../current/guides/cards.md)、模块与当前架构链接、7文件22项专项 | 包括隐私成对对照与现有限制的失败探针 |

未修改 Core、通用 SDK 或 Provider 实现；没有 `ctx.cards`，没有 RPG 依赖。插件状态通过所属 Activity `internal.table` 保存，公开桌面与每个控制者的本人数据分别投影。Host 的 `game.turn` 是现有 Activity 生命周期约束；竞价的纯牌局 `turnOwner:null`，合法性与多席待决不依赖该锚点。

## 逐条验收

| 用户条目 | 状态 | 可重跑证据与实际范围 |
| --- | --- | --- |
| 1. 同底座三样板/扩展 | 通过 | `engine.test.ts` 三规则全局结束、重放，接龙抽弃/选色/折返/胜负；定义实例分离与唯一归区；非法移动/选项不改状态；共同控制者、多牌、非人物目标、自定义牌区合同探针。Host 身份战和竞价、可信舞台接通 |
| 2. 攻击→防御→求援/保存分叉 | 通过，尾重生成另列限制 | Host 实际付费攻击、防御取消/放弃、第三席援助，原 owner 不变；10取消/20援助/30护光/40伤害；费用清理不退款；防御与求援保存恢复；求援节点全树导出/导入/同节点分叉得到HP2或HP1且原节点不变。旧实例同id/revision操作、过期、重复和越权拒绝；重试不会重复付费，已提交应答恢复不再问模型 |
| 3. 三席密封/隐私与元数据 | 通过（仅当前样板政策） | 纯同请求两种提交顺序、中途JSON恢复、重复/越权与同价政策；真实Host两席后恢复第三席，无重问前两席。成对Host只改别席报价/身份/防御牌，对照原始状态、玩家补丁、模型请求/本人续接资格、观察、授权记忆、actorId/targets/revision等；固定观察席不变。洗牌前后展示句柄和隐藏牌堆/对手数量回归。公开请求包络的限制见下文 |
| 4. 重放/兼容/结果边界 | 通过；无世界奖励系统 | 同种子及接受输入逐字段重放；Host插件数据版本与纯规则schema/id/version检查，规则升级恢复安全拒绝且保存字节不变；恢复校验请求目标/费用、身份战与接龙的牌区归属/可见性及持久投影；无密钥NPC走正常决策入口；正常结束/强退回日常，未完成不产生终局结果，插件不写世界奖励事件 |
| 5. 定向/静态/回归/浏览器 | 专项通过；全量未全绿、已对照基线 | 22专项、47 RPG/TRPG/舞台/保存树回归；独立Sol复验；Chromium真实页面进桌/出牌防御/保存/暂停继续/退出、窄屏。完整默认回归按同基线对照，见命令与结果节；不把历史失败算通过 |

`cards-admission-probe.test.ts` 是诊断探针：它明确证明通用计数活动克隆后仍接受原实例操作，不把这一行为当卡牌安全承诺。卡牌在每次装配时生成独有操作 scope，`cards-activity.test.ts` 用完全相同 Activity/request/revision 的恢复副本证明旧操作遭拒，刷新后的操作可继续。

## 独立 GPT-6.1 Sol 审查

遵循 AGENTS 的逐阶段要求，使用明确模型 `gpt-6.1-sol` 的独立只读子代理；没有以主代理自审代替。

- `/root/cards_engine_review`：发现固定身份/初手/牌堆可推导、非法99报价可从恢复状态绕过、恢复请求席位未绑定帧目标。修复为记录随机的身份与发牌、报价范围/请求政策检查、行动/防御/援助席位及费用绑定。独立7/7复验后放行第一阶段。
- `/root/cards_host_review`：独立实跑Host/tree/privacy/admission、纯引擎和最终22项、tsc；确认唯一路径和信息边界。实际复现尾重生成安全失败且牌局/事件/tail均未变。复查renderer自包含序列化与生命周期校验。浏览器由主代理实际执行，未将代理源码检查冒充浏览器体验。
- 末轮恢复可见性加固：官方规则锁定 `hand` 所属席位及 owner/visibility、牌堆hidden和公开弃牌/费用区，防止恢复数据把对手手牌改成公开。负例加入现有唯一归区测试；独立再跑engine/activity两文件10/10，并内联验证8种篡改全部CARD_ZONE_POLICY拒绝。此项不包含竞价lot/awarded的展示策略锁定；竞价没有私有牌区，其报价隔离按独立的sealed请求投影校验。

## 实跑命令与结果

本环境为 Linux / Node v24.19.0。默认 corepack 缓存目录不可写，因此命令前使用 `COREPACK_HOME=/workspace/.cache/corepack`，安装使用 `/workspace/.cache/pnpm`。这些是环境设置，没有改 packageManager/锁文件或CI。

```sh
# 新增专项（冻结生产源码后）
corepack pnpm@11.7.0 test:related packages/plugins/src/cards \
  tests/host/cards-activity.test.ts tests/host/cards-privacy.test.ts \
  tests/host/cards-admission-probe.test.ts tests/integration/cards-save-tree.test.ts

# RPG/TRPG/舞台/存档回归
corepack pnpm@11.7.0 test:related tests/host/trpg-pack.test.ts \
  tests/host/trpg-activity.test.ts tests/host/trpg-memory.test.ts \
  tests/host/rpg-perform-path.test.ts tests/host/rpg-values.test.ts \
  tests/host/activity-stage.test.ts tests/integration/save-tree-stage.test.ts

corepack pnpm@11.7.0 typecheck
corepack pnpm@11.7.0 lint
corepack pnpm@11.7.0 format:check
node scripts/check-host-boundaries.mjs
node scripts/docs/check-links.mjs

# 在独立基线工作树与最终工作树分别运行同一条默认回归
corepack pnpm@11.7.0 test --maxWorkers=2
```

已确认：专项7文件22项通过；RPG/TRPG等7文件47项通过；补充Core记忆/尾回合2文件52项单独复跑通过。类型检查通过，lint退出0（现有无关警告保留），格式通过，边界检查453个生产文件通过。文档链接检查与同基线均为104条既有断链，无新增断链；检查退出1，未把它报成全仓文档检查通过。样板CLI `worldpack validate examples/world-packs/card-table` 返回valid，packHash为 `sha256:88884d75696a000f828f75ca90627e256d4d1478a48a729a978b5eceedc15c9a`。

基线默认回归：263文件中251通过、12失败；2471项中2425通过、42失败、4跳过，用时615.93秒。失败集中于既有Windows DPAPI/外部插件清单、旧剧情/节奏与故事分享预检等路径；仅称为「同基线已复现」，不假定所有失败都是环境问题。

曾在持续修改源码期间运行一轮全仓，得到18失败/250通过文件、86失败/2400通过/4跳过项；其中42与基线同名，42个附加错误为 `运行代码已改变，请结束并重新启动`，另2个来自技术trace迁移时新断言与旧已加载模块并存。这轮不是固定快照，不作为最终回归验收；已冻结后重跑，最终结果如下。

最终固定快照默认回归：270文件中257通过、13失败；2493项中2446通过、43失败、4跳过，用时658.45秒。与基线失败标题逐条对照：42项完全同名，基线独有0项，当前新增1项为既有 `tail-round.test.ts` 的 `switch-after` 强制终止测试，等待子进程超过5000ms。该项随后用 `-t ... --maxWorkers=1` 单独实跑，1通过/24未选中，用时8.85秒；没有改测试或运行时来放宽时限。全量那次超时仍记为失败，不宣称默认回归全绿。卡牌新增用例在最终全仓均通过。机器可读命令、逐项失败标题和对照在[验证清单](2026-11-16-card-validation.json)。

### Chromium

真实本机Host、临时SQLite、确定性NPC，无收费模型。Playwright Core安装在临时工具目录，使用环境已有 `/usr/bin/chromium`，不写仓库依赖。实际1280×900和390×844完成：进桌、点击光矢、NPC折光取消、保存、切回默认、暂停、读完管理结果、行动菜单继续、恢复牌桌、中止回日常。`pageerror:[]`，`mobileOverflow:false`。

可重跑 [cards-browser.mjs](../../../tests/experiments/cards-browser.mjs)，需每次启动一个新的 `cards-preview.ts --identity`，将输出URL写入 `CARDS_PREVIEW_URL`，设置可导入的 `PLAYWRIGHT_MODULE` 与可选 `CHROMIUM_PATH`，然后运行 Node 脚本。它会对错误/横溢出机器判失败。没有把截图上传Library或把试玩临时数据打进源码包。

## 已知限制与最小接口建议

1. **末端重新生成尚不可用**：Host把录下的旧Operation交给新实例，新scope按设计拒绝，原结果保持。可重跑Host探针明确验证安全失败。普通节点恢复、树导入、分叉后新选择和纯接受输入重放均已通过。最小通用接口应是Host可信历史输入重放时验证并重绑定逻辑操作到当前实例；不能让外部请求绕过scope，不需要卡牌服务。
2. **秘密响应调度有公开元数据限制**：当前规则公开 pending.seats/submitted、回合和动作身份；隐藏牌权只影响私有候选，所有公开合资格席都可pass。第四规则必须使用固定公开包络/空响应，不能把隐藏角色直接做成公开请求席位或不同操作次数。现有Host仍公开responders/revision/观察actorId；本版不声称任意秘密调度已安全，也不改狼人杀/Core/服务。
3. **局外奖励只留边界**：终局为Activity.id和table.result，没有世界物品/货币发放。未来由显式受控组合以Activity.id做原子去重，未完成/强退不能生成奖励。
4. 未做真实模型长局、真人可用性、Windows/Tauri/发行包验收；无联机、通用棋盘/商店、DSL、完整三国杀卡库。

第四规则的新增步骤、运行样板和各层接口见[卡牌指南](../../current/guides/cards.md)。本地补丁/源码变更包在交付前须通过基线 `git apply --check`、归档内容与Git字节对照，再按Library工作流保存；不会对外发布。
