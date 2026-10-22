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

想看物品在谁手里、某角色收到了什么、模型实际请求了什么：游戏运行时在 Launcher 点“打开创作者页面”（当前源码），系统浏览器会打开只读的创作者页面，可查看对话、行动轨迹、位置与物品、状态、活动私有状态、实际模型请求和 Core 记忆。实际请求需要先在页面里开启采集。接口与字段见[创作者调试接口](../creator-debug-api.md)。test3 没有这个页面。

## 3. 用源码网页测试

模型地址、标识由自己的服务决定，以下 8046 是本机验证示例，不是内置服务：

```powershell
$env:HCW_LOCAL_ENDPOINT = 'http://127.0.0.1:8046/v1/chat/completions'
$env:HCW_LOCAL_MODEL = 'gemini-3.7-flash'
corepack pnpm@11.7.0 experience:web --pack examples/world-packs/launcher-demo --data-dir .tmp/my-creator-playtest
```

需要认证时仅在当前进程设置 `HCW_LOCAL_API_KEY`。打开终端打印的完整回环地址；其中 token 不对外分享。未设置环境变量时源码网页默认地址为 8045；Launcher 默认配置为 8046，两者不是同一配置来源。

源码网页默认使用 Core 记忆，与 Launcher 一致；先按 [记忆实验说明](../../../experiments/activity-memory/README.md) 准备 Python/E5，缺少时启动直接报错。Core 用于 local 配置入口，`--ollama` / `--deepseek` 必须同时加 `--memory-native`。原生记忆只取最近 16 条观察的滑动窗口，结果不代表玩家体验，不把不同模型和记忆路径混为同一验收结果。

### 物品规则调试（2026-10-22，当前源码）

例如在有钥匙和同伴的包里，先拿起钥匙，再选“把钥匙交给”，通过“交给谁”填写接收者；创作者页面应看到对应转移，授权目击者也应知道新持有人。拿／放／给使用各包 `scripts/status.js` 中的[作者模板](../../../examples/templates/item-rules.js)，不再是宿主内置规则。复制样例后先核对顶部 `ITEM_RULES`、操作的 targets、policy 和 resolve，以及活动／自主许可是否引用 `status:take`／`status:drop`／`status:give`。

`/take`、`/give`、`/drop` 已删除。通过源码宿主的调试提交入口，可用以下命令核对同一套作者规则；物品 ID、接收者 ID 和操作名须在当前包里存在，参数和实时条件照常校验：

```text
/status take@entity:brass-key {}
/status give@entity:brass-key {"recipientId":"character:companion"}
```

放下也使用 `/status drop@entity:brass-key {}`，应在行动者仍持有该物品时单独测试。默认舞台玩家使用选项和表单，无须输入命令。规则详细接口见[活动与状态](activity-and-variables.md#对物品做的操作2026-10-22当前源码)。

分别检查“条件不满足时隐藏目标”和“已失效／伪造请求执行时被拒绝”，再检查物品去向、目击者观察和台词是否一致。已有自动测试场景与此次 DeepSeek 两个真实样本见[验证范围](activity-and-variables.md#作者物品规则的验证范围)；本次文档同步未重跑测试或模型。《赔罪晚宴》A 路线只提供自选做菜、作者理由拒绝修理的样本；hidden-cure-next D2 竞争者交出摘要时选了玩家而非伊蕾，不能据此判定接收对象选择已通过。

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

记录包版本、模型、记忆路径、前端模式、步骤及脱敏结果。存档含私密角色信息，原始模型请求不可公开。短冒烟不等于长历史或干净系统发行验收；当前证据与未完成项见 [test3 构建记录](../studies/launcher-portable-test3-20261009.md) 和[项目状态](../PROJECT-STATE.md)。
