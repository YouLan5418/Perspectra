# 创作者：从包校验到真实试玩

先看 [v5 创作指南](world-pack-authoring.md)。当前 Launcher/网页仅接受 v5 源目录，不自动回退到旧格式。每个新世界或不兼容内容修改使用新实例/新数据目录；`D:/worlds` 历史数据只读。

## 1. 校验与断言计划

源码工具需要 Node.js 22.19+ 或 24+ 和 pnpm 11.7.0。在仓库根目录执行：

```powershell
corepack pnpm@11.7.0 install --frozen-lockfile
corepack pnpm@11.7.0 worldpack validate examples/world-packs/launcher-demo
corepack pnpm@11.7.0 worldpack test examples/world-packs/launcher-demo
```

修改自己的包时替换目录。`worldpack test` 当前只编译断言计划，报告为 `status: compiled`、`assertionsExecuted: 0`，并未执行断言。命令成功不能视为功能测试或真实角色表现验收。当前没有 `worldpack init`；从已有 v5 样例完整复制开始。

## 2. 用 Launcher 测试

按 [玩家指南](player-playtest.md) 配置模型、加载源目录、创建实例并启动。Launcher 使用 Core 记忆，游戏在系统浏览器打开，便携候选包已包含运行依赖。源码 Launcher 的 Python/E5 与构建准备见 [本机运行](local-runbook.md)。

优先验证官方界面，再测试社区前端和授权；修改包内容后重新校验并创建新实例，不复用不匹配的旧数据。验证角色/组预设、活动和故事线时按玩家指南操作，不把后台日志接口当成社区可用 API。

## 3. 用源码网页测试

模型地址、标识由自己的服务决定，以下 8046 是本机验证示例，不是内置服务：

```powershell
$env:HCW_LOCAL_ENDPOINT = 'http://127.0.0.1:8046/v1/chat/completions'
$env:HCW_LOCAL_MODEL = 'gemini-3.7-flash'
corepack pnpm@11.7.0 experience:web --pack examples/world-packs/launcher-demo --data-dir .tmp/my-creator-playtest
```

需要认证时仅在当前进程设置 `HCW_LOCAL_API_KEY`。打开终端打印的完整回环地址；其中 token 不对外分享。未设置环境变量时源码网页默认地址为 8045；Launcher 默认配置为 8046，两者不是同一配置来源。

源码网页默认原生记忆。按 [记忆实验说明](../../../experiments/activity-memory/README.md) 准备 Python/E5 后，可在上述命令加 `--memory-core`；当前该路径用于本机 OpenAI 兼容服务，不与 `--ollama` / `--deepseek` 混用。可单独加 `--ollama` 作原生记忆对照，不把不同模型和记忆路径混为同一验收结果。

## 4. 最小真实验收清单

| 模块 | 观察重点 |
| --- | --- |
| 角色 | 自然回应、主动性与沉默是否合理，不只检查能否输出 JSON |
| 认知 | 同场观察、私下告知和未知信息是否分开；离场角色不能自动知道新秘密 |
| 世界状态 | 给物品、移动等合法操作提交正确；非法操作拒绝，台词不应让其他角色相信未提交变化 |
| 记忆 | 多轮以后能否合理召回；整理失败/取消是否仍可继续游玩 |
| 活动 | 开始、操作、轮转、退出、角色失败后的重试与逃生；检查秘密是否写进公开材料 |
| 预设 | 全局/包/实例及角色组、专属优先级，取消与保存、重新启动后的实际输出 |
| 故事线 | 闲时保存、忙时拒绝、停止后分叉、新线恢复与原线继续；未来秘密不进入过去节点 |
| 前端 | 官方与社区界面完成同一操作，默认沙箱、确认受信任、撤销后回退与进度保留 |

先自由交谈，再尝试声明的物品交互和移动。服务失败可能只完成玩家提交，以公开转录和当前场景判断，不把错误当成玩家表意不清。程序权限与自由文本语义一致性分别验证；数据库未被修改不能证明叙事绕过已经解决。

记录包版本、模型、记忆路径、前端模式、步骤及脱敏结果。存档含私密角色信息，原始模型请求不可公开。短冒烟不等于长历史或干净系统发行验收；当前证据与未完成项见 [候选包验收](../studies/launcher-portable-release-20261007.md)。
