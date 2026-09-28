# 《一觉醒来，我的大模型们都变成了美少女》v10 试玩

这是原 `ai-girls-awaken`（`worldpack-source/v4`，packVersion 1.0.0）的 v5 重写版本，当前 **packVersion 2.1.0**。

⚠️ 旧目录 `examples/world-packs/ai-girls-awaken/` 只是历史留档，不要覆盖，也不要指望能跑：本工作树的运行时只接受 `worldpack-source/v5` 源（`packages/world-pack/src/contracts.ts:38` 是唯一存在的 source 版本常量），v4 目录不会被加载。

```powershell
$env:HCW_LOCAL_API_KEY = [Environment]::GetEnvironmentVariable('ANTIGRAVITY_TOOLS_KEY', 'User')
corepack pnpm@11.7.0 experience:web --pack examples\world-packs\ai-girls-awaken-v10 --data-dir .tmp\ai-girls-gemini-playtest
```

普通中文作为对白提交；移动、保管、转交、牵手等受控状态变化使用 `/act` 显式命令。Pack 启用了 Manifest v10、`submit_actions/v7`、`responsive/v2` 和基础交互包。

## 可玩面（2.1.0 扩展后）

| 维度 | 内容 |
|---|---|
| 地点 | 4 个：卧室 / 客厅 / 工作区（电脑桌）/ 厨房 |
| 可交互物品 | 8 件，全部支持拿起 / 放下 / 递交（`base:take` / `base:drop` / `base:give`） |
| 物品分布 | 卧室：手机、充电器；客厅：遥控器、抱枕；工作区：笔记本、键盘、马克杯；厨房：水壶 |
| 可牵手对象 | GPT / Claude / DeepSeek / GLM，并可解除（`base:hold-hand` / `base:end-contact`） |
| 场景 | `scene:morning-bedroom` 为初始 active（5 人同处），其余三地为 `created` 占位 |

## 不打开浏览器的真实模型冒烟测试

```powershell
node --import tsx tests/experiments/frozen-playtest-drive.ts --model gemini-3.7-flash --pack examples/world-packs/ai-girls-awaken-v10 --scenario ai-girls-commands --turns 20
```

`--scenario ai-girls-commands` 自带一段 20 轮的中文输入与显式命令脚本，覆盖四个地点的移动、物品的拿放递交、牵手的建立与解除，以及一次「只对 Claude 说、再问 GPT 有没有听见」的信息隔离探针；收件人不在场时是否送达，要以观察事件为准。`--turns N` 可截断。

数据目录里除 `outcome.json` 外还会落 `provider.jsonl`：每行是一条真实的 provider 请求/响应（`messages` + `tools`），用于角色可见上下文的审计与 token 计量；不含 header 与密钥。

每次修改 Pack 内容都应提高 `packVersion` 并使用新的数据目录。
