# Cordis World

**一个面向多角色扮演的、由玩家推动的 AI 世界实验项目。**

Cordis World 希望让多个角色在同一个世界里，以各自的经历、记忆和可见信息作出反应，而不只是由一个模型轮流模仿所有人。玩家的一次输入可以触发有限轮 NPC 连锁回应；没有新输入、反应周期结束后，世界重新静止。

当前进展和入口见[2026-10-05项目状态](docs/PROJECT-STATE-2026-10-05.md)。简化记忆已接入源码网页的`--memory-core`实验入口，默认网页仍使用原生记忆；双角色实测与地点修复均有记录。

项目当前处于**实验与重构阶段**。首要目标是让角色更自然、玩法更自由，同时避免关键世界状态和角色知识相互串台。它还不是完整的在线游戏平台，也不承诺现有实验协议或世界包长期兼容。

## 我们想解决什么

传统自由文本角色扮演可以非常生动，但在多角色、长时间互动中容易出现一些问题：角色知道自己不曾听见的秘密；有人只是在对白里说拿走了钥匙，系统便将其当作真实转移；NPC 之间的反应要等玩家再输入一句话才会继续。

Cordis World 尝试在**叙事自由**与**关键因果的一致性**之间建立适度边界：

- **独立的角色视角**：各角色只接收自己获授权的观察、记忆和认知；说出一个主张不代表主张自动成为世界真相。
- **角色主体性**：角色自行决定是否回应、怎么回应、想尝试什么行为；调度不应把它们变成只负责填台词的演员。
- **有限的连续反应**：一条玩家输入可开启有上限的反应周期；NPC 能回应其他 NPC 刚刚产生的、自己确实观察到的新事件。
- **关键状态有依据**：移动、物品归属等影响后续逻辑的变化由规则裁定后提交；自由的台词、神态和叙述不必全部被编码成精确事件。
- **按玩法扩展**：世界包描述角色和内容；新的确需要规则与状态的玩法可以通过交互定义和受信任领域代码扩展，而不是不断向核心枚举添加题材动作。

这些是项目目标，**不代表目前每项体验都已达到预期**。表达与有界调度已有连续试玩证据；[G1 的模型无关机械门槛](docs/PROTOTYPE-G1-G2-ACCEPTANCE.md)已验收。[Gemini 连续试玩](docs/PROTOTYPE-GEMINI-PLAYTEST-2026-09-28.md)验证了显式命令下的移动、物品保管、牵手与重开续玩，也再次暴露自由叙述虚构受控事实、私语未送达等问题。记忆召回已接入角色请求，并在窄场景中验证了主动查询；长期经历稳定影响角色自主选择仍未验收。

## 当前能体验什么

仓库包含本机浏览器试玩入口、本机 OpenAI 兼容接口及 Ollama/DeepSeek 模型适配、多个示例世界包、角色受限视角、记忆与有限反应周期。已有版本支持外显表现、物品及角色交互；其具体可用范围取决于世界包和运行时协议。

**建议先从真实模型试玩开始，而不是先运行完整工程验收。** 以下命令均在仓库根目录执行；需要 Node.js 22.19+ 或 24+ 与项目锁定的 pnpm。

```powershell
corepack pnpm@11.7.0 install --frozen-lockfile

# 默认：本机 OpenAI 兼容服务（需提前启动服务，默认地址 127.0.0.1:8045，模型 gemini-3.7-flash）
corepack pnpm@11.7.0 experience:web --pack examples/world-packs/ai-girls-awaken-v10 --data-dir .tmp/prototype-local

# 或显式使用本机 Ollama（需提前启动 Ollama 并准备可用模型）
corepack pnpm@11.7.0 experience:web --ollama --pack examples/world-packs/ai-girls-awaken-v10 --data-dir .tmp/prototype-ollama
```

默认本机接口可用 `HCW_LOCAL_ENDPOINT` 和 `HCW_LOCAL_MODEL` 调整；如服务要求认证，只在运行进程中设置 `HCW_LOCAL_API_KEY`。`experience:web:flash` 当前与默认命令相同。启动后，打开终端打印的完整**本机**浏览器地址，包含 `#token=`。网页只监听回环地址，不是可公开访问的在线服务。模型请求可能产生费用；不要把 API Key 写进世界包、命令示例或提交记录。

体验其他世界包时，可为实验入口指定 Pack 与独立数据目录：

```powershell
corepack pnpm@11.7.0 experience:web --pack examples/world-packs/ai-girls-awaken-v10 --data-dir .tmp/my-playtest
```

本原型网页只接受 `worldpack-source/v5` 源目录，并通过 v10 的 FrozenWorldPlaytestRuntime 试玩；旧网页运行时已移除。当前玩家的重要状态交互使用显式 `/act` 命令；普通自然语言不会自动执行移动、取物或交接。创建新存档或续玩时请按[创作者与真实模型试玩指南](docs/CREATOR-PLAYTEST-RUNBOOK.md)操作，不要在同一数据目录中混用不兼容世界版本。真实模型试玩需要人工观察角色是否自然、是否重复、是否无故沉默，自动化测试不能代替这一环节。

### 可选：简化记忆试玩

完成[Core环境准备](experiments/activity-memory/README.md)后，可在新世界启用极简记忆交付。本次本机网关使用8046，服务端口不同则调整环境变量；网页地址由启动命令打印。

```powershell
$env:HCW_LOCAL_ENDPOINT = 'http://127.0.0.1:8046/v1/chat/completions'
corepack pnpm@11.7.0 experience:web --memory-core --pack examples/world-packs/prototype-g1 --data-dir .tmp/my-simple-core-web
```

使用宿主“整理长期记忆”按钮手动整理；首次整理前仍有近期上下文。当前保留授权检查、来源及证据摘选标注，JEV不作为必经。一般认识家族更新和桌面Core打包未接入此入口。

## 实验分支的活动与分层记忆

`codex/activity-memory-integration` 已包含包内脚本、变量、临时活动权限、调度和宿主逃生；`ai-girls-hosted-guess` 是角色主持的猜数字示例。默认网页仍使用原生记忆。准备本地 Python／E5 环境后，可以显式开启分层记忆：

```powershell
corepack pnpm@11.7.0 experience:web --memory-core --pack examples/world-packs/ai-girls-hosted-guess --data-dir .tmp/my-core-playtest
```

在顶部点击“整理长期记忆”后才有已整理的长期档案；当前不会每回合自动整理。安装、取消与私有 trace 的说明见 [活动记忆实验](experiments/activity-memory/README.md)。此入口支持本机 OpenAI 兼容服务，尚未随桌面发布打包。main 与实验分支的具体边界、验证结果见 [2026-10-03 项目状态](docs/PROJECT-STATE-2026-10-03.md)。

## Windows 桌面启动器

首版桌面窗口现已可用：默认列出 `ai-girls-awaken-v10`，也可选择其他 v5 世界包、新建或续玩独立存档、配置本机 OpenAI 兼容接口/Ollama/DeepSeek，启动后由系统默认浏览器打开游戏。启动器窗口保留运行状态、重新打开和停止入口，并管理一个本机后端进程；关闭启动器会停止后端。游戏页显示当前玩家可尝试的移动与交互，提交时仍由 Rulebook 裁定。

```powershell
# 开发机启动
corepack pnpm@11.7.0 install --frozen-lockfile
corepack pnpm@11.7.0 desktop

# 在 Windows 开发机生成免安装目录
pnpm desktop:release
# 打开 dist/release/win-unpacked/Cordis World.exe
```

模型服务须先运行；所需 API Key 通过启动器进程环境传入，不在窗口输入或保存。存档位于 Windows 应用数据目录的 `Cordis World/saves`，启动器不会修改 `D:/worlds` 的历史试玩数据。打包版已在当前 Windows 开发机完成无模型调用的启动、浏览器页服务和退出冒烟检查；尚未在干净 Windows 机器及真实模型连续试玩中验收。AI 美少女包现使用自定义游戏页；未提供网页的包沿用原型页。示例交互按钮仍有定义 ID 文案。接口与剩余体验工作见[前端与启动器接口边界](docs/FRONTEND-LAUNCHER-INTERFACE.md)和[实施方案](docs/FRONTEND-LAUNCHER-IMPLEMENTATION-PLAN.md)。
创作者也可在世界包的 `web/` 目录提供完整 HTML、CSS、JavaScript、图片和字体；没有 `web/index.html` 时使用默认游戏页。网页只改变本机展示，不改变世界包编译哈希或存档身份。用法见[自定义游戏网页指南](docs/CREATOR-WEB-UI.md)。

## 运行方式

世界采用玩家推动的回合机制。一次玩家输入开启一个 Root Round，已获授权的新观察可以继续触发有界 NPC Reaction Round；周期结束后世界停止自主推进。

```text
玩家输入
   │
   ▼
角色可见上下文 ──► 各 Character Agent 自主提案
                         │
                         ▼
                 规则裁定与世界提交
                         │
              ┌──────────┴──────────┐
              ▼                     ▼
        玩家可见结果            授权观察与记忆
                                    │
                                    ▼
                            有界后续反应
```

**模型的提案不等于世界事实。** 影响后续玩法的关键状态变化需要可信规则裁定；角色的猜测、感情表达和一般舞台表现不因此升级成客观真相。我们不追求把每个眼神、姿态或修饰词都变成可验证的状态字段。

已有实现包含更严格的事件、版本、恢复及表现协议。这些属于当前代码与历史实验的状态，**不是未来必须保留的设计承诺**；项目正在评估哪些机制真正帮助了游玩体验。

## 创作与扩展

World Pack 主要用于描述世界内容：人物、地点、物品、认知设定、场景与叙事材料。已有交互目录与定义机制允许世界选择具体交互。对于新玩法，优先复用现有能力；只有出现新的重要状态和裁定逻辑时，才引入受信任的领域实现。

目标是**小核心、丰富世界**，而不是预先在核心中定义所有玩法。当前 Pack 格式和扩展接口仍可能在实验阶段调整，请参考 [World Pack 字段手册](docs/WORLD-PACK-AUTHORING-MANUAL.md) 与 [试玩指南](docs/CREATOR-PLAYTEST-RUNBOOK.md) 了解本分支已落地的功能；规划文档中的接口不一定已经可用。

可用作当前 v5 参考的内容包括 `examples/world-packs/ai-girls-awaken-v10`、`prototype-g1` 和 `hand-in-hand`。

## 开发与验证

项目使用 TypeScript、Cordis 与 SQLite。主要目录：

| 路径 | 当前职责 |
| --- | --- |
| `packages/agents` | 角色上下文、模型提案及相关适配 |
| `packages/application` | 回合与反应流程的应用层协调 |
| `packages/kernel`、`packages/contracts` | 世界规则和必要的共享契约 |
| `packages/store-sqlite` | 当前实现中的世界状态与持久化 |
| `packages/memory` | 角色记忆与召回 |
| `packages/interaction-runtime`、`packages/interactions-basic` | 当前交互定义及基础能力 |
| `packages/world-pack` | 世界内容校验、编译与创作者工具 |
| `tests/experiments` | 真实模型与网页试玩入口 |

这是**现有代码布局**，不代表未来必须维持同样数量的包与基础设施。开发原则见 [AGENTS.md](AGENTS.md)：优先修复可复现的体验问题，为新抽象设立复杂度预算，只在相应风险真实存在时增加验证。

日常改动先做类型检查与相关测试：

```powershell
corepack pnpm@11.7.0 typecheck
corepack pnpm@11.7.0 test
```

本原型工作树的 `check` 已调整为类型检查、Lint 和少量核心测试，不含覆盖率门槛、旧全量或硬崩溃门禁；按需命令见 [基线说明](docs/PROTOTYPE-BASELINE.md)。检查通过不代表角色体验已经验证。涉及权威事实、权限隔离、事务提交等高风险修改时，仍应执行有针对性的严格回归验证。

## 文档与项目状态

| 要了解什么 | 入口 |
| --- | --- |
| 现行实现、最近验证与已知限制 | [当前项目状态](docs/PROJECT-STATE-2026-10-05.md) |
| 开发方向与约束 | [AGENTS](AGENTS.md)、[当前原型契约](docs/2026-09-19_原型契约-自由叙述与声明式交互-v0.1-report.md) |
| 启动与创作世界包 | [试玩指南](docs/CREATOR-PLAYTEST-RUNBOOK.md)、[World Pack手册](docs/WORLD-PACK-AUTHORING-MANUAL.md) |
| 简化Core记忆的准备与用法 | [实验入口](experiments/activity-memory/README.md) |
| 记忆认知简化的决策与验收 | [简化方案](docs/2026-10-05_记忆认知体系简化方案.md)、[最新双角色实测及修复](experiments/activity-memory/report-normal-playtest.md) |
| 全部原型与历史报告 | [文档索引](docs/README.md)、[实验历史命令](experiments/activity-memory/HISTORY.md) |

历史ADR、旧阶段报告与旧版本验收按各自版本理解，当前开发以现行契约、源码和真实试玩为依据。后续优先观察角色自然度、目标牵引、无关记忆准入和实际等待，再决定局部简化。
