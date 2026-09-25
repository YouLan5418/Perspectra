# Cordis World

**一个面向多角色扮演的、由玩家推动的 AI 世界实验项目。**

Cordis World 希望让多个角色在同一个世界里，以各自的经历、记忆和可见信息作出反应，而不只是由一个模型轮流模仿所有人。玩家的一次输入可以触发有限轮 NPC 连锁回应；没有新输入、反应周期结束后，世界重新静止。

项目当前处于**实验与重构阶段**。首要目标是让角色更自然、玩法更自由，同时避免关键世界状态和角色知识相互串台。它还不是完整的在线游戏平台，也不承诺现有实验协议或世界包长期兼容。

## 我们想解决什么

传统自由文本角色扮演可以非常生动，但在多角色、长时间互动中容易出现一些问题：角色知道自己不曾听见的秘密；有人只是在对白里说拿走了钥匙，系统便将其当作真实转移；NPC 之间的反应要等玩家再输入一句话才会继续。

Cordis World 尝试在**叙事自由**与**关键因果的一致性**之间建立适度边界：

- **独立的角色视角**：各角色只接收自己获授权的观察、记忆和认知；说出一个主张不代表主张自动成为世界真相。
- **角色主体性**：角色自行决定是否回应、怎么回应、想尝试什么行为；调度不应把它们变成只负责填台词的演员。
- **有限的连续反应**：一条玩家输入可开启有上限的反应周期；NPC 能回应其他 NPC 刚刚产生的、自己确实观察到的新事件。
- **关键状态有依据**：移动、物品归属等影响后续逻辑的变化由规则裁定后提交；自由的台词、神态和叙述不必全部被编码成精确事件。
- **按玩法扩展**：世界包描述角色和内容；新的确需要规则与状态的玩法可以通过交互定义和受信任领域代码扩展，而不是不断向核心枚举添加题材动作。

这些是项目目标，**不代表目前每项体验都已达到预期**。表达与有界调度已有连续试玩证据；[G1 的模型无关机械门槛](docs/PROTOTYPE-G1-G2-ACCEPTANCE.md)已验收，G2 两项诊断和格式修正仍是待办。[G3 第一组连续真实试玩](docs/PROTOTYPE-G3-PLAYTEST-01.md)已完成，但握手叙述分叉与互动断层表明体验门槛尚未通过。

## 当前能体验什么

仓库包含本机浏览器试玩入口、Ollama/DeepSeek 模型适配、多个示例世界包、角色受限视角、记忆与有限反应周期。已有版本支持外显表现、物品及角色交互；其具体可用范围取决于世界包和运行时协议。

**建议先从真实模型试玩开始，而不是先运行完整工程验收。** 以下命令均在仓库根目录执行；需要 Node.js 22.19+ 或 24+ 与项目锁定的 pnpm。

```powershell
corepack pnpm@11.7.0 install --frozen-lockfile

# 本机 Ollama（需提前启动 Ollama 并准备可用模型）
corepack pnpm@11.7.0 experience:web --pack examples/world-packs/ai-girls-awaken-v10 --data-dir .tmp/prototype-local

# 或显式使用 DeepSeek；需先为当前进程设置 DEEPSEEK_API_KEY
corepack pnpm@11.7.0 experience:web:flash --pack examples/world-packs/ai-girls-awaken-v10 --data-dir .tmp/prototype-deepseek
```

启动后，打开终端打印的**本机**浏览器地址。网页只监听回环地址，不是可公开访问的在线服务。远程模型请求可能产生费用；不要把 API Key 写进世界包、命令示例或提交记录。

体验其他世界包时，可为实验入口指定 Pack 与独立数据目录：

```powershell
corepack pnpm@11.7.0 experience:web --pack examples/world-packs/ai-girls-awaken-v10 --data-dir .tmp/my-playtest
```

本原型网页只接受 `worldpack-source/v5` 源目录，并通过 v10 的 FrozenWorldPlaytestRuntime 试玩；旧网页运行时已移除。创建新存档或续玩时请按[创作者与真实模型试玩指南](docs/CREATOR-PLAYTEST-RUNBOOK.md)操作，不要在同一数据目录中混用不兼容世界版本。真实模型试玩需要人工观察角色是否自然、是否重复、是否无故沉默，自动化测试不能代替这一环节。

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

- [当前自由表达实现与实测](docs/PROTOTYPE-PLAYTEST-02.md)：已落地范围、失败样本和下一步。
- [玩家输入与反应链诊断](docs/PROTOTYPE-PLAYTEST-03.md)：玩家表达实测、反复唤醒与主动沉默的证据。
- [人设与最小调度规则对照](docs/PROTOTYPE-PLAYTEST-04.md)：顺序实验结果与尚未解决的重复反应。
- [反应周期上下文审计](docs/PROTOTYPE-PLAYTEST-05.md)：逐次检查自身回应历史、触发观察及 abstain 提示。
- [自身历史呈现对照](docs/PROTOTYPE-PLAYTEST-06.md)：单独突出已发布表达后的真实模型结果。
- [abstain 语义与扩大预算实验](docs/PROTOTYPE-PLAYTEST-07.md)：区分不发布内容、非语言表达与周期终止原因。
- [单次交互与结果后续写](docs/PROTOTYPE-PLAYTEST-08.md)：独立执行切片、成功/拒绝实测及尚未接入群体试玩的边界。
- [角色可读结果与网页最小集成](docs/PROTOTYPE-PLAYTEST-09.md)：选定 GPT 的物品交互，提交后复用现有 Reaction 续写的实测与启用方式。
- [连续互动与事实分叉审计](docs/PROTOTYPE-PLAYTEST-10.md)：连续拿取、递交与跨场景试玩；反馈及时性、归属误判传播及续写越界的证据。
- [当前状态与续写边界对照](docs/PROTOTYPE-PLAYTEST-11.md)：区分可见状态、上次观察与对白，修正服务失败提示；实现与尚未通过的模型行为验收。
- [通用单角色激活接入](docs/PROTOTYPE-PLAYTEST-12.md)：原型网页默认逐角色执行与结果续写，非 GPT 物品、移动实测及 G1/G3 验收边界。
- [两 NPC 连续场景试玩](docs/PROTOTYPE-PLAYTEST-13.md)：同物品重新决策、跨房间观察隔离、返回交流的真实模型与事件证据。
- [G4 架构减法与收口记录](docs/PROTOTYPE-G4-ARCHITECTURE-AUDIT.md)：当前网页调用链、已完成的旧路径清理，以及保留接口与后续问题的边界。

- [创作者与真实模型试玩指南](docs/CREATOR-PLAYTEST-RUNBOOK.md)：入口、世界版本与常见问题。
- [主线真实模型体验记录](docs/REAL-MODEL-EXPERIENCE.md)：历史试玩环境、观察与限制。
- [2026-09-10 真实模型试玩问题记录](docs/2026-09-10_真实模型试玩记录-v8拒绝原因与契约缺口.md)：复杂输出协议导致角色整轮提案被拒的实测案例。
- [ADR 索引](docs/adr/README.md)：历史架构选择及其背景。部分决策正在复核，不应将“Accepted”直接等同于当前产品方向。

当前优先事项是恢复与提升角色自然度、减少不必要的模型输出约束，并在保留角色认知隔离和关键事实一致性的基础上简化实现。**更完整的工程证明不等于更好的角色扮演体验。**
