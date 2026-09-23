# 当前原型的世界包与真实模型试玩

网页试玩目前只接受 `worldpack-source/v5` 源目录。入口会用当前 Host 安装的交互包编译该目录，然后通过 `FrozenWorldPlaytestRuntime` 运行。旧编译制品和 v1–v4 源目录不会自动回退到旧运行时；历史试玩记录保留在其他报告中。

## 准备

在仓库根目录使用 Node.js 22.19+ 或 24+ 和锁定的 pnpm。仓库自带可运行的 v5 样例：`examples/world-packs/ai-girls-awaken-v10`，较小的原型场景在 `examples/world-packs/prototype-g1`。修改自己的世界时，复制整个 v5 源目录并保持 `worldpack.source.json` 中的文件引用有效。可先运行：

```powershell
corepack pnpm@11.7.0 worldpack validate examples/world-packs/ai-girls-awaken-v10
corepack pnpm@11.7.0 worldpack test examples/world-packs/ai-girls-awaken-v10
```

`worldpack test` 检查世界包声明；角色的连续互动仍须用真实模型试玩观察。每个新世界或不兼容的 Pack 修改使用独立数据目录，不要覆盖旧存档。`D:\worlds` 中的历史试玩数据可作只读证据。

## 启动本机网页

DeepSeek 的 API Key 从当前进程的 `DEEPSEEK_API_KEY` 环境变量读取，切勿写入 Pack 或命令文件。如果 Key 仅设置在 Windows 用户环境变量中，而当前终端尚未继承，可在**当前 PowerShell 进程**中读取：

```powershell
$env:DEEPSEEK_API_KEY = [Environment]::GetEnvironmentVariable('DEEPSEEK_API_KEY', 'User')
corepack pnpm@11.7.0 experience:web:flash --pack examples/world-packs/ai-girls-awaken-v10 --data-dir .tmp/my-v5-playtest
```

也可以用本机 Ollama：

```powershell
corepack pnpm@11.7.0 experience:web --pack examples/world-packs/ai-girls-awaken-v10 --data-dir .tmp/my-ollama-playtest
```

打开终端打印的完整本机地址，包含 `#token=` 部分。网页只监听 `127.0.0.1`。DeepSeek 模型默认是 `deepseek-flash`，可由 `HCW_DEEPSEEK_MODEL` 覆盖；Ollama 模型可由 `HCW_OLLAMA_MODEL` 覆盖，本机地址可由 `HCW_OLLAMA_ENDPOINT` 覆盖。网页命令只接受 `--deepseek`、`--pack`、`--data-dir`；`HCW_PLAYTEST_PACK` 和 `HCW_PLAYTEST_DATA_DIRECTORY` 也可指定路径。没有有效 v5 源目录时，启动会明确失败。

## 试玩与判断

先让玩家自然交谈和表达，再尝试世界包声明的物品交互与移动。观察 NPC 是否能在执行前提出行动、从裁定中获得实际结果、再自由续写；检查另一个角色是否只依据自己有权看到的结果回应。玩家输入若仅部分提交，以网页提示、转录和当前场景为准，不把模型服务失败误当成玩家表达不清。

试玩证据保存在 `--data-dir` 指定的目录。再次启动同一个 Pack 与目录可以续玩；切换不兼容 Pack 时改用新目录。当前 G3 已知风险是自由叙述有时会宣告未经规则提交的状态变化；这类文本不改变 Event Log 中的物品归属或位置，也不应被当成 G3 已通过。相关验收状态见 [G1/G2](PROTOTYPE-G1-G2-ACCEPTANCE.md) 和 [G3 试玩](PROTOTYPE-G3-PLAYTEST-01.md)。
