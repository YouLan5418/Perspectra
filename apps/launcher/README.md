# Perspectra Launcher

Tauri 2 + Vue 3 本机启动器。当前已接通仓库现有真实 Core：v5 目录载入、独立实例、OpenAI 兼容模型、Core 记忆、系统浏览器游戏页、停止与继续。历史分叉及分享暂时禁用。

在仓库根目录运行：

```powershell
corepack pnpm@11.7.0 launcher:desktop
corepack pnpm@11.7.0 launcher:check
corepack pnpm@11.7.0 --filter @perspectra/launcher tauri build --debug --no-bundle
```

本机需要 Node 24、仓库依赖、Rust/Cargo，以及 [Core 记忆环境](../../experiments/activity-memory/README.md) 的 Python/E5。当前 exe 只面向本源码工作区，尚未打包这些依赖。

首次从“载入游戏包”选择含 worldpack.source.json 的 v5 目录。默认接口 http://127.0.0.1:8046/v1/chat/completions，模型 gemini-3.7-flash。设置中的 API Key 仅在本次会话保留。数据目录在设置中显示；每个实例独立保存。关闭 Launcher 会停止运行中的 Core。

`launcher:dev` 是浏览器 Mock 展示，不能启动真实 Core。

- [首轮真实接入与验收](../../docs/current/launcher-core-integration.md)
- [第一阶段 Mock 交付说明](../../docs/current/launcher-v1.md)
- [第一阶段原生验证](../../docs/current/launcher-v1-validation.md)
