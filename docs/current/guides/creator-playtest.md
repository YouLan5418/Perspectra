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

当前实验默认走本机 OpenAI 兼容接口 `http://127.0.0.1:8045/v1/chat/completions`，模型 `gemini-3.7-flash`。先确认本机服务已启动，再用新的数据目录运行：

```powershell
corepack pnpm@11.7.0 experience:web --pack examples/world-packs/ai-girls-awaken-v10 --data-dir .tmp/my-gemini-playtest
```

认证要求由本机服务配置决定；需要密钥时只在启动进程中设置 `HCW_LOCAL_API_KEY`，不要写入 Pack、脚本或仓库。可用 `HCW_LOCAL_ENDPOINT`、`HCW_LOCAL_MODEL` 覆盖本机接口和模型标识。`experience:web:flash` 与上面的默认命令使用同一模型。

如需对照本机 Ollama，可显式选择：

```powershell
corepack pnpm@11.7.0 experience:web --ollama --pack examples/world-packs/ai-girls-awaken-v10 --data-dir .tmp/my-ollama-playtest
```

打开终端打印的完整本机地址，包含 `#token=` 部分。网页只监听 `127.0.0.1`。`--pack` 和 `--data-dir` 指定世界源与新存档；`HCW_PLAYTEST_PACK` 和 `HCW_PLAYTEST_DATA_DIRECTORY` 也可指定路径。没有有效 v5 源目录时，启动会明确失败。历史 DeepSeek 试玩结果不能和新模型结果直接合并为同一组结论。

## 可选：简化Core记忆

正常网页默认沿用原生记忆。启用极简Delivery实验时，先按[当前记忆实验入口](../../../experiments/activity-memory/README.md)准备Python与E5环境，再使用新的数据目录：

```powershell
# 本次网关端口8046，默认接口端口仍为8045；按本机服务调整
$env:HCW_LOCAL_ENDPOINT = 'http://127.0.0.1:8046/v1/chat/completions'
corepack pnpm@11.7.0 experience:web --memory-core --pack examples/world-packs/prototype-g1 --data-dir .tmp/my-simple-core-web
```

宿主按钮“整理长期记忆”手动处理各角色授权Source；首次整理前长期交付为空，近期上下文正常。当前整理在后台执行，排队前冻结授权来源，普通输入继续；宿主可取消，失败保留原档案和新经历。Core模式使用简单候选准入和极简交付，关闭重复的原生检索与主动recall；JEV不作为必经。当前只验收本机OpenAI兼容服务的源码网页，桌面Core资产尚未打包。

## 试玩与判断

先让玩家自然交谈和表达，再尝试世界包声明的物品交互与移动。观察 NPC 是否能在执行前提出行动、从裁定中获得实际结果、再自由续写；检查另一个角色是否只依据自己有权看到的结果回应。玩家输入若仅部分提交，以网页提示、转录和当前场景为准，不把模型服务失败误当成玩家表达不清。

试玩证据保存在 `--data-dir` 指定的目录。再次启动同一个 Pack 与目录可以续玩；切换不兼容 Pack 时改用新目录。当前 G3 已知风险是自由叙述有时会宣告未经规则提交的状态变化；这类文本不改变 Event Log 中的物品归属或位置，也不应被当成 G3 已通过。相关验收状态见 [G1/G2](../../archive/prototype-g1-g4/PROTOTYPE-G1-G2-ACCEPTANCE.md) 和 [G3 试玩](../../archive/prototype-g1-g4/PROTOTYPE-G3-PLAYTEST-01.md)。
