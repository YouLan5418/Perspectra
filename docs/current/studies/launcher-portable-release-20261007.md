# Perspectra Windows x64 便携测试候选版验收

日期：2026-10-07。版本：0.1.0-test1。状态：候选测试包已构建，本机便携运行链路已验证，尚未通过干净系统及长时发布验收。未上传、发布或签名。

## 1. 交付内容

包自带正式 Release Launcher、Node v24.14.1、独立 CPython 3.12.13 及现有记忆运行依赖、量化 E5 模型、Fixed WebView2 154.0.4258.62 x64。玩家不需要安装 Node、Python、Rust；模型服务仍由玩家配置。

目录：`dist/portable/Perspectra-0.1.0-test1-win-x64`；同名 ZIP 和 `.zip.sha256` 为交付物。完整解压后运行根目录 Perspectra.exe。解压文件约 1.20 GB（十进制）；以最终 ZIP 文件长度为准。

```text
Perspectra-0.1.0-test1-win-x64/
  Perspectra.exe
  build-info.json
  开始试玩.md
  反馈模板.md
  干净系统验收.md
  验收记录.md
  examples/
    前室与后室/          基础包
    测试示例/            含社区前端、活动与包推荐预设
  licenses/             Node/Rust依赖、Hindsight、模型说明
  runtime/
    node.exe
    launcher.mjs
    playtest.mjs
    node_modules/jieba-wasm/
    python/             保留依赖内的许可文件
    models/e5-small/
    experiments/{hindsight-core,activity-memory}/
    webview2/
```

实例数据不在包内。默认用户数据目录以设置页为准；密钥仅在本次会话中保留。包中没有私人实例、模型请求采集或验收令牌。

## 2. 实现与实际问题

- `apps/launcher/src-tauri/src/main.rs`：优先从 EXE 同级 runtime 启动绝对路径 Node，设置独立 Python/模型/缓存路径；正式构建缺依赖直接报错，源码回退仅用于 debug。优先使用随包 WebView2，保持现有 Windows Job 子进程清理。
- `desktop/launcher-core.ts`：便携模式调用打包 playtest.mjs。新增独立模型连接测试，只发送固定公开短文本，不回显服务正文，不保存密钥。
- `apps/launcher/src/services/desktop.ts`、`SettingsDialog.vue`：接入连接测试与可读状态；明确它不验证游戏的结构化输出能力。
- `desktop/save-preflight.ts` / 新 `save-preflight-entry.ts`、`desktop/main.ts`、`package.json`：拆分可复用存档校验与 CLI 入口，修复 bundle 后 import.meta CLI 判断误触发导致 Launcher 直接退出。
- `experiments/hindsight-core/vector_core.py`：便携缓存写入实例数据目录，运行依赖不被修改。
- `e5-assets.json`：修正 ONNX 资产仓库为 Xenova；固定 revision 和六个 SHA-256 不变。
- `scripts/release/`：新增构建、冒烟、许可收集、ZIP/CRC/SHA-256 归档脚本和玩家文档。复制 Python 时展开 junction；归档拒绝链接。首次清单遗漏 candidate_admission.py/minimal_delivery.py，已补齐，最终导入检查通过。
- `examples/world-packs/launcher-demo/`：公开测试示例，移除了本机 QA 探针与临时预设导出。

新增独立连接测试回归，覆盖成功、网络/认证/限流/服务格式错误和不保存密钥。没有引入新数据库、游戏协议或权限层。

## 3. 验证证据与边界

| 验证 | 结果 / 范围 |
|---|---|
| 默认检查 | 类型、lint、37 个文件 / 265 项测试通过 |
| Launcher 检查 | Vue 类型检查、10 项测试通过 |
| 正式 Windows Release | Tauri build --no-bundle 成功；最终 EXE 未带临时 WebView 调试参数 |
| 最终包 IPC 冒烟 | 新数据，载入基础包、创建、8046 实际连接、启动和停止通过 |
| 离线 Python | 无开发工具 PATH、HF/Transformers offline；所有运行模块导入成功，编码 shape [1,384] 且有限 |
| 物理文件 | 最终包无 symlink/junction；模型六个资产哈希在构建时校验 |
| 正式原生界面 | 包搬到源码目录之外、工作目录 C:/Windows/Temp，PATH 仅 Windows 系统工具；主界面、设置、模型连接、Core 启动已验证 |
| 正常退出 | 最终正式 EXE 继续真实游戏，运行中关闭主窗口；所记录的 Node/Core/Python 子进程残留 0 |
| 扩展原生界面测试 | 临时带调试端口的 Release 验收构建验证载入、创建、预设保存、启动/停止；此配置不进入最终包 |
| 十二轮真实对话 | 8046/gemini-3.7-flash，Core 记忆；一次完整十二轮均成功。正确工作目录重跑第十轮出现一次角色处理失败，保留失败记录，停止重开后可继续。角色选择不回应的静默轮不计作故障 |
| 保存与线路 | 连续对话后完整节点保存、原线重开、分叉启动、记忆重建、分叉后的非空长期召回通过 |
| 前端与授权 | 分叉游戏社区 iframe、官方默认模板实际渲染；授权启动为 trusted，运行中撤销回 sandbox，通过 |

这里的本机 PATH 隔离并非干净虚拟机；没有隐藏、卸载本机全部开发依赖。离线标志只用于模型资产；真实模型服务仍可访问。

原生目录选择器已确认能打开，但自动化未完成正确目录选取；成功载入测试使用同一 Launcher IPC 路径，不能声称目录选择器全流程已通过。

原生启动器证据：`.tmp/portable-native-release/`（running/community/default.png 等）；最终冒烟：`.tmp/portable-final-smoke/data/`；连续试玩及分叉：`.tmp/portable-continuous/data3/continuous-result.json`。这些本机证据和其中的令牌/实例均不随包分发。

## 4. 尚待发布门禁

1. 没有可用的 Windows Sandbox / 新机器，本轮未完成普通用户干净 Windows x64 验收。随包提供干净系统验收清单；需外部环境执行。
2. 尚未完成至少 30 分钟、至少 30 次操作的长时稳定性门禁。十二轮与分叉的验证不能替代此项；后台整理高水位、资源长期增长未充分验收。
3. 真实模型有间歇性角色处理失败。连接测试成功只证明接口响应；JSON 遵循、角色表现质量与失败恢复仍需候选版试玩关注。本轮没有为它增添提示词/语义防御层。
4. 默认前端某些交互仍显示机器 ID（如 base:hold-hand、entity:brass-key）；应后续补齐玩家标签，这不影响机器身份和规则裁定。未在冻结候选过程中扩大为运行时重构。
5. 没有代码签名、自动更新、跨版本存档迁移保证。故事线分享尚未实现。

## 5. 许可与构建

随包保留 Node、Python 依赖、WebView2 发行包原有许可资料；Node bundle 依赖与 Windows 目标 Rust 包有清单，Rust 包包含构建依赖。此收集不等于完整法律审核。

构建与素材来源见 [构建说明](../../../scripts/release/BUILD.md)。主要上游依据：[WebView2 分发](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution)、[uv Python 发行说明](https://docs.astral.sh/uv/concepts/python-versions/)、[固定 ONNX 模型资产](https://huggingface.co/Xenova/multilingual-e5-small/tree/761b726dd34fb83930e26aab4e9ac3899aa1fa78)。

补充依赖验收：随包本地部署 MSVC 14.50.35710 x64 CRT，已实际编码并验证 MSVCP140、VCRUNTIME140、VCRUNTIME140_1 从随包 Python 目录加载。依据 [ONNX 安装要求](https://onnxruntime.ai/docs/install/) 与 [Microsoft 本地部署说明](https://learn.microsoft.com/en-us/cpp/windows/redistributing-visual-cpp-files?view=msvc-170)。许可原文随包提供。

最终归档：9417 个文件全部通过 CRC 校验；ZIP 518720124 字节；SHA-256：`eaa0669fbc25c7bd762090177f9307a542607e8bd2383ed77c6f16ca13daf7a2`。归档排除验收期间产生的 Python 字节码缓存。
