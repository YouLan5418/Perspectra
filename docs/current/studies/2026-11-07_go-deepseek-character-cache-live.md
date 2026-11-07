# OpenCode Go 上的 DeepSeek 角色缓存对照

日期：2026-11-07。目的：区分 Go/GLM 的低命中来自模型还是 OpenCode Go 渠道。沿用[GLM-5.3-Flash 实验](2026-11-06_glm53flash-character-cache-live.md)的长历史与脚本，只把模型换成 `opencode-go/deepseek-v4.1-flash`；对照组是[DeepSeek 官方直连](2026-11-06_deepseek-character-cache-live.md)。

## 条件

- 用户指定本机 Magpie 网关 `http://127.0.0.1:3495/v1`，OpenAI 兼容 Chat Completions；模型 ID 取自网关模型列表。
- 历史来自 `.tmp/pacing-compare-glm2/on-1`，只读打开，两名角色只取各自的观察与自发表达，与前两份报告相同。
- 生产 `createRoleProviders`、官方网关工具 Schema；显式组发送 `x-opencode-session`，每组每角色一个固定 UUID。请求间隔 1.5 秒，不重试。
- 共 44 次请求：原布局自然增长 32 次、原样重复 12 次。全部 HTTP 200，全部通过工具 Schema。用量取上游原始 `cached_tokens`，与 `opencode.tokens.cache_read` 一致。

复现（会调用真实模型，须用新目录）：

~~~powershell
node --import tsx tests/experiments/character-cache-live.ts output/new-dir --history-save=.tmp/pacing-compare-glm2/on-1 --model=opencode-go/deepseek-v4.1-flash
node --import tsx tests/experiments/character-cache-live.ts output/new-dir-exact --exact-repeat --history-save=.tmp/pacing-compare-glm2/on-1 --model=opencode-go/deepseek-v4.1-flash
~~~

## 结果

| 布局 | 策略 | 顺序 | 请求数 | 预热后有读取 | 预热后读取占比 |
| --- | --- | --- | --- | --- | --- |
| 原布局，自然增长 | passive | 连续 | 8 | 1 / 6 | 15.44% |
| 原布局，自然增长 | opencode-go | 交替 | 8 | 1 / 6 | 12.60% |
| 原布局，自然增长 | passive | 交替 | 8 | 1 / 6 | 18.79% |
| 原布局，自然增长 | opencode-go | 连续 | 8 | 4 / 6 | 65.22% |
| 原样重复 | opencode-go | 连续 | 6 | 2 / 4（其一只读 2048） | 29.27% |
| 原样重复 | opencode-go | 交替 | 6 | 3 / 4 | 77.54% |

同一份长历史在 DeepSeek 官方直连上，四组原布局均为 90.23%，36 次预热后请求全部有读取。

逐条看：被动连续组的角色 A 依次读取 0、36898、0、0；显式连续原样重复组中，同一角色、同一会话 ID、逐字相同的请求依次读取 0、0、36982。命中时读取量随历史前缀增长（36898 → 38364 → 44906），说明这个模型在 Go 上能匹配消息内部的前缀，单条 JSON 布局本身不阻碍命中。

## 结论与限制

- 同一模型系列、同一请求，官方直连稳定命中，经 Go 时断时续，连逐字相同的请求也会连续未命中。低命中主要来自 Go 渠道（推断为请求分散到缓存不共享的多个后端），不是角色交替、上下文布局或角色间互相覆盖。
- `x-opencode-session` 没有把请求稳定固定到持有缓存的后端：显式组最好 65%、最差 13%，被动组 15%～19%，样本内看不出可靠收益。
- GLM 在 Go 上原样重复可达 97%，但自然增长几乎为 0；DeepSeek 在 Go 上则是前缀可匹配、但命中随机。两种模型的失败形态不同，GLM“按整条消息匹配”的推测只适用于 GLM，不能推广到整个渠道。
- 样本量小，比例不代表费用或稳定保证。上述经网关结果在下一节与直连 Go 对照。

## 直连 Go 对照

同日按用户要求绕过 Magpie，直连 `https://opencode.ai/zen/go/v1/chat/completions`，模型 `deepseek-v4.1-flash`，Key 取用户环境变量，只在实验子进程中使用、不落盘。脚本参数 `--go-direct`。

直连时不带 `x-opencode-session` 的请求被拒绝：3 次均为 HTTP 400，`MissingSessionID`，提示缺少该头无法路由。因此直连只能跑会话组；经 Magpie 的“被动组”实际是由网关代为补了会话标识，并不是真正无会话。

| 布局 | 顺序 | 请求数 | 预热后有读取 | 预热后读取占比 | 同条件经 Magpie |
| --- | --- | --- | --- | --- | --- |
| 原布局，自然增长 | 交替 | 8 | 5 / 6 | 77.50% | 12.60% |
| 原布局，自然增长 | 连续 | 8 | 5 / 6 | 77.50% | 65.22% |
| 原样重复 | 连续 | 6 | 2 / 4 | 55.46% | 29.27% |
| 原样重复 | 交替 | 6 | 3 / 4 | 71.88% | 77.54% |

另有 3 次被拒的被动请求，共 47 次直连请求；成功的 28 次全部通过工具 Schema。

- 自然增长的两组逐条读数完全相同，唯一未命中都是角色 B 第 3 次；官方直连在同一请求读取了 30208。它在两种顺序下一致出现，更像 Go 后端对这一段前缀的固定行为，而不是随机路由，原因未查明。
- 原样重复仍有未命中（连续组角色 B 三次均为 0），说明 Go 自身也存在部分路由或驻留损失，但远少于经网关时。

结论修正：经 Magpie 的大幅波动（13%～65%）主要来自本机网关这一层，直连 Go 在相同请求下稳定在 77.5% 且与调用顺序无关；剩余与官方 90.23% 的差距来自 Go 自身。没有读取 Magpie 配置，网关内部为何打乱命中（例如多账号轮换或改写会话）未核实。

生产影响：当前 `auto` 对 opencode.ai 的 Go 路径解析为 `opencode-go`，会发送会话头，不受影响；若玩家对直连 Go 手动选“不主动优化”，每次角色请求都会 400。已修复：官方 Go 地址只接受自动或 OpenCode Go 会话，其他选择在保存时报错；Launcher 连接测试与意图调用也补上会话头。
