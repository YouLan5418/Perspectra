# 新原型基线与接手说明

> 本文有两部分：前两节是 2026-09-15 原型起点的历史记录（基线分支、旧工作树、当时的下一步），不代表现在做到哪；最后一节“按风险验证”是现在仍在用的检查命令。现状见[项目状态](PROJECT-STATE.md)和[当前架构](architecture/README.md)。

## 基线选择

- 提交：`e682c5cf9c73f801b9de03e281a7bfb192ea71cc`（2026-09-15，fix: drive playtest reactions and normalize input）。
- 分支：`codex/narrative-interaction-prototype`。
- 工作树：`D:/DeepSeek Harness/harness-cordis-world-prototype`。
- 当前开发规则：[AGENTS.md](../../AGENTS.md)。当前产品方向：[原型契约](prototype-contract.md)。

选择的是已集成创作者交互扩展、v10 世界与试玩修复的切点。它包含引用文字而非模型计算偏移的输入处理、可达移动目标提示，以及输入后推进反应的试玩修复；尚未进入 scene autonomy/reflection 和 v11 Topology/Performance 扩展。

| 候选 | 判断 |
| --- | --- |
| `993b247` 早期外显表现 | 作为体验对照；缺少后续创作者交互抽象和输入修复，作为工程基线会重复施工 |
| `e682c5c` | 选用；已有交互扩展与试玩链路，保留后续简化空间 |
| `b60e4db` 及后续 | 引入场景自治、反思与更多机制；首轮没有必要带入 |
| merged 的 `a56f2bc` | v11 拓扑和表现平台超出首轮范围，不从最新版本向下拆 |

这不是最小运行时，也没有证据表明该提交已经通过新契约的真实体验验收。原有 Receipt、Hash、兼容和耐久调度仍存在；基线选择只是减少需要拆除的部分。

## 当时的下一步（历史）

基线建立时仅调整工作树和开发门禁。后续已进行 [第一轮上下文呈现实测](../archive/prototype-g1-g4/PROTOTYPE-PLAYTEST-01.md) 与 [第二轮自由表达实测](../archive/prototype-g1-g4/PROTOTYPE-PLAYTEST-02.md)。完整 perform → 结果 → 续写循环尚未实现；当前进展与限制以这两份记录为准。

下一步做一个可试玩的纵向切片：两房间、两 NPC、一个关键物品；角色看到可读场景，能自由表达，声明交互经过裁定再续写。按当前契约 G0/G1 记录具体入口、复用模块和存储选择。优先复用既有事件存储与裁定，只在实际阻碍这个闭环的地方删除旧耦合，不预先进行全仓合包、合库或协议重建。

`D:/worlds` 历史数据仅作为只读证据。新实验必须显式指定新数据目录。原工作树及 merged 工作树不变；不要求本树继续运行旧世界。仍有诊断价值的旧测试可按路径运行；已退役版本的专属测试可随代码清理删除。

## 按风险验证

```powershell
# 默认轻量检查：类型、Lint、核心冒烟；不调用真实模型
corepack pnpm@11.7.0 check

# 仅默认冒烟
corepack pnpm@11.7.0 test

# 按修改文件选择相关测试，必须在命令中填写路径
corepack pnpm@11.7.0 test:related packages/store-sqlite/src/store.test.ts

# 按需单独运行仍有诊断价值的旧测试，例如观察隔离
corepack pnpm@11.7.0 test:related tests/integration/observation-session.test.ts
```

默认 `vitest.regression.config.ts` 选择角色私有视图隔离、v5 游戏包编译两组测试，并自动发现 `tests/host`（游戏宿主）、`tests/desktop`（Launcher 后端）、`tests/scenarios`（跨包玩法与角色行为）和 `tests/integration`（跨包集成）下的测试，包括当前角色互动、记忆、活动、故事线、进程中断和宿主入口回归。`test:related` 使用 `vitest.config.ts`，另外运行全部包内单元测试。宿主入口测试会临时构建后端，验证 TypeScript、源码仓库内的构建产物与隔离发行目录均可启动；使用原生记忆，不依赖真实模型。它不覆盖全部新契约；旧版本断言可以随已明确改变的行为更新。新增功能需补充相关验证，不可仅凭默认测试通过宣布完成。

本机跑完整 `check` 有两个环境前提：故事分享等集成用例需要能找到 Python/E5 记忆环境（可用 `HCW_HINDSIGHT_PYTHON`、`HCW_HINDSIGHT_ONNX_DIR` 指定）；硬中断测试需要能执行 `taskkill`。受限沙箱里这两类用例会失败，这是环境问题，不要靠跳过用例或改断言来“修好”。

`vitest.config.ts` 保留广泛测试发现，供 `test:related` 与显式诊断使用。覆盖率不再作为门槛；已移除旧阶段与硬终止专属命令。`test:related` 不带路径会选择全量，日常必须明确路径。

GitHub CI（[流水线](../../.github/workflows/p0.yml)）只在 Windows / Node 24 上跑，分五步：根类型检查、生产路径检查、Lint、`launcher:check`（Vue 类型检查和 Launcher 单元测试）、原型测试。几点说明：

- 原型测试在 CI 上用 `corepack pnpm@11.7.0 test --maxWorkers=1` 逐个文件串行跑，避免托管机器上 SQLite、HTTP 和子进程互相抢资源。本地 `check` 仍用默认并发；想复现 CI 就按流水线一步步跑。
- 少数在托管机器上超时过的场景（多轮对话、HTTP 逃离、故事节点）单独放宽到 60–120 秒的测试时限；运行时本身的模型、角色、活动时限和断言都没改。
- 活动测试结束时会主动关闭 HTTP 连接；Windows 临时文件被占用时最多重试三次，仍失败就报错。
- CI 不构建 Tauri、Electron 或便携包，也不调用真实模型，这些要按改动另外验证。

类型检查和 Lint 暂时仍扫描旧源码与测试；尚未按新运行时依赖拆分。是否进一步缩小，应依据实际阻碍决定，不因历史文件很多就先重做工具链。上述自动化验证均不能证明真实角色自然度或自由叙述一致性；按契约另做连续试玩。
