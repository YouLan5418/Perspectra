# Hindsight 外挂记忆：角色隔离影子实验

> 2026-09-28；Perspectra V1 实验工作树。只新增实验入口与本记录，未接入正式 Character Turn。Hindsight 源码为 D:/DeepSeek Harness/hindsight-main，实际服务版本 0.10.1。

## 问题与实验边界

检验 Hindsight 能否在保持角色信息隔离和来源归因的前提下，补足现有 cjk-ngram/v1 对语义改写的召回。世界事实仍由 World Event Log 与 Rulebook 裁定；Hindsight 只能排序角色已经可见的记忆来源。

独立实验世界里，NPC 亲见鲍勃取得杯子（event:13），随后听到鲍勃声称已经交给玩家（event:14）；鲍勃另收到只有他能听到的暗号（event:15）。鲍勃离场后暗中放下杯子，NPC 没收到该观察。再加 18 条雨天对话，把杯子事件推出近期窗口。新存档位于 .tmp/hindsight-shadow-20260928-run2/，没有读写 D:/worlds。

实验入口先调用现有 CognitiveMemoryService.catchUp，再从该角色的 cognitive_memory_v2_sources 命名空间导出已核验来源；每个角色写入独立 Hindsight bank。每条来源以自身 source_id 为 document_id，并携带 source_seq、source_hash、capture_hash、epistemic_kind。外部召回结果必须能逐条匹配该角色允许的原文来源，否则实验失败。Hindsight 不读取世界数据库，也不能指定角色或 bank。

本次 Hindsight 设为 chunks 原文写入、关闭自动巩固、timestamp 为 unset、本机多语言 E5 ONNX 嵌入、RRF 排序；没有运行其 LLM 事实提取、observations、reflect 或现实日期推断。PostgreSQL/pgvector 使用 Docker，数据位于 .tmp/hindsight-backend-lab-20260928/pgdata/。Hindsight API 仅绑定 127.0.0.1:8891。8045 仅用于后续四次 Gemini 3.7 Flash 回答探针。

## 证据 → 发现 → 处理

| 证据 | 发现 | 处理 |
| --- | --- | --- |
| NPC 导出 20 条来源，含 event:13/14，不含 Bob 私语 event:15；Bob 导出 1 条并含 event:15。所有返回条目与角色来源原文、文档 ID 对上，世界 headSeq 保持 35。 | 宿主先做可见性筛选、Hindsight 再按 bank 检索，这条路径在本场景没有越权或改写权威事实。 | 保留“按角色 bank + 宿主来源白名单复核”的实验方案；不能把 bank ID 或 Hindsight API 交给角色模型自行调用。 |
| “最早是谁把杯子从桌上拿走”：两者均命中 event:13；现有召回把鲍勃说法 event:14 排第一，Hindsight 把亲见取得 event:13 排第一。 | Hindsight 对这一题的排序更符合证据强弱，但它并不理解 World Event 的权威级别，单个样本不能证明稳定。 | 后续扩大受控语义改写集，再决定是否替换现有排序。 |
| “那件喝水用的器皿当时是被谁收走”：现有召回为空，Hindsight 首位为 event:13。 | 多语言语义嵌入在本题补到了关键词召回的漏检。 | 这是继续测试 Hindsight 检索层的具体收益。 |
| “鲍勃曾说过杯子已经给玩家了吗”：两者均命中 event:14；Hindsight 仍返回原文 character:bob said: ...。 | 原文模式暂保留了“说法”和“已裁定交接”的区分。 | 暂不启用 Hindsight 自动事实提取或巩固，后续若开启需单独测传闻升格。 |
| NPC 问不存在于其记忆中的“深海灯”：现有召回为空；Hindsight 返回 10 条无关雨天对话，未泄露暗号。Bob 问自己的私语，两者均返回 event:15。 | bank 隔离通过，但 Hindsight 在无答案问题上仍强行给出候选。排名第一的无关项 final=1.0、semantic≈0.838；语义改写真阳性的 semantic≈0.855，现有样本不支持通用硬阈值。 | 候选不得视为“角色知道”；在正式接入前要验证无答案时的证据处理，不能按本例分数写死阈值。 |

完整结构化输出是 .tmp/hindsight-shadow-20260928-run2/report.json，输入来源是同目录 sources.json。第一次相同历史的实验在 .tmp/hindsight-shadow-20260928-run1/；第二次只增加了语义改写问题。

## 小规模模型探针

用同一段“只依据本人可见旧记忆、说法不等于事实、无相关证据时说不知道”的系统提示，分别送入现有召回与 Hindsight 候选。有效结果保存在 .tmp/hindsight-shadow-20260928-run2/model-probe-valid.json：

| 问题 | 现有召回 | Hindsight 候选 |
| --- | --- | --- |
| 喝水用的器皿被谁收走 | “我不知道。” | “是鲍勃收走的。” |
| NPC 无权获知的暗号 | “我不知道。” | “我不知道这个暗号是什么。” |

8045 曾有一次响应中途断开；最初探针脚本误复用前一响应，无效文件已删除，不计作证据。重跑时将错误视为失败并限次重试，以上四条均为有效响应。探针是单次静态问答，不是完整 PrototypeCharacterTurn、连续互动或统计意义上的 A/B；它只能说明本次 Hindsight 噪声没有立刻使模型虚构暗号。

## 当前决定与限制

**保留的只有隔离影子实验入口和“语义检索可能补漏”的候选结论。** 暂不替换正式 Memory、不开放 Hindsight reflect、不把其 world fact 当作 World Event Log。Hindsight 默认服务不鉴权；本实验仅在本机隔离服务上使用合成数据。角色私密数据若要进入长期运行服务，访问边界和外部模型调用仍需单独设计与验证。

本次没有测真实长程扮演、巩固后认知变化、复杂中文、多分支世界、服务重启后的增量同步及成本。chunks 仍需要嵌入模型与 PostgreSQL；服务冷启动和运维复杂度明显高于现有 SQLite 记忆。下一轮若继续，先扩充可复现的同义词、传闻、无答案与私语案例，并让 Hindsight 候选通过现有角色请求参与连续试玩，再决定是否承担外挂服务依赖。

复现实验：在新 .tmp 目录启动本机 PostgreSQL/pgvector 与 Hindsight 0.10.1，设置 HINDSIGHT_API_LLM_PROVIDER=none、HINDSIGHT_API_EMBEDDINGS_PROVIDER=onnx、HINDSIGHT_API_RERANKER_PROVIDER=rrf、HINDSIGHT_API_RETAIN_EXTRACTION_MODE=chunks、HINDSIGHT_API_ENABLE_AUTO_CONSOLIDATION=false，绑定 Hindsight API 至 127.0.0.1:8891，然后运行：

    node --import tsx tests/experiments/hindsight-shadow-drive.ts .tmp/<新的输出目录>

脚本会拒绝已存在的输出目录。当前版本已运行 corepack pnpm@11.7.0 typecheck 与定向 oxlint，并实际完成两轮 Hindsight retain/recall；未运行完整测试套件。


## 后续方向更新（2026-09-28）

用户明确选择参考 Hindsight 的适用机制，在 Cordis World 内原生实现；外挂服务只保留为本次受控对照，不作为正式后端。上文“下一轮若继续决定是否承担外挂服务依赖”是实验当时的待决事项，现已由此决定替代。提取结果、阶段顺序和验收边界见 PROTOTYPE-NATIVE-MEMORY-FROM-HINDSIGHT-2026-09-28.md。
