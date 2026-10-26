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
```

把示例路径替换为实际解压目录和作品目录。当前程序发行包不附带试玩包；作品源目录需另行准备。

| 命令 | 实际检查或输出 |
| --- | --- |
| `--version` | 程序版本、源格式版本、编译格式版本、编译器版本与限制配置名称 |
| `--help` | JSON 帮助及验证边界 |
| `validate <dir>` | v5 源文件结构、引用、声明资产与宿主内置交互选择；成功返回 `status: valid` |
| `test <dir>` | 编译并适配为运行时世界定义；`assertionsExecuted: 0`，不执行声明断言或调用模型 |
| `compile <dir> --out <file>` | 写入不可变编译结果；它不能取代 Launcher 所需的完整源目录 |
| `inspect <file>` | 校验编译结果完整性并输出概要 |
| `preset validate <file>` | 复用原生预设库导入校验，接受命名交换格式或裸预设；检查字段、启用节点宏与正则语法 |
| `preset validate <file> --pack` | 只接受作品根部 model-preset.json 使用的裸预设，不接受预设库交换封装 |
| `activate <file> --data-dir <dir>` | 高级调试：在指定目录初始化本地数据库，不启动游戏宿主；请使用全新实验目录 |

成功退出码为 0，标准输出是一行 JSON。失败退出码为 1，标准错误是一行 ErrorEnvelope JSON；包契约错误的 `details.diagnostics` 包含 `code`、`file`、`jsonPointer`、`message`，部分有 `suggestion`。普通命令用法错误使用 `INVALID_REQUEST`。PowerShell 用 `$LASTEXITCODE` 读取退出码；AI Skill 应同时核对退出码和 JSON。

`validate` 和 `test` 不执行包内玩法脚本；脚本源文件作为资产读取。它们也不加载完整宿主的状态、活动、世界知识、前端及预设扩展配置，因此通过不代表这些扩展已被验证。完整源目录仍须在本版本 Launcher 中载入、新建实例并运行，验证规则结果、私密信息隔离和角色实际回应。运行自己信任的作品；酒馆原卡中的脚本应静态分析后重写，不直接执行。

创作 Skill 可以先读取 `--version` 和 `--help`，针对该版本生成源包，循环运行 `validate` 修正诊断，再运行 `test` 检查适配。预设要单独用 `preset validate`；它不执行文本匹配、不写入预设库、不调用模型，语法有效不代表风格效果或正则运行时行为通过。较早的 0.3.1 候选没有此命令，需实际检查帮助。请分别记录静态通过、宿主启动、真实模型试玩结果。CLI 不提供模板生成、酒馆自动迁移或跨版本存档迁移。

程序附带的 [perspectra-creator Skill](skills/perspectra-creator/SKILL.md) 提供空白源包脚手架、人物与私有知识写法、物品规则模板，已整合原 tavern-to-perspectra 的静态提取、容量分析、迁移和验收流程，还附带原生预设创作指南及两种模板。酒馆卡提取使用随包 Python，原脚本、EJS 和正则保留为数据，所需行为由 AI 按当前规则重写；不是自动运行原卡的兼容器。脚手架使用随包 Node，不需要 pnpm、源码或全局 Python。安装整个 Skill 目录到所用 AI 工具后，提供本程序解压路径及创作需求即可；作品输出到自己的新目录。
