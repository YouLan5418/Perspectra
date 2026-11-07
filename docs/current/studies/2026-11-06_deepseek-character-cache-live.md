# DeepSeek 官方直连：角色长历史缓存对照

DeepSeek 与 GPT 作为两名游戏角色，轮流读取各自的长历史并回答回忆提问。此次使用用户环境变量中的 Key 直连 DeepSeek 官方，两人都能连续命中：历史自然增长、没有拆分消息时，全部预热后请求均有缓存读取，加权读取占输入 90.23%。本轮实验分块版为 83.03%，不据此推动生产分块。

## 连接、数据与边界

- 用户明确授权把上一轮含角色私有观察和人设的同一份长历史发送至 `https://api.deepseek.com`，最多 48 次缓存对照；实际完成 32 次原布局和 16 次分块，没有追加其他模型调用。
- 只从用户级 `DEEPSEEK_API_KEY` 读取凭证，传入临时子进程内存；不改用户环境变量，不把 Key 写进命令参数、模型消息、配置或日志。只读模型列表 GET 成功，确认选择 `deepseek-flash`，官方显示名为 DeepSeek-V4.1-Flash。
- 请求直达 `https://api.deepseek.com/chat/completions`，不经过 3495 网关。模型、端点在实验脚本的 `--deepseek` 分支固定，不接受任意外部目的地。生产角色 Provider、官方网关兼容工具 Schema、SDK 用量逻辑均沿用原实现。
- 历史来自 `.tmp/pacing-compare-glm2/on-1/world.sqlite`，与[Go/GLM 长历史实验](2026-11-06_glm53flash-character-cache-live.md#真实存档长历史复测)使用相同 seq 1057、1103、1281、1359。DeepSeek 的授权观察与自发表达合计 157、164、191、206 条，GPT 为 120、123、151、163 条。
- 原布局输入实际为 29544～49404 token，分块版为 29577～49437 token；不同模型分词与工具编码不同，不假设与 GLM 的 token 数相等。
- 输出上限 512、思考关闭、45 秒超时、间隔 1.5 秒，不重试；模型输出不回填历史，不执行行动，不提交世界事实。数据提取为只读，没有恢复完整游戏现场、原始 Core 摘要或当时截断窗口，因此仍属于授权历史回放。

## 结果

预热后口径是排除每个角色第一次请求，再用缓存读取 token 总和除以输入 token 总和。包含冷调用的比例另外列出；两者均不是费用节省比例。

| 布局 | 策略 | 顺序 | 请求数 | 预热后有读取 / 请求数 | 全部输入 / 缓存读取 | 预热后读取占比 | 含冷调用读取占比 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 原布局，自然增长 | passive | 连续 | 8 | 6 / 6 | 305532 / 217216 | 90.23% | 71.09% |
| 原布局，自然增长 | deepseek-user | 交替 | 8 | 6 / 6 | 305532 / 215552 | 90.23% | 70.55% |
| 原布局，自然增长 | passive | 交替 | 8 | 6 / 6 | 305532 / 219392 | 90.23% | 71.81% |
| 原布局，自然增长 | deepseek-user | 连续 | 8 | 6 / 6 | 305532 / 215552 | 90.23% | 70.55% |
| 实验分块，自然增长 | passive | 交替 | 8 | 6 / 6 | 305796 / 201856 | 83.03% | 66.01% |
| 实验分块，自然增长 | deepseek-user | 交替 | 8 | 6 / 6 | 305796 / 198528 | 83.03% | 64.92% |

原布局中，DeepSeek 角色的第 2～4 次请求分别读取 36992、38272、44800 token；GPT 分别读取 29440、30208、35840。四组的预热后读数相同，连续与交替没有观察到差异，显式隔离标识也没有提高这份输入的预热后读取比例。

分块中，DeepSeek 三次均读取 36864，GPT 三次均读取 29312。该实验布局冻结最早 157 / 120 条历史在首条 user 消息中，新增经历仍位于动态尾部；读数仅覆盖固定的较早前缀。原布局能复用逐步增长的更长前缀，因此此次分块比例较低。这个观察针对当前实验的具体布局，不表示任何合理分块都会更差。

## 角色标识与用量

`deepseek-user` 使用生产适配器在请求体发送 `user_id`。本次三个显式组的同组同角色 UUID 均保持一致，A/B 不同，且不进入模型消息；每名角色首次请求均读取 0。被动组部分首次请求读取 1664 或 1920 token，说明公共前缀可能已经被同账号的其他请求预热，故主要比较排除了首次请求的口径。

DeepSeek 官方将 `user_id` 定义为 KVCache 与调度等隔离用途，位置为 Chat 请求体顶层，见[隔离说明](https://api-docs.deepseek.com/quick_start/rate_limit/)。缓存默认开启，实际命中受已持久化前缀单元等条件影响，见[缓存说明](https://api-docs.deepseek.com/guides/kv_cache/)。本次没有创建客户端管理的缓存对象，也没有把标识当作驻留保证。

48 次均为 HTTP 200，48 次均通过实际工具 Schema 校验，没有 `segments` 字符串错误。SDK 总输入与 `prompt_tokens` 一致，SDK 读取与 `prompt_tokens_details.cached_tokens`、`prompt_cache_hit_tokens` 一致，SDK 非缓存输入与 `prompt_cache_miss_tokens` 一致。全部 36 次预热后请求都有读取。

按原库对应角色与时间点逐条核对，48 份历史全部一致；将分块内容拼回后，与上轮 Go/GLM 的同一份授权材料也一致，只有独立实验标签不同。原世界库大小和修改时间保持不变。本轮没有测试自然互动质量、动作裁定或模型跨角色泄漏，不能把输入归属核对当作完整体验验收。

凭证核对在本地仅输出计数：本轮当时的 14 份实验产物没有包含实际 Key，见[凭证检查](../../../output/character-cache-deepseek-long-20261106/credential-audit.json)。临时认证环境在子进程结束后清除；模型用量不含实际账单金额，本轮不推算费用节省。

## 能否认定是网关问题

可以确认同一供应商下角色交替调用不必然顶掉缓存：DeepSeek 官方这次两个角色都稳定复用了各自历史，而且无需生产消息分块。原有整条 JSON 请求结构也不普遍阻碍缓存。

但这不是只改变网关的严格对照：上轮是 Magpie → OpenCode Go → GLM-5.3-Flash，本轮是直接 DeepSeek-V4.1-Flash，同时改变了服务端和模型。原布局交替的预热后读取比例从 16.09% 到 90.23%，分块显式标识组从 35.83% 到 83.03%，只能把问题范围收窄到先前那条 Go/GLM 链路。仍不能区分 Magpie 适配、Go 路由、GLM 服务端缓存机制或它们的组合。

对现有实现的决定：保留连接级供应商适配与角色固定 UUID；不因 Go/GLM 样本而强制所有供应商拆上下文。若继续定位网关，应保持同一上游账号、模型和请求内容，再只改变直连与网关路径；本轮没有额外发送这种对照请求，也未改网关配置。

## 复现与产物

同一[实验脚本](../../../tests/experiments/character-cache-live.ts)新增 `--deepseek`，固定使用已核对的官方端点与模型；原 Go 行为保持不变。下列命令会使用用户 Key 和付费模型，历史外发须在授权范围内，新目录不得复用：

```powershell
$env:PERSPECTRA_CACHE_TEST_API_KEY = [Environment]::GetEnvironmentVariable('DEEPSEEK_API_KEY', 'User')
try {
  node --import tsx tests/experiments/character-cache-live.ts output/cache-new-deepseek --deepseek --history-save=.tmp/pacing-compare-glm2/on-1
  node --import tsx tests/experiments/character-cache-live.ts output/cache-new-deepseek-split --deepseek --split-context --history-save=.tmp/pacing-compare-glm2/on-1
} finally {
  Remove-Item -LiteralPath Env:\PERSPECTRA_CACHE_TEST_API_KEY -ErrorAction SilentlyContinue
}
```

| 内容 | 产物 |
| --- | --- |
| 原布局 32 次 | [配置](../../../output/character-cache-deepseek-long-20261106/config.json)、[汇总](../../../output/character-cache-deepseek-long-20261106/summary.json)、[请求](../../../output/character-cache-deepseek-long-20261106/requests.jsonl)、[响应与用量](../../../output/character-cache-deepseek-long-20261106/samples.jsonl)、[分角色统计](../../../output/character-cache-deepseek-long-20261106/role-analysis.json) |
| 分块 16 次 | [配置](../../../output/character-cache-deepseek-split-20261106/config.json)、[汇总](../../../output/character-cache-deepseek-split-20261106/summary.json)、[请求](../../../output/character-cache-deepseek-split-20261106/requests.jsonl)、[响应与用量](../../../output/character-cache-deepseek-split-20261106/samples.jsonl) |
| 两组核对 | [全部 48 次核对](../../../output/character-cache-deepseek-long-20261106/combined-analysis.json)、[已授权实验范围](../../../output/character-cache-deepseek-plan-20261106/plan.json) |

本轮仅改实验脚本与文档，生产上下文、Launcher 配置、Key 保管和核心状态未改。类型、Lint、格式检查通过，未重跑全仓单测、Launcher 构建、原生发行包或完整玩法。文档链接检查仍有四篇旧研究文档的 103 处失效目标与 24 个非必需历史产物缺失，本轮新增链接无错误。
