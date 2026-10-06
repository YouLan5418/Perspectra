# 当前本机运行

在仓库根目录使用 Node.js 22.19+ 或 24+、pnpm 11.7.0。先启动本机模型服务，再用新数据目录试玩：

```powershell
corepack pnpm@11.7.0 install --frozen-lockfile
corepack pnpm@11.7.0 experience:web --pack examples/world-packs/ai-girls-awaken-v10 --data-dir .tmp/my-playtest
```

默认本机 OpenAI 兼容地址为 `http://127.0.0.1:8045/v1/chat/completions`，模型别名 `gemini-3.7-flash`。用 `HCW_LOCAL_ENDPOINT` / `HCW_LOCAL_MODEL` 覆盖；密钥只通过运行进程环境 `HCW_LOCAL_API_KEY` 提供。打开终端打印的带 `#token=` 完整回环地址。

Ollama 对照可加 `--ollama`。显式 `--memory-core` 的 Python/E5 准备与限制见[实验入口](../../../experiments/activity-memory/README.md)，目前只支持本机 OpenAI 兼容服务的源码网页，不与 Ollama/DeepSeek 同用。

桌面开发启动用 `corepack pnpm@11.7.0 desktop`；Windows 打包用 `corepack pnpm@11.7.0 desktop:release`。桌面 Core 资产尚未打包，源码变化不等于发行包已更新。

同一兼容 Pack 和数据目录可续玩；不兼容 Pack 使用新目录，不修改 `D:/worlds` 历史数据。更多步骤见[试玩指南](creator-playtest.md)。

```powershell
corepack pnpm@11.7.0 check
```

这是类型、Lint 与默认原型测试的轻量检查，不含旧 100% 覆盖率及硬崩溃矩阵。按风险追加相关验证，见[基线](../baseline.md)。检查通过不证明真实角色体验通过。
