# 官方 RPG 战斗舞台第一版

本批独立于 B10／B11。B10 原工作树 `/workspace/Perspectra` 的 HEAD 保持 `76d818dc`，全部未提交差异及索引保留。使用替代索引写入仅供本地隔离的 B10 快照 `b38f062f18c172a0445419f95a6eb0036a9d3410`，引用 `refs/codex-local/b10-rpg-baseline`；功能工作树为 `/workspace/Perspectra-rpg-stage`，分支 `codex/rpg-battle-stage`。无 ignored 构建产物或凭据加入快照，不推送、不发布。

## 范围与实现路径

只识别官方原生 RPG 战斗，不根据标题、活动 key 前缀或第三方内容猜测模式。以官方工厂创建的 ActivityHooks 对象身份关联只读战斗投影，弱引用随实例释放。该关联只服务内置官方战斗视图，不成为通用第三方展示接口。

投影只消费已按玩家授权的活动视图及当前可见参与者；角色自己的技能选择来自官方配置。输出血量、回合、当前行动者、可执行技能与合法目标，不传内部状态、其他角色私密记录、敌人策略或任意资源路径。已有动态动作 ID 和参数表单仍为提交依据，核心重新裁定。

默认舞台内增加内置覆盖层，保留原 main DOM、阅读播放器和未提交输入；宿主外壳保有切换按钮与强退按钮。进入官方战斗自动显示，手动切回不暂停；活动暂停／结束／失效关闭。渲染失败回退通用卡片。战斗按钮通过原 send/perform、posting、阅读与最新候选检查，绝不在浏览器结算。

## 验证与交接

Node 24.19.0，仓库锁定 pnpm 11.7.0；本容器使用 `COREPACK_HOME=/tmp/perspectra-corepack`，默认用户缓存目录不存在。依赖按 frozen lockfile 离线安装。基线 `test:related tests/scenarios/rpg-turn-battle.test.ts tests/host/frontend-api.test.ts --maxWorkers=1`：2 文件 36 项通过，13.17 秒。

| 检查 | 实际结果 |
| --- | --- |
| `pnpm@11.7.0 typecheck` | 通过（含新增试玩入口） |
| `pnpm@11.7.0 lint` | 无错误；旧仓库 unused 等 warnings 保留 |
| 修改 TypeScript 文件 Prettier 检查 | 通过 |
| `node scripts/check-host-boundaries.mjs` | 通过，437 个生产文件 |
| RPG／Host／SDK／前端定向回归 | 20 文件 224 项通过，118.15 秒 |
| B9 原九文件 | 首轮 124 通过、1 失败；隔离提取 Host applyView 的测试夹具缺少 syncBattle，补齐后该文件 4 项通过（4.83 秒）；最终九文件 125 项全部通过（59.54 秒） |
| `pnpm@11.7.0 desktop:build` | 退出 0，Node 后端与前端资源构建通过；不代表原生 Windows/Tauri 验收 |
| `node scripts/docs/check-links.mjs` | 退出 1：历史缺失链接仍在，103 个历史本地资产缺席；本批新增链接存在 |

定向回归命令（下列 `pnpm` 均指 `corepack pnpm@11.7.0`）：

```sh
pnpm test:related tests/host/rpg-battle-stage.test.ts packages/plugins/src/rpg tests/host/frontend-reading.test.ts tests/host/frontend-api.test.ts tests/host/frontend-participants.test.ts tests/host/frontend-trusted.test.ts tests/host/rpg-perform-path.test.ts tests/host/trpg-activity.test.ts tests/scenarios/rpg-turn-battle.test.ts packages/sdk --maxWorkers=1 --reporter=verbose
pnpm test:related tests/host/lens-simulation.test.ts tests/host/lens-cli.test.ts tests/host/lens-rpg.test.ts tests/host/gameplay-presentation.test.ts tests/host/pack-composition.test.ts packages/core/src/application/status-state.test.ts packages/core/src/application/gameplay-runtime.test.ts packages/core/src/application/execution-engine.test.ts tests/host/official-gameplay-path.test.ts --maxWorkers=1
```

首次把 package-layout 与所有回归混合运行时数分钟未产生用例结果，已主动终止（143），不计作通过。随后拆分为上述定向回归；SDK 独立导入由 contract-imports 用例验证。本批没有重复 B10 全部隔离安装／Launcher／创作者界面验收。

### 真实浏览器与限制

使用系统 Chromium 与 Playwright，在实际 Host、默认沙箱 iframe、SSE、FrontendActions.perform、官方 RPG 规则与临时 SQLite 上操作。不是静态画面或伪造 PlayerView。单玩家战斗中双击攻击只提交一次：敌人 50→42、玩家 40→32、回合 1→2；切回通用卡片防御继续到回合 3。重新打开与已提交事实一致；切换不增加事件，输入草稿、阅读位置保留。375×812 手机和 1280×850 桌面检查外壳按钮可见，暂停／继续／强退正确回退；注入渲染异常回到通用卡片且不提交世界事实。正负滚轮不改变默认阅读，Escape 可切回默认。结束状态、旧操作、重复 actionId、授权过滤和非官方同名活动另由真实规则集成／单元测试覆盖。

截图、脚本、JSON 结果和原始日志保留在功能工作树 `.tmp/rpg-battle-stage/`，不纳入版本记录：`browser-check.ts`、`browser-results.json`、`battle-desktop.png`、`battle-mobile.png`、`ui-regression.log`、`b9-final.log`。浏览器脚本依赖云容器的 `/opt/codex/runtimes/cua/lib/node_modules/playwright-core`，不宣称在任意本地环境可直接复用。

**未通过的多人浏览器场景**：玩家和澄同场时，攻击已提交，但后续 NPC 行动报 `WORLDSTORE_BUSY: another writer owns the branch lease`。全屏和通用卡片各复现一次。追踪到现有 native playerView 的 read 经 WorldApplication.#branch 恢复应用写租约，与 CharacterTurn 提交竞争；本批未修改 core 读／写流程。直接 FrontendActions 的多人回合测试通过不等于多人浏览器通过。单玩家预览避开此竞争，不代表修复。错误时已有记录仍显示已提交攻击，不能重发攻击假装未发生。

本批只使用本机假模型，无真实凭据或计费 API。未验收原生 Windows、真实角色模型、第三方前端覆盖或发行包；未进入 B11，未修无关旧失败。

### 独立审查

独立 GPT-6.1 Sol `rpg_stage_review` 审查官方对象身份、授权投影、动作/参数、候选与修订号、切换、回退及 DOM 保留，独立运行新测试 2 文件 6 项通过（5.24 秒）。发现 P2：战斗滚轮误触默认阅读；主代理修复全局 wheel 门禁并运行浏览器回归，审查者只读复核关闭该问题，无其余确定阻塞。审查者没有独立重跑浏览器，不扩大其验收范围。

### 试玩与阅读路线

```sh
cd /workspace/Perspectra-rpg-stage
COREPACK_HOME=/tmp/perspectra-corepack corepack pnpm@11.7.0 exec tsx tests/experiments/rpg-battle-preview.ts
```

打开终端输出的 URL，点击底部读完，选普通攻击与遗迹守卫，点击使用技能。观察回合 2、敌人 42 HP；点击外壳“切回默认界面”，用卡片防御，再“打开战斗界面”，应为回合 3。可测试暂停、继续和外壳“中止活动”。Ctrl+C 关闭并删除临时世界。此预览使用真正官方规则，回环假模型，不访问个人存档。

阅读顺序：`tests/experiments/rpg-battle-preview.ts` → `plugins/rpg/battle.ts:createRpgMapBattleHooks`（对象身份注册）→ `plugins/rpg/battle-view.ts:officialRpgBattleView`（授权白名单）→ `Host world-runtime.ts:#projectActivity/state` → `frontend-adapter.ts:projectPlayerView` → `host-page.ts:syncBattle` → `frontend/battle-stage.ts:createBattleStage` → 默认模板 `send` → `FrontendActions.perform` → 现有活动规则/核心事实提交 → `tests/host/rpg-battle-stage.test.ts`（断言事件、血量、回合、旧操作与重复请求）。

独立差异基于快照 `b38f062f`，在功能工作树运行 `git diff HEAD`；包括新文件的补丁为 `.tmp/rpg-battle-stage/feature.patch`。原工作树 HEAD、索引、status、完整二进制差异 SHA256 均与隔离前相同，证据 `original-preserved.json`。功能未提交，不污染原 B10 分支，不推送、不建 PR、不合并、不发布。
