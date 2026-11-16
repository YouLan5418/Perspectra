# 通用活动专属舞台登记

## 隔离与范围

基于作者数值完整快照 `feff7554bc5f77346309297b4ca216e817669b5d`，本地引用 `refs/codex-local/rpg-values-stages-baseline`。在 `/workspace/Perspectra-activity-stages`、分支 `codex/activity-stages` 独立实施；原五个工作树保留 HEAD、索引和差异。临时替代索引快照包含全部有效新增文件，不含 ignored 构建物。无 push、PR、合并、发布或 B11。

用户明确需要通用注册，避免每加玩法就修改 WorldHostCore。因此复用 B8 GameplayDefinition.playerView 的注册和模块失败隔离，扩展其授权输入与有限 stage 输出。没有新建平行投影服务或玩法注册表。浏览器渲染代码登记是静态可信资产组装，和世界玩法声明分开，既有生命周期负责投影失效。

## 实际修改边界

- SDK：通用 ActivityStageView/Renderer 与 playerView.activities，移除 SDK RPG 专用模型。
- Core：仅 gameplay-runtime.playerView 的 scoped 活动输入/所属绑定验证，以及 gameplay-presentation 的有限数据验证。没有改权威写入、事务、调度、状态归并、存档服务。
- RPG：content.playerView 接入同一通道，battle-view 继续白名单；RPG view model 与 renderer 移回玩法包。没有修改 battle.ts、combat-effects.ts、battle-values.ts、config 或数据版本。
- Host：移除 WorldHostCore RPG 判断、HostState.battle 和 battle 缓存；frontend-adapter 从 B8 展示选择当前 activityStage，frontend-server/http-server 接受可信渲染器资产组装；官方列表仅在 official-bundle。
- 默认前端：通用容器负责绑定、busy、重复门禁、失效清除与生命周期；RPG renderer 不再位于通用前端。宿主保持强退和切回，主体 DOM 保留。
- 第二活动：tests/support/activity-stage-fixture.ts 的 nativeGameplay 计数实验，独立于 RPG/TRPG，不读取 GM 或内部秘密。

注册、替换接口、失效行为及作者边界详见[指南](../../current/guides/activity-stages.md)。旧 PlayerView.battle 不保留兼容别名，测试侧使用 RPG 专用解码辅助函数；原游戏规则和存档形状不变。

## 验证

Node 24.19.0，pnpm 11.7.0，离线 frozen-lockfile；命令统一设置 COREPACK_HOME=/tmp/perspectra-corepack。施工前3文件11项通过，8.95秒。RPG新路径初验2文件7项通过，15.10秒。Core展示/规则既有回归49项通过，7.51秒（包含新所有权、非参与者及模块卸载测试）。通用展示初验3文件10项通过，7.92秒。

最终相关回归：**28 文件284项通过，95.73秒**；B9/Lens/正式入口与组合回归：**5 文件60项通过，72.05秒**。不同集合重叠，不相加。类型、Lint、变更格式检查、生产边界、Node 后端构建通过；边界覆盖442生产文件，Lint只有既有warnings。文档检查保留104条历史断链、103项历史本地资源缺失，本批新文档无新增断链。

```sh
# 以下 pnpm = corepack pnpm@11.7.0
pnpm test:related packages/core/src/application/gameplay-runtime.test.ts packages/sdk packages/frontend/src/activity-stage.test.ts packages/plugins/src/rpg tests/host/activity-stage.test.ts tests/host/gameplay-presentation.test.ts tests/host/rpg-battle-stage.test.ts tests/host/rpg-values.test.ts tests/host/rpg-mv.test.ts tests/host/rpg-effects.test.ts tests/host/rpg-pack.test.ts tests/host/rpg-story-share.test.ts tests/host/rpg-perform-path.test.ts tests/host/frontend-api.test.ts tests/host/frontend-reading.test.ts --maxWorkers=1
pnpm test:related tests/host/lens-simulation.test.ts tests/host/lens-cli.test.ts tests/host/official-gameplay-path.test.ts tests/host/pack-composition.test.ts tests/host/lens-rpg.test.ts --maxWorkers=1
pnpm typecheck
pnpm lint
node scripts/check-host-boundaries.mjs
pnpm desktop:build
node scripts/docs/check-links.mjs
```

真实 Chromium 在正式 Host/iframe/SSE/SQLite/perform 上验证：RPG压制、怒击、暴雨/火球，两种界面同一局面；第二计数活动双击只执行一次、通用卡片继续、重开专属界面、草稿保留、切回后的输入焦点恢复、暂停与强退。恢复动作经相同 FrontendActions 提交，浏览器验证 SSE 恢复呈现，没有声称暂停后的恢复按钮全流程已点通。未知renderer、渲染异常、投影异常三条浏览器回退链均通过，回退后通用卡片实际增加计数，内部秘密不出现在payload。窄屏390×844的计数界面及375×812的RPG界面已检查。

两条转发及清除：测试先走真实Host生成player view，server playerViewPatch→Host applyView再diff→MessagePort SDK合并，再full getView和无关delta，确认旧舞台不复活。Core另测绑定为非参与者的principal没有活动输入，其他模块冒用活动被隔离、暂停无stage、模块卸载后消失。前端测试绑定活动、修订、当前操作与busy，销毁后旧回调失效。

独立 GPT-6.1 Sol `rpg_values_review` 发现 P2：渲染update抛错后，保存的perform回调仍能执行。修复统一invalidate并引入挂载世代，补“异常后立即调用”和“同id/修订重开”的回归；独立复现由 sentAfterRenderFailure:1 变为0，2文件6项通过（5.75秒），复审关闭。审查者还独立esbuild打包并检查默认脚本可解析、工厂无Node闭包依赖；没有替代主代理浏览器验收。

试玩入口 tests/experiments/activity-stage-preview.ts 的 rpg/lab/fallback 三模式，实际HTTP200且SIGTERM退出0，启动约2.26/2.94/2.00秒。初期浏览器暴露toString内的编译器命名辅助函数依赖，改成自包含对象方法后通过；部分自动化定位曾点到隐藏输入／不存在的活动卡片恢复按钮，调整测试定位和恢复方式后如实记录上述范围。焦点断言等待MessagePort处理及舞台隐藏后通过，未因此修改产品逻辑。没有修无关多人写租约问题，也未验收多人浏览器。

完整浏览器证据在 `.tmp/activity-stages/`，交付包不包含截图或完整模型上下文。无真实模型凭据或计费调用，未声称原生Windows/Tauri或发行验收。


## 独立交付与阅读

补丁 `.tmp/activity-stages/feature.patch` 基于 feff7554，不混入此前作者数值/MV/B10批次；当前差异未提交。ZIP含独立补丁、指南、交接与可信计数夹具／试玩入口。Library结果以实际上传回执为准，任务路径不冒充附件链接。

阅读路线：RPG content.playerView / stage-lab playerView → GameplayRuntime.playerView → gameplayPresentation → projectPlayerView → playerViewPatch / Host applyView / FRONTEND_SDK → createActivityStage → 登记renderer.update → 同一个受控perform。RPG结算文件及版本无diff，可直接和基线对照。
