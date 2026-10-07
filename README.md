# Perspectra

> 原 **Cordis World**。代码、命令和部分界面仍保留旧名称，项目文档与后续开发统一使用 **Perspectra**。

**一个面向多角色扮演的、由玩家推动的 AI 世界实验项目。**

Perspectra 想解决的不是“让一个模型轮流扮演很多角色”，而是让多个角色在同一个世界中，依据**各自真正看见、听见、经历和记住的内容**独立作出反应。

玩家推动世界前进；一次输入可以触发有限的 NPC 连锁回应。角色可以自由说话、表现和形成自己的理解，但移动、物品归属、活动状态等会影响后续逻辑的关键事实，仍由系统裁定并提交。

项目目前处于**可连续试玩的实验原型阶段**。重点已经从堆叠机制转向真实体验：角色是否自然、认知是否隔离、长期互动是否能保持连续，以及规则约束是否只出现在真正需要它的地方。

## 核心思路

### 1. 每个角色都有自己的世界

角色只接收自己获授权的观察、记忆和认知。

一个角色没有听见的秘密，不应该因为“模型上下文里曾经出现过”就突然知道；一个角色的猜测、误解和主观看法，也不会自动升级成世界事实。

### 2. NPC 不是等待玩家点名的台词机

玩家输入会开启一个有界反应周期。NPC 在观察到新的相关事件后，可以继续产生后续反应；周期结束后，世界重新静止，不进行无限自主模拟。

调度系统只决定“谁获得一次处理机会”，不规定角色必须说什么、想什么或采取什么态度。

### 3. 自由叙事和受控交互并存

普通日常场景尽量保持自由。

对白、神态、姿势、情绪和一般动作不需要全部变成结构化工具调用。只有当某个行为会改变后续世界状态时，例如移动、物品转移、小游戏结果或创作者定义的特殊机制，才进入受控交互路径。

创作者还可以在特定活动期间临时收紧模型自由度，例如限制移动、对白形式、普通交互或游戏操作；活动结束后恢复普通自由场景。

### 4. 模型可以提出行动，但不能直接改写现实

Perspectra 区分：

```text
角色想做什么
    ↓
模型提出行动
    ↓
规则 / Interaction / Activity 判断
    ↓
提交世界事件
    ↓
角色看到实际结果
    ↓
继续自由表达
```

因此“角色说自己拿走了钥匙”和“系统确认钥匙已经转移”是两件不同的事。

项目不追求把所有叙事都形式化，而是只为真正影响因果连续性的状态保留权威边界。

### 5. 记忆属于角色，而不是全局聊天记录

默认模式仍使用项目原生记忆。

同时，源码网页提供显式的 `--memory-core` 实验入口，用于验证更长时间尺度的分层记忆：

```text
授权经历 Source
      ↓
提炼 Atom
      ↓
组织 Episode
      ↓
整合 Observation
      ↓
Recall
      ↓
候选准入
      ↓
极简 Delivery
      ↓
Character
```

这条实验路径保留角色级权限边界，并已加入较宽的短期上下文、长生命周期 Core 进程和后台长期整理。JEV 等早期复杂机制保留为实验对照，不再作为当前记忆链路的必经步骤。

Core 目前仍是**显式实验功能**，尚未替换默认原生记忆，也没有完整打包进桌面发行版。

## 当前已经能体验什么

当前 `main` 包含：

- 多角色独立视角与授权观察；
- 玩家推动的 Root Round 与有限 NPC Reaction Cycle；
- 自由对白、外显表现与角色自主回应；
- 声明式 Interaction、移动、物品及角色交互；
- 创作者定义的临时 Activity 与局部自由度限制；
- World Pack v5 内容系统；
- 本机浏览器试玩入口；
- Windows 桌面启动器；
- 本机 OpenAI 兼容接口、Ollama / DeepSeek 适配；
- 默认原生记忆；
- 可选的分层 Core 记忆、宽上下文与后台长期整理；
- 世界包自定义网页。

目前主要用于真实试玩的世界包是：

- `examples/world-packs/ai-girls-awaken-v10`
- `examples/world-packs/prototype-g1`
- `examples/world-packs/hand-in-hand`

另外保留 `ai-girls-hosted-guess` 作为角色主持活动的示例。

## 快速开始

需要 Node.js 22.19+ 或 24+，并使用仓库锁定的 pnpm。

```powershell
corepack pnpm@11.7.0 install --frozen-lockfile
```

### 本机网页试玩

默认连接本机 OpenAI 兼容接口。模型服务需要提前启动。

```powershell
corepack pnpm@11.7.0 experience:web `
  --pack examples/world-packs/ai-girls-awaken-v10 `
  --data-dir .tmp/my-playtest
```

启动后打开终端打印的完整本机地址，其中包含 `#token=`。

可通过环境变量修改模型服务：

```powershell
$env:HCW_LOCAL_ENDPOINT = "http://127.0.0.1:8045/v1/chat/completions"
$env:HCW_LOCAL_MODEL = "gemini-3.7-flash"
```

如果服务需要认证，只通过运行环境设置 `HCW_LOCAL_API_KEY`，不要把密钥写入世界包、脚本或仓库。

使用 Ollama：

```powershell
corepack pnpm@11.7.0 experience:web --ollama `
  --pack examples/world-packs/ai-girls-awaken-v10 `
  --data-dir .tmp/my-ollama-playtest
```

完整试玩说明见 [创作者与真实模型试玩指南](docs/current/guides/creator-playtest.md)。

### Windows 桌面启动器

开发环境：

```powershell
corepack pnpm@11.7.0 desktop
```

生成 Windows 免安装目录：

```powershell
pnpm desktop:release
```

上述命令是保留的 Electron 入口，尚未打包 Python / E5。当前新增的 Tauri Launcher 已接通真实包、独立实例、模型配置、Core 记忆、前端授权、角色预设和故事线；游戏在系统浏览器中打开。

```powershell
corepack pnpm@11.7.0 launcher:desktop
```

Windows x64 便携候选版自带 Node、Python、E5、WebView2 和 C++ 运行库。构建见 [便携包构建说明](scripts/release/BUILD.md)，结果与未完成门禁见 [候选版验收](docs/current/studies/launcher-portable-release-20261007.md)。测试包尚未完成干净系统、长时稳定性与原生目录选择器全流程验收；不将它视为正式发布版本。

### 可选：实验 Core 记忆

先按 [Activity Memory 实验入口](experiments/activity-memory/README.md) 准备 Python 与本地 E5 环境，再对一个新的存档显式启用：

```powershell
corepack pnpm@11.7.0 experience:web --memory-core `
  --pack examples/world-packs/ai-girls-awaken-v10 `
  --data-dir .tmp/my-core-playtest
```

Core 使用角色自己的授权经历构建长期档案。当前支持按上下文体积软触发后台整理，也保留手动整理入口；整理期间普通对话和移动可以继续。

详细机制见 [当前认知与记忆](docs/current/architecture/cognition-memory.md)。

创作者可在世界包的 `frontend/` 目录提供 HTML、CSS、JavaScript 和素材，使用显式 manifest 与公共玩家 SDK；未提供时使用官方默认模板。iframe 沙箱不持有 Core 令牌，前端不改变世界包编译身份。见 [自定义游戏前端指南](docs/current/guides/web-ui.md) 与 [最小沙箱实验](docs/current/frontend-v1.md)。

## 当前运行方式

```text
玩家输入
   │
   ▼
世界提交 / 当前刺激
   │
   ▼
按角色权限生成各自可见上下文
   │
   ├───────────────┐
   ▼               ▼
角色 A            角色 B ...
   │               │
   ▼               ▼
模型自主提案      模型自主提案
   │               │
   └──────┬────────┘
          ▼
   规则与交互裁定
          │
          ▼
      原子提交结果
          │
     ┌────┴────┐
     ▼         ▼
 玩家可见结果   新的授权观察
                   │
                   ▼
            有界后续 Reaction
                   │
                   ▼
                世界静止
```

模型输出不是数据库的另一种写法。

Perspectra 希望保留自由 RP 的表现力，同时只在必要的位置建立可信的因果边界。

## World Pack 与创作

World Pack 负责描述一个世界的内容与可用能力，例如：

- 角色与初始认知；
- 地点、物品与场景；
- 玩家槽位；
- 外显表现；
- 可用 Interaction；
- Activity / 游戏规则；
- 自定义网页资源。

项目倾向于 **小核心、丰富世界**：新的题材动作不应该因为“以后也许会用到”就不断进入核心枚举。只有当玩法真的需要新的权威状态与裁定逻辑时，才扩展受信任的领域实现。

创作入口：

- [World Pack 字段手册](docs/current/guides/world-pack-authoring.md)
- [创作者与真实模型试玩指南](docs/current/guides/creator-playtest.md)
- [自定义游戏网页](docs/current/guides/web-ui.md)
- [当前创作者运行时](docs/current/architecture/creator-runtime.md)

## 当前状态与限制

这个项目已经可以连续试玩，但仍然是实验原型，而不是完成品。

目前明确接受的限制包括：

- 自由文本仍可能叙述未经规则提交的受控事实；
- 角色认知隔离可以由程序保证边界，但不能保证模型永远正确理解语义；
- Core 的宽准入有时会交付无关认识；
- 长期记忆能否稳定改善角色自主选择仍需要更多真实试玩；
- 后台整理减少了前台阻塞，但没有消除模型调用本身的等待；
- 当前大上下文参数来自实验配置，并不代表已经完成完整容量与质量验收；
- 桌面发行版尚未包含实验 Core 的全部运行资产；
- World Pack 和实验协议在现阶段仍可能继续调整。

最新项目状态见 [docs/current/PROJECT-STATE.md](docs/current/PROJECT-STATE.md)。

AI Girls 的性能、宽上下文和后台整理实测见 [当前研究索引](docs/current/studies/ai-girls/README.md)。

## 文档

现在的文档按职责分开：

| 想了解什么 | 入口 |
| --- | --- |
| Perspectra 当前怎么工作 | [当前架构](docs/current/architecture/README.md) |
| 当前做到什么程度 | [项目状态](docs/current/PROJECT-STATE.md) |
| 如何运行和创作 | [当前指南](docs/current/guides/README.md) |
| 当前记忆架构 | [认知与记忆](docs/current/architecture/cognition-memory.md) |
| 自由 RP 与受控行为如何共存 | [Interaction](docs/current/architecture/interaction.md) |
| Activity 如何局部限制模型 | [受控交互](docs/current/architecture/controlled-interaction.md) |
| 最新性能与记忆实测 | [AI Girls 研究](docs/current/studies/ai-girls/README.md) |
| 实验代码与原始证据 | [experiments](experiments/README.md) |
| 过去的设计与阶段报告 | [archive](docs/archive/README.md) |
| 架构决策 | [ADR](docs/adr/README.md) |
| 冻结规格 | [spec](docs/spec/README.md) |

文档约定：

> **current = 当前结论，experiments = 实验证据，archive = 历史过程。**

历史文档中的“已完成”只代表当时版本，不自动代表今天仍采用相同设计。

## 开发与验证

主要实现位于：

| 路径 | 职责 |
| --- | --- |
| `packages/agents` | 角色上下文、模型提案与适配 |
| `packages/application` | 回合与反应流程 |
| `packages/kernel`、`packages/contracts` | 世界规则与共享契约 |
| `packages/store-sqlite` | 当前世界状态与持久化 |
| `packages/memory` | 原生记忆与召回 |
| `packages/interaction-runtime`、`packages/interactions-basic` | Interaction 运行时与基础能力 |
| `packages/world-pack` | World Pack 校验、编译与创作者工具 |
| `tests/experiments` | 真实模型和网页实验入口 |
| `experiments` | 记忆、JEV、召回等研究资产 |

日常检查：

```powershell
corepack pnpm@11.7.0 typecheck
corepack pnpm@11.7.0 test
corepack pnpm@11.7.0 check
```

自动测试用于验证机制边界，不能替代真实模型试玩。涉及角色自然度、重复、沉默、错误记忆或叙事越权的问题，最终仍需要看实际连续互动。

开发原则见 [AGENTS.md](AGENTS.md)。

---

Perspectra 当前最关心的问题不是“还能再加多少机制”，而是：

**这些机制是否真的让多角色 AI 世界比普通自由文本 RP 更连续、更可信，也更好玩。**
