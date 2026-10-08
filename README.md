# Perspectra

**为多角色自由 RP 提供角色认知隔离、长期记忆、世界状态与自定义玩法的 AI 世界实验项目。**

Perspectra 希望在尽量保留自由表达和角色主体性的前提下，让系统维护创作者明确声明的规则与重要状态，让模型专注于角色扮演。

> **模型负责怎么演，系统负责哪些世界变化已经成立。**

项目正在准备面向玩家与创作者的早期公开测试。当前版本适合**试玩、小型内容创作、玩法验证和机制测试**，暂不建议用于需要长期维护的大型正式项目。

原项目名为 Cordis World；部分代码、命令和历史文档仍保留旧名称。

## 开始试玩

### Windows x64 便携候选版

当前候选版本为 **0.1.0-test2**，自带 Node、Python、Core 记忆依赖与离线 E5 模型、WebView2 和 C++ 运行库。玩家无需安装开发工具，但仍需要自己的模型服务。

[版本与下载入口](https://github.com/YouLan5418/Perspectra/releases) · [试玩说明](scripts/release/README.zh-CN.md) · [候选版验收记录](docs/current/studies/launcher-portable-test2-20261007.md)

**当前候选 ZIP 已在本机构建，尚未上传为 GitHub Release 附件。** 本仓库提供源码和构建脚本；下载以实际发布的 Release 附件为准。

完整操作见 [玩家试玩指南](docs/current/guides/player-playtest.md)。

拿到测试包后：

1. 完整解压，运行 `Perspectra.exe`，保留同目录的 `runtime`。
2. 打开“模型设置”，填写 OpenAI 兼容的完整 `.../v1/chat/completions` 地址、模型标识和需要的 API Key。
3. 点击“测试模型连接”，成功后应用设置。连接测试会发送一次少量请求，只验证接口响应，不保证模型能稳定遵循游戏的结构化输出协议。
4. 载入随包的 `examples/测试示例` 目录，创建实例并开始游戏。游戏在系统默认浏览器中打开，Launcher 保持独立窗口。
5. 结束游戏后可以继续原进度；需要分叉时，在游戏运行且当前操作完成后，打开“故事线”保存完整节点，再停止游戏并创建新线路。

`examples/前室与后室` 提供官方默认界面的基础示例；`examples/测试示例` 包含社区前端、包推荐预设、变量和猜数字活动。

Launcher 使用 Core 记忆。API Key 仅保留于当前会话，不写入游戏包或存档；重开 Launcher 后需要重新填写。数据目录可在设置中查看，备份前应结束游戏并退出 Launcher。

### 从源码运行

需要 Node.js 22.19+ 或 24+，使用仓库锁定的 pnpm。原生 Launcher 开发还需要 Rust/Cargo、Windows 构建工具和 [Python/E5 记忆环境](experiments/activity-memory/README.md)。

```powershell
corepack pnpm@11.7.0 install --frozen-lockfile
corepack pnpm@11.7.0 launcher:desktop
```

[Launcher 开发说明](apps/launcher/README.md) · [便携包构建说明](scripts/release/BUILD.md)

不使用 Launcher 时，也可以运行本机网页入口。先启动自己的模型服务，再设置地址与模型：

```powershell
$env:HCW_LOCAL_ENDPOINT = "http://127.0.0.1:8046/v1/chat/completions"
$env:HCW_LOCAL_MODEL = "gemini-3.7-flash"
corepack pnpm@11.7.0 experience:web `
  --pack examples/world-packs/launcher-demo `
  --data-dir .tmp/my-playtest
```

地址与模型只是本机验证示例，请按自己的服务修改。如需认证，通过环境设置 `HCW_LOCAL_API_KEY`，不要写入世界包、脚本或仓库。打开终端打印的完整本机地址；其中的令牌不要公开分享。

**源码网页入口默认使用原生记忆**；准备好 Python/E5 后，添加 `--memory-core` 可启用 Core 记忆。源码网页另保留 Ollama/DeepSeek 适配，Launcher 当前只使用 OpenAI 兼容 `chat/completions` 接口。

完整说明见 [创作者与真实模型试玩指南](docs/current/guides/creator-playtest.md)。

## 当前能体验什么

| 功能 | 当前范围 |
| --- | --- |
| 角色认知隔离 | 按角色权限提供观察、经历与上下文；不同角色可以拥有不同认知 |
| 角色自主回应 | 玩家推动有界反应周期，角色可以决定回应、沉默或提出行动 |
| 长期记忆 | 基于角色授权经历整理认识，支持召回、宽短期上下文与后台整理 |
| 世界状态与交互 | 移动、物品归属等明确追踪的状态经过规则裁定，再提交世界事件 |
| Activity | 创作者定义局部活动规则、允许操作、状态与结束条件 |
| Storyline | 保存完整节点、从历史节点分叉、保留原线并独立续玩 |
| 角色预设 | 全局默认、包推荐、实例覆盖、角色组和角色专属配置 |
| 自定义前端 | HTML/CSS/JavaScript 与公共玩家接口，默认 iframe 沙箱、明确授权的受信任模式 |
| 桌面 Launcher | 载入 v5 世界包目录、独立实例、模型配置、启停与继续游戏 |

这些运行链路已经接通；自动化检查与本机真实试玩不代表所有玩法、模型或机器环境都已验证。

### 角色认知与记忆

角色只接收自己获授权的信息。没有听见的秘密，不应仅因为其他角色的上下文包含它就进入自己的上下文。

获知信息不等于获知真相：角色可以听到谎言、相信传闻，或者形成误解；这些认识不会自动成为权威世界事实。

Core 记忆的大致路径是：

```text
角色获授权的信息 → 提炼与组织经历 → 形成长期认识 → 检索与召回 → 角色回应
```

记忆首先服从角色、世界与经历范围的边界，再考虑召回。整理需要模型调用，长期记忆能否稳定改善角色表现仍需要真实试玩验证。

[认知与记忆架构](docs/current/architecture/cognition-memory.md)

### 世界状态与 Activity

对白、表情、语气和一般叙事表现尽量保留自由。对于创作者明确要求追踪的重要变化，模型或玩家提出行动后，由规则与交互定义裁定，再提交为世界事件。

Activity 可以在特定玩法中临时收紧允许操作、移动或表达方式，维护活动状态与结果，结束后恢复普通 RP。调度系统给予角色处理机会，但不预先规定角色的情绪、意图或对白。

**自由文本仍可能作出未经裁定的状态变化声明，甚至影响后续角色理解。数据库没有越权变化，不代表叙事语义上的矛盾已经解决。** 这是当前明确保留的测试问题。

[Interaction](docs/current/architecture/interaction.md) · [Activity 与受控交互](docs/current/architecture/controlled-interaction.md)

### Storyline：从同一个过去走向不同的未来

玩家可以保存当前世界的完整节点，并从历史节点开启新线路，尝试另一种选择，同时保留原线路的进度。

新线路恢复节点时的世界状态，并根据各角色截至该节点的授权经历重建记忆，避免直接带入原线路后来的经历。重建需要等待和模型调用，认识的具体措辞可能不同。

当前 Storyline 是**保存、分叉与独立续玩**；源码版支持单个完整节点的文件分享导入；持续剧情阶段追踪、线路合并和完整树分享不在当前实现范围内。

[故事线使用与边界](docs/current/storylines.md)

### 轻量化角色预设

预设支持角色提示、生成参数、提示节点、基础宏与文本规则，并可在预设库中保存、导入和导出原生配置。

实例内按 **角色专属 > 角色组 > 实例默认** 选择配置。预设可调整模型如何扮演和表达，但不能替代角色认知边界、世界规则或 Core 的结构化输出契约。

当前使用 Perspectra 原生格式，不能直接导入酒馆预设；Assistant Prefill 和自定义上下文模板尚未接入。

[预设说明](docs/current/model-presets.md)

### 自定义前端与授权

创作者可以在内容包的 `frontend/` 目录提供 HTML、CSS、JavaScript 和素材，通过显式 manifest 与公共玩家接口展示内容、提交操作；没有自定义前端时使用官方默认模板。

社区前端默认运行在 iframe 沙箱中。玩家明确授权当前实例与前端内容后，可以启用受信任模式，开放外部网络和浏览器存储等能力；仍不提供 Core 令牌、模型密钥、角色私有上下文或数据库权限。

授权可以撤销，运行中撤销会恢复官方沙箱模板并保留已提交进度。

> **受信任前端访问的远程内容可以在不改变游戏包摘要的情况下发生变化。** 请只授权自己认可的来源。

[前端创作指南](docs/current/guides/web-ui.md) · [沙箱边界](docs/current/frontend-v1.md) · [前端授权](docs/current/frontend-authorization.md)

## 创作自己的内容

World Pack v5 描述角色、初始认知、地点、物品、场景、玩家槽位、交互、Activity 和前端资源。

可从小型示例开始验证：

- `examples/world-packs/prototype-g1`：两房间、角色和基础物品交互。
- `examples/world-packs/launcher-demo`：Launcher 测试示例，含活动、预设与社区前端。
- `examples/world-packs/hand-in-hand`：角色交互示例。
- `examples/world-packs/ai-girls-hosted-guess`：角色主持活动示例。
- `examples/world-packs/ai-girls-awaken-v10`：多角色真实试玩研究包。

当前 Launcher 接受 v5 世界包源目录，不直接导入 ZIP；载入后的包路径需要保留。当前不自动替换同 ID 的不同内容包，也不保证跨版本存档迁移。

[World Pack v5 创作指南](docs/current/guides/world-pack-authoring.md) · [活动与变量](docs/current/guides/activity-and-variables.md) · [当前创作者运行时](docs/current/architecture/creator-runtime.md)

## 已知限制与验收状态

- 便携候选版尚未完成干净 Windows 环境、长时间稳定性和原生目录选择器完整流程验收。
- 真实模型仍可能格式错误、处理失败、重复回应或产生叙事越权；连接成功不保证玩法稳定。
- 认知隔离保证程序提供的信息范围，不保证模型永远正确理解信息或从不虚构细节。
- 长期记忆可能交付无关认识；后台整理和大上下文的容量、性能与角色体验仍需更多测试。
- 某些交互按钮仍显示机器 ID；没有代码签名、自动更新或跨版本存档迁移保证。
- 此前便携候选包尚不包含本轮单节点分享；线路合并及部分预设能力尚未实现，内容格式可能继续调整。

完整验证证据与未完成项见 [候选版验收记录](docs/current/studies/launcher-portable-test2-20261007.md)，当前架构状态见 [项目状态](docs/current/PROJECT-STATE.md)。

## 反馈问题与体验

欢迎在 [GitHub Issues](https://github.com/YouLan5418/Perspectra/issues) 提交 Bug、设计问题和体验反馈。

我们尤其希望了解：角色是否自然、是否知道了不该知道的信息、记忆是否改善连续互动、世界状态与叙事是否矛盾，以及规则是否帮助了玩法。

反馈请提供：

- 测试版本、Windows 环境、使用的游戏包和前端模式；
- 模型标识与接口类型；
- 最短复现步骤、预期与实际结果；
- 界面错误文字，以及遮挡私人信息后的截图。

**不要公开 API Key、原始模型请求、完整数据库或角色私密日志。** 实际模型请求窗口包含私有角色上下文，只用于自己调试。可参考 [反馈模板](scripts/release/feedback-template.zh-CN.md)。

## 开发与文档

```powershell
corepack pnpm@11.7.0 check
corepack pnpm@11.7.0 launcher:check
```

自动测试验证机制边界，不能替代真实模型试玩。只浏览 Mock 界面的命令为 `launcher:dev`，它不能启动真实 Core。旧 Electron 入口 `desktop` / `desktop:release` 仍保留，其打包范围与当前 Tauri 便携候选版不同。

| 想了解什么 | 入口 |
| --- | --- |
| 当前运行机制与权限边界 | [当前架构](docs/current/architecture/README.md) |
| 当前记忆实测与性能 | [AI Girls 研究](docs/current/studies/ai-girls/README.md) |
| Launcher 开发与运行 | [Launcher README](apps/launcher/README.md) |
| Windows x64 便携构建 | [构建说明](scripts/release/BUILD.md) |
| 试玩与创作指南 | [当前指南](docs/current/guides/README.md) |
| 实验代码与证据 | [experiments](experiments/README.md) |
| 历史设计 | [archive](docs/archive/README.md)、[ADR](docs/adr/README.md)、[spec](docs/spec/README.md) |
| 开发约束 | [AGENTS.md](AGENTS.md) |

文档中的历史“已完成”只表示当时版本；当前行为应以现行文档、源码与真实验收为准。
