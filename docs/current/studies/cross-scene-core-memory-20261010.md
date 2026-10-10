# 通信、活动与 Core 记忆验证

玩家在猜数活动中给后室朋友发送“青灯”，整理成长期记忆后保存节点。原线后来发送“鸢尾”；回退节点或分享给独立实例后，再问节点前暗号。收信人应根据自身授权经历召回“青灯”，不能携带原线未来，也不能让本地同行者召回私信或远端声音。

## 实现与自动验证

[实验入口](../../../tests/experiments/cross-scene-runtime.ts)显式接受既有 CoreRunner，复用 PlaytestMemoryCore 的授权来源、召回、短期边界、身份历史、归档保存与恢复。只为可调用 NPC 建立 Core 档案，与普通宿主一致。保存等待当前行动和整理结束；本地节点携带实际安装的档案；分享仍使用既有白名单排除 Core 缓存，接收方按授权历史重新整理。没有新增分享格式、记忆协议或默认配置。

[组合回归](../../../tests/prototype/cross-scene-core-memory.test.ts)分别测试短信与电话：授权 Source 隔离，活动保持不变，节点回退恢复原归档，未来已整理记忆被排除，分享不携带 Core 缓存，接收方重新构建得到相同授权来源。桥使用确定性构建结果，只证明宿主接线与边界，不能证明 Python 检索质量。

相关通信、活动、节点测试 5 文件 27 项通过；既有 Core 与故事节点测试 2 文件 31 项通过。类型检查与 Lint 通过。没有重跑全仓 check。

## 真实 Core 验证

[真实脚本](../../../tests/experiments/cross-scene-nodes-live.ts)的第四参数 `core` 使用本机 Python Core、E5 和用户指定的 8046 / gemini-3.8-flash。测试设置 minimumRecentTokens=0，主动整理后移除旧短期原文，检查实际 Core Delivery 包含“青灯”、短期观察不含“青灯”、上下文不含未来“鸢尾”。这是检索测试参数，未改变产品默认的近期重叠窗口。

```powershell
node --import tsx tests/experiments/cross-scene-nodes-live.ts output/experiments/my-core-sms sms core
node --import tsx tests/experiments/cross-scene-nodes-live.ts output/experiments/my-core-phone phone core
```

调整前的完整节点脚本未通过真实验收：短信最终样本的收信人、电话样本的同行者在 Retain 阶段连续三次 120 秒 HTTP 超时，单角色构建约 367 秒后失败。其他独立角色的归档成功安装；失败没有安装半成品。该现象发生在 Core 工具模型请求，不能据此认定为通信规则回归。

原始证据保留在 `output/experiments/nodes-core-sms-gemini38-20261010-02` 与 `output/experiments/nodes-core-phone-gemini38-20261010-01`，background-builds.jsonl 记录完成／失败，utility-attempts-*.jsonl 记录仅元数据的实际超时与重试。早期短信 01 的收信人归档成功，但当时实验入口误为玩家也建立 Core 身份历史，玩家构建超时；已修正为普通宿主的 NPC 范围，此样本不计完整验收。

[独立召回脚本](../../../tests/experiments/cross-scene-core-recall-live.ts)只在来源停止后，将完整实验目录复制到新验证目录，使用已实际安装的收信人归档，不重建或伪造记忆。短信与电话两个样本均通过：去掉旧短期原文后，Core Delivery 实际交付“青灯”，Gemini 分别通过短信与 phone-say 回答“你之前说的暗号是青灯。”；活动状态保持不变。报告分别位于 `output/experiments/core-recall-sms-gemini38-20261010-01/report.json` 与 `output/experiments/core-recall-phone-gemini38-20261010-01/report.json`。电话样本同行者没有归档，其本地处理不计入真实 Core 召回验收。

上述调整前的结论是自动化边界通过、短信与电话收信人真实召回通过、完整真实整理受超时影响，不能合并为“Core 已全面验收”。默认网页、Launcher、发行包没有安装实验通信；长会话、跨机器与强制断电不在本轮范围。

后续[耗时与并发排查](core-utility-timing-20261010.md)确认了 Core 思考参数与本机网关实际预算的漂移：低思考传输探针串行／双并发均通过，完整单角色 Core 构建约 17.43 秒通过。按用户要求，源码现已接入 Gemini 兼容请求先 low、仅超时后 disabled 重试一次。

修改后完整短信与电话 Core 节点流程均通过，数据目录分别为 `output/experiments/nodes-core-sms-low-gemini38-20261010-01`、`output/experiments/nodes-core-phone-low-gemini38-20261010-01`：实际整理、恢复保存归档、排除后来已整理的鸢尾、分享后重新构建、去掉旧短期原文后的 Core Delivery 召回及独立续写均通过；回退与分享后真实角色回复青灯，活动状态一致，电话恢复为原连接后续话。两次流程串行执行，Core 内部保留双角色并发。28 项 Python 桥测试与 24 项宿主／Core 集成测试通过，类型检查、Lint、文档链接检查通过。超时换参只由模拟网络测试验收，本轮真实 Core 请求没有触发回退；不推广到所有长期玩法。
