# Perspectra

**语言 / Languages：[简体中文](README.md) | [English](README.en.md)**

**以角色为中心的 AI 原生游戏引擎。**

在 Perspectra 里，每个 AI 角色都有自己的认知、经历和目标，会自己决定说什么、做什么；世界的重要事实由规则维护，不靠模型记住；创作者用规则和活动组织剧情与玩法，把 Galgame 的人物互动、RPG 的探索与规则、生活模拟 SLG 的日常与经营放进同一个持续存在的世界。

> **让模型负责扮演角色，让系统负责维护世界，让玩家真正参与游戏，让创作者定义游戏的可能性。**

**[产品愿景](docs/current/vision.md)** · [当前实现与验证状态](docs/current/PROJECT-STATE.md) · [代码技术文档](docs/current/architecture/README.md)

项目仍处于早期公开测试阶段，适合**试玩、小型内容创作、玩法验证和机制测试**，暂不建议用于需要长期维护的大型正式项目。原项目名为 Cordis World，部分代码、命令和历史文档仍保留旧名称。

## 为什么做 Perspectra

在很多以对话续写为中心的 AI RP 中，聊天记录不只是故事的记录，也是世界的主要载体：物品在哪里、谁知道什么、剧情走到了哪一步，都要靠模型从文本里读出来，再继续写下去。

这很适合自由叙事。但当作品需要明确规则、多个角色和持续状态时，就会遇到三个困难：

- **世界需要有人推动。** 角色就算有目标，也未必有机会行动，玩家往往得兼任编剧和导演。
- **重要规则依赖模型自行遵守。** 模型写出“你拿到了钥匙”，这句话就同时成了故事描述和后续默认采用的事实。
- **角色的信息边界不由世界维护。** 多个角色共享一段包含秘密的上下文时，只能靠模型自己分辨谁知道什么。

即使引入多个 Agent，如果最后仍由一个负责整体叙事的 Agent 判断发生了什么，大部分负担依然集中在它的一次生成上。

Perspectra 的基本思路是**以角色为主体，以世界为载体，以规则为边界**：

- **事实与叙事分离**：创作者要求严格追踪的状态由规则和事件记录。叙述可以自由表达，但不能单独证明状态已经改变。
- **提出与裁定分离**：玩家和角色都可以尝试行动，需要受控的结果由规则判断。
- **角色认知分离**：每个角色只接收自己有权知道的信息，并根据自己的经历决定如何回应。

比如角色在对白里说“钥匙在我手里”，这句话确实被说出来了，听见的人也可能相信她；但钥匙的实际归属，仍由已经裁定的世界状态决定。普通对话、表情、语气和不需要严格维护的细节，依然由模型自由发挥。

## 核心机制

**角色认知与记忆。** 角色只接收自己获授权的信息；没有听见的秘密，不会因为别人知道就进入她的上下文。获知信息不等于获知真相，角色可以相信谎言、形成误解。长期记忆从角色自己的经历中整理认识，并保留来源和时间边界。[认知与记忆](docs/current/architecture/cognition-memory.md)

**世界事实与行动。** 移动、物品归属这类创作者明确追踪的变化，要经过规则裁定才会提交为世界事件。玩家在输入框里写的内容始终按发言或表现处理：写“我拿走了钥匙”不会改变钥匙的归属，要真正拿到钥匙，需要使用行动选项。这是为了让世界事实可信而有意接受的限制。[Interaction](docs/current/architecture/interaction.md)

**活动。** 创作者可以把一顿晚餐、一次约会、一场料理比赛或回合战斗组织成活动，安排开始条件、参与者、阶段、临时规则、共享与私有信息、固定演出和结算；活动结束后回到普通互动。约会邀请可以被拒绝，因为是否接受由被邀请的角色自己决定。[活动与状态指南](docs/current/guides/activity-and-variables.md)

**角色自主行动。** 调度系统给予角色处理机会，并限制次数和时间；角色自己决定回应、行动还是沉默。作者可以让关键角色在玩家不在场时按自己的目标行动，部分世界包还提供“静观”，让玩家主动让一轮过去。[创作者运行时](docs/current/architecture/creator-runtime.md)

**插件。** 世界包插件随作品提供，定义作品自己的状态和操作；本地宿主插件由玩家在 Launcher 启用，连接外部程序或服务，结果仍交回作品规则处理。[两种插件入口](docs/current/guides/dual-plugin-entrypoints.md)

## 试玩进展

目前已经用真实模型短时间试玩过同居日常、晚宴、谁是卧底、狼人杀、猜数字与约会邀请，以及多角色争夺物品的动态博弈。角色能自己行动、隐瞒秘密，也会依据自己看到的信息作出判断（包括判断错误），只是偶尔会说要行动却没有执行，或者叙述了不存在的细节。这些都还是几局到十几个回合的小样本，长期游玩的稳定性还没有验证。

这种方式也有代价：每个角色需要单独调用模型，一轮互动往往会调用多次，成本和等待时间都比单次生成高。在之前的试玩中，普通对话每轮要等 5～37 秒，有角色在场外行动的回合要等 19～47 秒；一次三角色博弈实验的 24 个回合共调用模型 61 次，约 28 万 token。

## 开始试玩

### Windows x64 程序预发行版

当前预发行版为 **0.3.1-test1**（2026-10-24，candidate4）：只发布 Perspectra 程序与创作工具，**不附带试玩包**。包含当前默认舞台、新启动器图标、自带 Node／Python、Core 记忆依赖、离线 E5、WebView2 和 C++ 运行库；玩家仍需自己的模型服务与完整的 v5 作品源目录。

[下载程序 ZIP](https://github.com/YouLan5418/Perspectra/releases/download/v0.3.1-test1/Perspectra-0.3.1-win-x64-candidate4.zip) · [预发行页面](https://github.com/YouLan5418/Perspectra/releases/tag/v0.3.1-test1) · [SHA-256](https://github.com/YouLan5418/Perspectra/releases/download/v0.3.1-test1/Perspectra-0.3.1-win-x64-candidate4.zip.sha256) · [随包验收记录](https://github.com/YouLan5418/Perspectra/releases/download/v0.3.1-test1/acceptance.zh-CN.md)

ZIP 为 521,587,384 字节，SHA-256：`bbfe12fda796d0288450b6e0285065cfeb0f84a86944d25ce719c9b4504c70ce`。

1. 完整解压，运行 `Perspectra.exe`，保留同目录的 `runtime`。
2. 点右上角 ⚙，在“模型接口”配置连接与模型，测试接口。测试会发送少量请求，只证明接口能响应。
3. 另行取得或创作完整的 `worldpack-source/v5` 源目录，在 Launcher 载入、创建实例并开始，游戏在系统默认浏览器中打开。
4. 等待当前行动完成后保存进度，结束游戏后可从节点分叉或导出存档。API Key 按连接存入 Windows 凭据管理器，不写入作品或存档；备份前结束游戏并退出 Launcher。

本次已检查随包 CLI／Skill、宿主启停、默认前端比对和离线编码；干净 Windows、原生界面完整流程和真实模型连续试玩尚未完成。既有全仓格式问题、一次活动测试不稳定及历史文档断链见随包验收记录。`build-info.json` 的 `sourceDirty=true`，GitHub 自动源码归档不等同于该次未提交构建工作区。

[旧 test3 预发行版](https://github.com/YouLan5418/Perspectra/releases/tag/v0.1.0-test3)保留为 2026-10-09 的历史构建，含旧试玩内容；它的验收不代表新程序已完成真实体验验收。

### 从源码运行

需要 Node.js 22.19+ 或 24+，使用仓库锁定的 pnpm。原生 Launcher 开发还需要 Rust/Cargo、Windows 构建工具和 [Python/E5 记忆环境](desktop/host/memory/README.md)。

```powershell
corepack pnpm@11.7.0 install --frozen-lockfile
corepack pnpm@11.7.0 launcher:desktop
```

不使用 Launcher 时，也可以运行本机网页入口。先启动自己的模型服务，再设置地址与模型：

```powershell
$env:PERSPECTRA_MODEL_ENDPOINT = "http://127.0.0.1:8046/v1/chat/completions"
$env:PERSPECTRA_MODEL = "gemini-3.7-flash"
corepack pnpm@11.7.0 experience:web `
  --pack examples/world-packs/model-girls-official `
  --data-dir .tmp/my-playtest
```

地址与模型只是本机验证示例，请按自己的服务修改。如需认证，通过环境设置 `PERSPECTRA_MODEL_API_KEY`，不要写入世界包、脚本或仓库。打开终端打印的完整本机地址；其中的令牌不要公开分享。源码网页入口默认使用 Core 记忆，需准备 Python/E5；仅离线调试可显式加 `--memory-native`。

模型适配经 pi-ai，支持 OpenAI 兼容、Anthropic Messages 与 Google Gemini 协议；DeepSeek、Ollama 按 OpenAI 兼容地址配置，见[模型接口协议](docs/current/model-protocols.md)。

[Launcher 开发说明](apps/launcher/README.md) · [便携包构建说明](scripts/release/BUILD.md) · [创作者与真实模型试玩指南](docs/current/guides/creator-playtest.md)

## 创作自己的内容

World Pack v5 描述角色、初始认知、地点、物品、场景、玩家槽位、交互、活动和前端资源。当前 Launcher 接受 v5 源目录，不直接导入 ZIP；载入后的包路径需要保留。

可以从这些示例开始：

- `examples/world-packs/model-girls-official`：官方序章与晚餐、私密交流、蛋糕和跨日回访事件。
- `examples/world-packs/model-girls-sweet-days`：《屋檐下的心动日程》，同居恋爱与生活安排，含谁是卧底等可反复玩的活动。
- `examples/world-packs/model-girls-dinner`：《赔罪晚宴》，没有序章、没有预定结局的四人晚宴。
- `examples/world-packs/model-girls-werewolf`：7 人局狼人杀实验，验证身份隔离与跨局记忆。
- `examples/world-packs/multiple-activities`：多个活动的暂停、恢复与约会邀请。
- `examples/world-packs/hidden-cure`：没有活动和预设分支的多角色动态博弈实验。
- `examples/world-packs/prototype-g1`：两房间、角色和基础物品交互的最小示例。

### 创作 Skill 与命令行工具

随包 `skills/perspectra-creator` 整合原创世界包、酒馆 PNG／JSON 卡静态提取与迁移，以及原生模型预设创作。把整个目录复制到所用 AI 工具的 Skill 目录，告诉它 Perspectra 解压位置与创作需求即可；它使用程序自带 Node／Python。原卡脚本、HTML、EJS 与正则只作为数据审阅，所需玩法另行重写。

```powershell
& 'D:\Perspectra\worldpack.cmd' validate 'D:\我的游戏'
& 'D:\Perspectra\worldpack.cmd' test 'D:\我的游戏'
& 'D:\Perspectra\worldpack.cmd' preset validate 'D:\我的游戏\model-preset.json' --pack
```

`test` 只编译适配，`assertionsExecuted: 0`；静态通过后仍需在 Launcher 新建实例做真实玩法验收。

[World Pack v5 创作指南](docs/current/guides/world-pack-authoring.md) · [活动与状态](docs/current/guides/activity-and-variables.md) · [创作者运行时](docs/current/architecture/creator-runtime.md) · [两种插件入口](docs/current/guides/dual-plugin-entrypoints.md)

## 功能一览

| 功能 | 当前范围 | 详细说明 |
| --- | --- | --- |
| 角色认知隔离 | 按角色权限提供观察、经历与上下文 | [认知与记忆](docs/current/architecture/cognition-memory.md) |
| 长期记忆 | 从授权经历整理认识，支持召回与后台整理 | [认知与记忆](docs/current/architecture/cognition-memory.md) |
| 世界状态与交互 | 明确追踪的状态经过规则裁定后提交 | [Interaction](docs/current/architecture/interaction.md) |
| 活动 | 开始条件、参与者、阶段、临时规则、信息范围与结算；一次运行一场 | [活动与状态](docs/current/guides/activity-and-variables.md) |
| 角色自主行动 | 有界的反应与场外行动机会，由角色自己决定 | [创作者运行时](docs/current/architecture/creator-runtime.md) |
| 插件 | 世界包插件与本地宿主插件 | [两种插件入口](docs/current/guides/dual-plugin-entrypoints.md) |
| 故事线 | 保存节点及当时记忆、分叉续玩、单节点导出导入；最近一回合可重新生成 | [故事线](docs/current/storylines.md) |
| 角色预设 | 全局默认、包推荐、实例覆盖、角色组和角色专属配置 | [预设说明](docs/current/model-presets.md) |
| 自定义前端 | HTML/CSS/JavaScript 与公共玩家接口，默认沙箱，可显式授权受信任模式 | [前端创作指南](docs/current/guides/web-ui.md) |
| 桌面 Launcher | 载入世界包、独立实例、多条模型连接、按角色选模型 | [Launcher](apps/launcher/README.md) |
| 创作者页面 | 运行时只读查看对话、行动轨迹、实际模型请求、物品去向和角色记忆 | [调试接口](docs/current/creator-debug-api.md) |

这些运行链路已经接通；自动化检查与本机真实试玩不代表所有玩法、模型或机器环境都已验证。

## 已知限制

- 真实模型仍可能格式错误、处理失败、重复回应或产生叙事越权；连接成功不保证玩法稳定。
- 认知隔离保证程序提供的信息范围，不保证模型永远正确理解信息或从不虚构细节。**自由文本仍可能作出未经裁定的状态变化声明，并影响其他角色的理解**；数据库没有越权变化，不代表叙事上的矛盾已经解决。
- 活动一次只运行一场，暂停的活动不会在后台推进，活动也不能直接移动角色；活动隔离的是活动信息，同场非参与者仍能听到公开发言。
- 角色自主行动发生在玩家推进的回合内，还没有按现实时间在后台持续运行的世界。
- 长期记忆可能交付无关认识；后台整理和大上下文的容量、性能与角色体验仍需更多测试。
- 受信任模式的前端可以访问外部网络，它加载的远程内容可能在游戏包摘要不变的情况下发生变化；请只授权自己认可的来源。受信任前端仍拿不到 Core 令牌、模型密钥、角色私有上下文或数据库权限。
- 便携版尚未完成干净 Windows 环境、长时间稳定性和原生目录选择器完整流程验收；没有代码签名、自动更新或跨版本存档迁移保证。

验证证据见[程序包验收记录](docs/current/studies/program-package-creator-skill-20261024.md)和[项目状态](docs/current/PROJECT-STATE.md)。

## 反馈问题与体验

欢迎在 [GitHub Issues](https://github.com/YouLan5418/Perspectra/issues) 提交 Bug、设计问题和体验反馈。我们尤其希望了解：角色是否自然、是否知道了不该知道的信息、记忆是否改善连续互动、世界状态与叙事是否矛盾，以及规则是否帮助了玩法。

反馈请提供测试版本、Windows 环境、使用的游戏包和前端模式、模型标识与接口类型、最短复现步骤、预期与实际结果，以及遮挡私人信息后的截图。可参考[反馈模板](scripts/release/feedback-template.zh-CN.md)。

**不要公开 API Key、原始模型请求、完整数据库或角色私密日志。** 实际模型请求窗口包含私有角色上下文，只用于自己调试。

## 开发与文档

```powershell
corepack pnpm@11.7.0 check
corepack pnpm@11.7.0 launcher:check
```

自动测试验证机制边界，不能替代真实模型试玩。只浏览 Mock 界面的命令为 `launcher:dev`，它不能启动真实 Core。

| 想了解什么 | 入口 |
| --- | --- |
| 项目最终想做什么 | [产品愿景与核心设计理念](docs/current/vision.md) |
| 当前状态与证据 | [项目状态](docs/current/PROJECT-STATE.md) |
| 易读的代码解释与当前运行机制 | [代码技术文档](docs/current/architecture/README.md) |
| 试玩与创作指南 | [当前指南](docs/current/guides/README.md) |
| 记忆实测与性能 | [AI Girls 研究](docs/current/studies/ai-girls/README.md) |
| Windows x64 便携构建 | [构建说明](scripts/release/BUILD.md) |
| 实验代码与证据 | [experiments](experiments/README.md) |
| 历史设计 | [archive](docs/archive/README.md)、[ADR](docs/adr/README.md)、[spec](docs/spec/README.md) |
| 开发约束 | [AGENTS.md](AGENTS.md) |

文档中的历史“已完成”只表示当时版本；当前行为应以现行文档、源码与真实验收为准。
