# 官方 RPG 声明式效果与护盾

## 隔离与范围

基线为上一批全屏战斗工作树的完整本地快照 `61943038311942e362a39b63f4c3cc0c879e6a9c`，本地引用 `refs/codex-local/rpg-stage-effects-baseline`。使用替代索引收录原已跟踪和新增文件，没有 ignored 产物或凭据；原全屏补丁 SHA256 仍是 `84df22b169313f271d627f0c7b7cd9e86d4cd4dca4b61ea46b6c6f2ce9b107c1`。

本批工作树 `/workspace/Perspectra-rpg-effects`，分支 `codex/rpg-effects-shields`，功能差异未提交。原 `/workspace/Perspectra` 和 `/workspace/Perspectra-rpg-stage` 的 HEAD、索引、status 与完整二进制差异指纹全部与隔离前一致，证据在 `.tmp/rpg-effects/preserved-worktrees.json`。没有推送、PR、合并、发布或 B11。

## 已实现

例如玩家先施 12 点护盾，敌人 8 点攻击后 HP 仍 40、护盾剩 4；再用通用卡片对守卫施加侵蚀，守卫在自己的行动结束受 4 点伤害。回全屏显示同一已提交血量、状态和剩余次数，随后可给自己施加再生。

- `combat-effects.ts` 将旧 damage/heal/inflicts 与有限 effects 列表收敛到同一解释路径；一次性 damage/heal/status/shield 与持久条件实例分开。没有核心事件总线、动态 JS 或通用 Buff DSL。
- 保留旧燃烧配置、条件实例与火抗语义；新 tick 支持无元素或火焰周期伤害、周期治疗。只在持有者有效行动后结算；同 ID 刷新不叠层，拒绝、发言、阅读、切换不推进。
- 每个单位一个护盾，重施完整替换吸收量和持续次数；先基础攻防、抗性、一次性防御，再吸收。DoT 只经抗性和护盾，不消耗一次性防御。溢出扣 HP，归零破盾，行动次数到零过期；自施当次不扣护盾时长，他人施加后持有者下一次行动即扣。周期结算在护盾过期前。
- 敌方新效果技能按显式绝对阵营执行，保持原配置顺序／选目标策略。纯治疗排除满血，目标须在场存活。胜败、死亡和撤退清理状态。
- 全屏仅增加玩家已授权的护盾量、状态名和次数，通用卡片仍提交相同动态技能请求；内部 ID、其他单位私密字段和策略不外发。Lens 与配置 Schema 同步。

完整作者语义见[官方 RPG 指南](../../current/guides/rpg.md#持续效果与护盾)。实际被测试夹具加载的[配置片段](../../../examples/rpg-effects/effects.json)包含护盾、侵蚀和再生，没有修改旧示例平衡。

## 检查结果

环境为 Node 24.19.0、pnpm 11.7.0，离线 frozen lockfile 安装。默认 Corepack 用户缓存路径不可用，所有命令使用 `COREPACK_HOME=/tmp/perspectra-corepack`。以下 pnpm 指 `corepack pnpm@11.7.0`。

- 施工前基线：`test:related packages/plugins/src/rpg tests/host/rpg-perform-path.test.ts tests/host/rpg-battle-stage.test.ts --maxWorkers=1`：6 文件 41 项通过，16.43 秒。
- 实现后主回归：20 文件 203 项通过，39.92 秒（命令如下）。覆盖旧燃烧/火抗/防御、原生规则、SDK、Host、全屏、前端和 B9 展示路径。
- 后加边界：`test:related packages/plugins/src/rpg/combat-effects.test.ts packages/plugins/src/rpg/battle-view.test.ts --maxWorkers=1`：2 文件 10 项通过，678ms。包含他人施盾同次敌方行动扣时长，以及公开效果的白名单/房外过滤。
- 新 Host 测试 3 项通过：真实核心提交、拒绝不提交/不扣状态、火抗/防御/护盾顺序、活动暂停/继续、同代码保存分支重开，之后继续行动仍一致。
- 最终通用补充回归 4 文件 49 项通过（54.32 秒），最终类型检查退出 0。Lint 无错误，既有 warnings 保留；修改 TypeScript 格式检查、Host 边界检查通过（438 个生产文件）。`desktop:build` 完成后端与前端资源构建，不等于原生 Tauri 验收。
- 文档链接检查仍被历史缺失链接阻断，另有 103 个历史本地资产缺席；本批新链接均指向存在文件。未修无关旧失败，没有运行全仓 check。

```sh
pnpm test:related packages/plugins/src/rpg tests/host/rpg-effects.test.ts tests/host/rpg-perform-path.test.ts tests/host/rpg-battle-stage.test.ts tests/host/frontend-api.test.ts tests/host/frontend-reading.test.ts tests/host/gameplay-presentation.test.ts tests/host/lens-rpg.test.ts packages/sdk --maxWorkers=1 --reporter=verbose
pnpm test:related tests/host/lens-simulation.test.ts tests/host/lens-cli.test.ts tests/host/official-gameplay-path.test.ts tests/host/rpg-effects.test.ts --maxWorkers=1
pnpm typecheck
pnpm lint
pnpm desktop:build
node scripts/check-host-boundaries.mjs
node scripts/docs/check-links.mjs
```

实施中曾发现并修复 Schema 的 strictRequired 子分支声明遗漏；当时 Host 配置验证失败，不计作成功。类型检查也捕获了新测试的可选数组项和只读夹具赋值，已修正，不改业务断言。

## 浏览器、审查与兼容边界

真实 Chromium + 实际 Host/iframe/SSE/FrontendActions/临时 SQLite，使用本机假模型：全屏双击护盾只推进一次回合，敌人攻击后玩家 40 HP／盾 4；通用卡片侵蚀后敌人 46 HP、侵蚀剩 2 次，玩家 36 HP；再开全屏状态一致，施放再生成功。375×812 布局检查无横向溢出，宿主切回与中止按钮仍在外壳。脚本、JSON 与截图为 `.tmp/rpg-effects/browser.ts`、`browser-results.json`、`shield-desktop.png`、`periodic-mobile.png`，原始日志同目录。脚本使用云容器的 Playwright 安装路径，不宣称任意本地可直接运行。

独立 GPT-6.1 Sol `rpg_effects_review` 只读审查配置/Schema、效果解释、结算、投影、前端、Lens 和测试，独立跑新单元/Host 2 文件 8 项通过（6.95 秒）。发现 P2：敌人配置 effect 技能被静默忽略；主代理接通选择与目标路径并加回归。审查者复核关闭 P2，独立跑 6 项效果测试通过（673ms）。没有其余确定阻塞；审查者未独立运行浏览器。

旧配置可加载，旧燃烧状态形状保留、盾字段可缺省。验证的是同代码版本保存分支恢复；旧构建存档仍可能因原有运行摘要／包摘要规则被拒绝，未提供跨构建迁移。上一批多人浏览器 WORLDSTORE_BUSY 租约冲突不在本批修复范围，本批浏览器使用单玩家；不将单玩家通过当成多人修复。无计费接口或真实模型凭据，无原生 Windows 或发行验收。

## 试玩与阅读

```sh
cd /workspace/Perspectra-rpg-effects
COREPACK_HOME=/tmp/perspectra-corepack corepack pnpm@11.7.0 exec tsx tests/experiments/rpg-effects-preview.ts
```

打开输出 URL，读完后“护盾术→玩家”；切通用卡片“侵蚀术→遗迹守卫”；重新打开全屏“再生术→玩家”。Ctrl+C 关闭并删除临时世界。

阅读路线：示例 effects.json → `config.ts:parseRpgConfig` / config-schema.json → `combat-effects.ts:skillEffects/periodicEffect` → `battle.ts:applySkill/hurt/endTurn/advance` → 既有 ActivityRuntime 和核心事实提交 → `battle-view.ts:officialRpgBattleView` → `frontend/battle-stage.ts` → `tests/host/rpg-effects.test.ts` 的真实提交和存档分支断言。

独立补丁 `.tmp/rpg-effects/feature.patch` 相对 `61943038`，不包含上一批全屏改动；也可在本工作树直接 `git diff HEAD` 审阅新增文件与修改。
