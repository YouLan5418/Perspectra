# 用命令行校验游戏包

例如你让同行者拿起钥匙并交给另一角色，先检查源包文件和引用，再在 Launcher 中载入完整源目录，实际试玩拿取和转交。

在 PowerShell 中运行以下命令。`worldpack.cmd` 使用本包的 Node，无需另外安装 Node、pnpm 或源码。程序目录、游戏包目录可以包含中文和空格；相对路径按你当前终端目录解析。

```powershell
& 'D:\Perspectra\worldpack.cmd' --version
& 'D:\Perspectra\worldpack.cmd' --help
& 'D:\Perspectra\worldpack.cmd' validate 'D:\我的游戏'
& 'D:\Perspectra\worldpack.cmd' test 'D:\我的游戏'
& 'D:\Perspectra\worldpack.cmd' compile 'D:\我的游戏' --out 'D:\编译结果\my-world.worldpack.json'
& 'D:\Perspectra\worldpack.cmd' inspect 'D:\编译结果\my-world.worldpack.json'
& 'D:\Perspectra\worldpack.cmd' preset validate 'D:\预设\自然互动.json'
& 'D:\Perspectra\worldpack.cmd' preset validate 'D:\我的游戏\model-preset.json' --pack
& 'D:\Perspectra\worldpack.cmd' editor records 'D:\我的游戏'
& 'D:\Perspectra\worldpack.cmd' simulate 'D:\我的游戏' '深夜厨房.json'
```

把示例路径替换为实际解压目录和作品目录。当前程序发行包不附带试玩包；作品源目录需另行准备。

游戏运行时，在启动器点「打开创作者页面」。直接运行工具包的试玩宿主时，把本机试玩地址中的 `/#token=` 改为 `/creator/#token=`，保留原端口和令牌，在本机打开。「状态」可查组合后的操作容量和玩家最近一次候选，「世界总览」可查最近一次剧情节奏判定。带令牌的地址仅供本机作者使用。

## 确认创作资源与程序属于同一构建

例如要制作夜间身份保密的活动，除了确认 v5 格式，还要确认目标宿主能把完整活动状态交给调度、把玩家自己的 private 交给前端。这些是宿主能力，不由源格式或编译器版本单独决定。优先使用本程序目录随附的 Skill；复制新 Skill 不会升级旧程序。

以目标程序的 `--version`、`--help` 和本机验收结果为准。完整发行包还可核对 build-info.json 的 sourceCommit、sourceDirty、buildTime。相同源格式和编译器版本可以对应不同宿主构建。

默认舞台不点名正在回复的角色，但公共 PlayerView.responders 仍可包含场内处理者，活动 revision 也可暴露操作次数。角色之间的信息隔离与对玩家隐藏调度信息是不同目标，当前不能宣称后者已实现。

## 命令与验收范围

| 命令 | 实际检查或输出 |
| --- | --- |
| `--version` | 程序版本、源格式版本、编译格式版本、编译器版本与限制配置名称 |
| `--help` | JSON 帮助及验证边界 |
| `validate <dir>` | 编译 v5 源包，检查引用、插件组合、共同玩法脚本、官方状态定义合并后的字段及操作数、绑定的前端。成功返回 `status: valid` |
| `test <dir>` | 编译并适配为运行时世界定义；`assertionsExecuted: 0`，不执行声明断言或调用模型 |
| `compile <dir> --out <file>` | 写入不可变编译结果；它不能取代 Launcher 所需的完整源目录 |
| `inspect <file>` | 校验编译结果完整性并输出概要 |
| `preset validate <file>` | 复用原生预设库导入校验，接受命名交换格式或裸预设；检查字段、启用节点宏与正则语法 |
| `preset validate <file> --pack` | 只接受作品根部 model-preset.json 使用的裸预设，不接受预设库交换封装 |
| `activate <file> --data-dir <dir>` | 高级调试：在指定目录初始化本地数据库，不启动游戏宿主；请使用全新实验目录 |
| `editor records <dir>` | 读取作者可编辑的世界包记录 |
| `simulate <dir> <脚本.json>` | 用真实宿主运行时加桩模型跑推演脚本，证明规则、触发和状态变化，不证明角色表现；没通过时退出码为 2，结果仍在标准输出 |
| `editor serve [dir] [--no-open]` | 在系统浏览器打开本机包编辑器 |

成功退出码为 0，标准输出是一行 JSON。请求或装载出错时退出码为 1，标准错误给出 ErrorEnvelope JSON；推演已执行而未通过时退出码为 2，结果在标准输出；包契约错误的 `details.diagnostics` 包含 `code`、`file`、`jsonPointer`、`message`，部分有 `suggestion`。普通命令用法错误使用 `INVALID_REQUEST`。PowerShell 用 `$LASTEXITCODE` 读取退出码；AI Skill 应同时核对退出码和 JSON。

对声明了共同玩法脚本的包，`validate` 会加载定义并检查契约。活动开场、操作触发、规则提交以及谁收到消息，要用 `simulate` 在新档里验证。想核对角色自然回应和画面，再在 Launcher 中打开完整源目录，建立新实例并实际游玩。酒馆原卡里的脚本先静态阅读，按作品需要重写。

外部 AI 可以直接按 skill 写源包，用 `validate` 修正诊断，用 `test` 检查编译适配，再推演作品的关键分支。预设用 `preset validate` 单独检查格式。交接时说明哪份是作者草稿、哪份是可玩源目录，以及哪些路线已经验证。

程序附带的 [perspectra-creator Skill](skills/perspectra-creator/SKILL.md) 提供空白源包脚手架、人物与私有知识写法、物品规则模板，已整合原 tavern-to-perspectra 的静态提取、容量分析、迁移和验收流程，还附带原生预设创作指南及两种模板。酒馆卡提取使用随包 Node 脚本；原脚本、EJS 和正则保留为数据，所需行为由 AI 按当前规则重写，不自动运行原卡，也不是兼容器。工具不需要 pnpm、源码或 Python。安装整个 Skill 目录到所用 AI 工具后，提供本程序解压路径及创作需求即可；作品输出到自己的新目录。

按任务阅读 skill 内的[直接写包和交接编辑器](skills/perspectra-creator/references/editor-handoff.md)、[源包与人物](skills/perspectra-creator/references/world-pack.md)、[玩法扩展](skills/perspectra-creator/references/gameplay.md)和[酒馆卡迁移](skills/perspectra-creator/references/tavern.md)。这些参考随 skill 一起分发。

### 把已经玩过的片段交给写作者

桌面 Launcher 的故事线页面提供「导出最近游玩片段」。命令行使用同一个导出器。可从 Launcher 数据位置设置打开实例目录，实例子目录名就是实例 ID。第一个参数是含 `launcher.json` 的 Launcher 数据目录；输出选该目录外尚不存在的文件。下例的目录和 UUID 请换成自己的。

```powershell
& 'D:\Perspectra\worldpack.cmd' excerpt --help
& 'D:\Perspectra\worldpack.cmd' excerpt 'D:\游戏数据' '11111111-1111-4111-8111-111111111111' --out 'D:\写作\最近片段.md'
& 'D:\Perspectra\worldpack.cmd' excerpt 'D:\游戏数据' '11111111-1111-4111-8111-111111111111' --rounds 3 --perspective world --out 'D:\写作\三回合.json'
```

默认取最近 20 个有记录的玩家回合和玩家视角。用 `--from-node <节点UUID>` 可从当前线某个可追溯节点保存后起算，与 `--rounds` 二选一。显式选择 `world` 会加上世界事件的提交序号与数量。阅读时请区分当场获知、后来收到的转述和实际行动结果。导出后由玩家决定交给谁，游戏不会向模型发送片段。
