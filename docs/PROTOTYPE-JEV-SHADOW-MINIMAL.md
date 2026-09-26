# Jev 最小影子模式

| 属性 | 内容 |
| --- | --- |
| 分支 | `codex/jev-shadow-minimal` |
| 起点 | `6e393aa`：main 的 `67f1b43` 加第一轮独立 Jev 实验 |
| 范围 | 网页试玩 Host；只检查显式配置物品的当前持有宣称 |
| 状态 | 已接入；自动化回归、公开合成样本及首轮 8 轮真实主模型试玩完成；长程验证未完成 |
| 旧实现 | WorkBuddy 改动完整保存在本地 stash `3df3eaecf651ee9f6a8e6f38589ab8a7bc75adc8`，包含未跟踪实验记录 |

## 1. 问题与取舍

需要测量“叙述已经宣布转移，正式事件却没有支持”的出现频率。影子模式只提供证据，不拦截发布，不重写角色表达，也不把审计结果送进 Observation、Memory 或角色 Context。

旧实现并存终态抽取与模型直接判定世界一致性两条口径，并将对白和旁白混合。当前实现替换这些运行路径：不带入关键词闸门、旁路专用 package、跨核心包提交通知、每日账本或新 Receipt。旧实验保留用于参考。

```text
正常提交 → 刷新已发布转录 → 试玩正常返回
                       └→ 只入队事件区间
                             ↓ 下一个事件循环
                          Jev 抽取文本宣称
                             ↓
                          World 正式事件重放对账
                             ↓
                          本地 JSONL 日志
```

没有修改 application、kernel、存储提交或角色协议。在整次玩家输入及其 NPC 激活完成、试玩刷新后，入队新增的事件区间；旁路按已有 transactionId 拆成真实提交。不是在每次 NPC 提交时立刻通知。失败后刷新得到的已提交内容同样可被审计。

## 2. 判定契约

1. 每条 `character.speak` 单独审计，保留事件 seq、actorId、speech、narration，不跨角色拼接。
2. 物品 ID、名称和别名由实验配置显式给出；角色候选取整个 Manifest，包括从未持有任何物品的角色。
3. Jev 接收公开名称元数据与已发布表达，不接收权威持有状态、私有认知、Memory 或角色请求上下文。对白及叙述内引用的对白允许说谎。
4. Jev 只判断文本断言了哪个当前持有者。World 使用该发布所属事务结束处的事件前缀，调用既有 `currentEntityState`，自行比较 holderId。
5. 不拿审计执行时的最新世界状态比较过去文本。日志保存事务前后 seq 和最近持有状态事件 seq，便于回查。
6. 未提及、意图、未完成尝试、纯对白不会回填“持有者没变”，也不要求角色复述正式转移。
7. 配置中显示名相同的物品保守记无法判断，不调用 Jev。此版不实现按持有人或空间消歧；共享别名等其他歧义仍依赖模型选择无法判断。

| 日志 status | 含义 |
| --- | --- |
| SUPPORTED | 客观当前持有断言与正式终态一致 |
| CONFLICT | 客观当前持有断言与正式终态不同 |
| NO_CLAIM | 没有客观当前持有断言；answer.choice 保留 SPEECH_ONLY 与 NO_CLAIM 区别 |
| UNCERTAIN | 模型无法判断，或同名配置无法区分 |
| CALL_FAILED | 请求失败、超时或响应无效；不混入无法判断 |
| AUDIT_FAILED | 事件前缀或本地对账失败 |
| QUEUE_SKIPPED | 队列满，记录被跳过的确切 seq 区间 |

保存 Jev 完整候选概率、confidence、实际模型、usage、费用和延迟。不使用固定置信度阈值。日志也保存原始已发布文本，仅留在本地数据目录。写入失败增加错误计数并提示本机终端，不让正常回合失败。

## 3. 使用

在此工作树中执行，使用新的数据目录：

```powershell
$env:DEEPSEEK_API_KEY = [Environment]::GetEnvironmentVariable('DEEPSEEK_API_KEY', 'User')
$env:OPENROUTER_JEV_KEY = [Environment]::GetEnvironmentVariable('OPENROUTER_JEV_KEY', 'User')
corepack pnpm@11.7.0 experience:web:flash --pack examples/world-packs/prototype-g1 --data-dir .tmp/jev-shadow-play --jev-shadow experiments/jev-narrative-auditor/shadow-g1.json
```

`--jev-shadow` 显式启用；不传则不创建审计、不调用 Jev。启用意味着该新实验中已发布的对白和叙述会发送到 OpenRouter，包括私密交流中已发布的文本；不发送角色内部认知。凭证仅存在于进程环境和请求 Header，不持久化。

日志位于数据目录的 `jev-shadow.jsonl`；网页 debug 中的 shadowAudit 是实时只读计数。配置是 1–8 条 `{entityId, name, aliases?}`，启动时验证物品在 Pack 中声明。为其他世界填写独立配置，不猜测 ID 的自然语言意义。

每次请求超时 5 秒，不重试主回合；串行审计，每条发布最多检查 8 件配置物品。队列最多 32 个待处理区间，溢出区间合并记跳过。正常关闭等待队列完成；进程被强制结束时允许丢弃未审计队列。重启从当前事件头开始，不重审历史数据。

## 4. 验证证据

- `corepack pnpm@11.7.0 check`：类型、Lint、81 项默认测试通过。
- `test:related tests/experiments/playtest-launch.test.ts tests/experiments/playtest-frozen-runtime.test.ts`：启动参数和现有试玩运行时相关测试。
- 新增队列回归：observe 同步返回时没有读取前缀或调用模型；关闭排空；缺失前缀、调用失败、落盘失败和溢出单独可见；未来转移不污染原事务对账。
- 实际 FrozenWorldPlaytestRuntime 的 A/B：本地主模型夹具、影子开/关。Jev 请求被挂起时试玩已返回；主模型调用次数、转录、正式事件类型一致；审计后全部正式事件字节保持不变。覆盖玩家与 NPC 发布。

真实 Jev 使用 `typesafe/jev-1.13-20260917`，只发送本次手写的公开合成样本：

| 检查 | 结果 |
| --- | --- |
| 首次 8 场景 / 9 条记录 | 9 次 Jev 调用；7/9 与人工预期一致；同名场景误报两条冲突 |
| 修正后同样 8 场景 / 9 条记录 | 7 次 Jev 调用全部符合该小样本预期；2 条同名物品由程序记无法判断 |
| 调用失败 | 两轮均 0 |
| 修正后平均调用时间 | 约 390 ms |
| 两轮总 API 费用 | $0.000666708 |

完整证据：`experiments/jev-narrative-auditor/results-shadow-minimal-2026-09-26.jsonl` 和 `results-shadow-minimal-after-2026-09-26.jsonl`。`tests/experiments/jev-shadow-smoke.ts` 可复跑；追加新结果，不代表跨模型稳定性或泛化准确率。

## 5. 接受的限制

- 只核对当前持有终态；虚构中途转交后又回到原持有人可能漏检，不验证完整转移历史、位置变化、关系或自由剧情事实。
- 只覆盖配置物品，不提供自动物品识别。名称/别名不足、代词、多义表达、模型误分类仍可能导致漏报或误报。
- SUPPORTED 只说明最终持有断言一致，不证明整个叙述真实。NO_CLAIM 也不代表玩家体验无问题；角色谎言被别人当成事实的认知分叉仍需单独试玩观察。
- 队列在同一进程中运行；请求不阻塞正常发布，但 SQLite 前缀读取和重放仍占用事件循环。未验证长事件历史下的 CPU 或尾部延迟。
- 不做持久队列或崩溃续审。已完成首轮 8 轮真实主模型试玩，见 [LIVE-01](PROTOTYPE-JEV-SHADOW-LIVE-01.md)；没有重新跑历史私密 G3 文本。

旧实验恢复：在干净工作树切回 `codex/jev-narrative-auditor-spike`，再 `git stash apply 3df3eaecf651ee9f6a8e6f38589ab8a7bc75adc8`。stash 未删除，main 上原有未提交工作没有移动。

## 6. 历史真实缺陷回放

[历史回放 01](PROTOTYPE-JEV-HISTORICAL-REPLAY-01.md) 已抽取 30 个真实条目。当前终态口径检出 3 个明确冲突，但未检出 6 个虚构中途持有及后续回述条目。新的过程提问只用于离线诊断，尚未接入当前影子模式。
