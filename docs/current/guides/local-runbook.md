# 源码本机运行与检查

便携测试包玩家看 [玩家指南](player-playtest.md)，不需要安装下面的开发依赖。本页命令在仓库根目录执行。

## 安装和启动

使用 Node.js 22.19+ 或 24+、pnpm 11.7.0：

```powershell
corepack pnpm@11.7.0 install --frozen-lockfile
corepack pnpm@11.7.0 launcher:desktop
```

当前桌面入口是 Tauri，开发还需 Rust/Cargo、Windows 构建工具和 [Python/E5 记忆准备](../../../experiments/activity-memory/README.md)。`launcher:dev` 是 Mock 界面，不能用于真实 Core 验收。旧 Electron `desktop` / `desktop:release` 仍保留，但不是当前便携候选包主入口。依赖打包见 [Windows 构建说明](../../../scripts/release/BUILD.md)，源码变更不会自动更新已经冻结的 ZIP。

仅启动源码网页可用：

```powershell
$env:HCW_LOCAL_ENDPOINT = 'http://127.0.0.1:8046/v1/chat/completions'
$env:HCW_LOCAL_MODEL = 'gemini-3.7-flash'
corepack pnpm@11.7.0 experience:web --pack examples/world-packs/launcher-demo --data-dir .tmp/my-playtest
```

先启动自己的模型服务。示例配置可按实际接口修改；未设置环境变量时源码网页默认 8045，Launcher 默认 8046。认证通过进程环境 `HCW_LOCAL_API_KEY` 提供，不写入仓库。打开终端打印的完整回环地址，不公开其 token。

源码网页默认原生记忆；加 `--memory-core` 前准备 Python/E5，当前不与 Ollama/DeepSeek 模式混用。便携 Launcher 已打包 Core 运行依赖，仍需外部模型服务。[创作者试玩](creator-playtest.md) 说明两条路径的验收差异。

## 检查

```powershell
corepack pnpm@11.7.0 check
corepack pnpm@11.7.0 launcher:check
```

按改动风险运行相关检查，见 [基线](../baseline.md)。文档改动核对链接与命令即可，不要求完整测试。检查通过不证明真实角色自然度或发行环境可用性。

兼容包与相同目录可续玩；内容不匹配时新建实例/目录，保留原存档。不要写入 `D:/worlds` 历史数据。备份前停止游戏和 Launcher。
