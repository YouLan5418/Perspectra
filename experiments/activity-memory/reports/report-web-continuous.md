# 6.5 正常网页 Memory 入口与连续互动实测

| 属性 | 内容 |
| --- | --- |
| 日期 | 2026-10-05 |
| 状态 | 源码下 `--memory-core` 的有限接入通过；非默认入口，不代表完整多角色体验验收 |
| 数据 | `.tmp/memory-web-continuous-20261005-v1`；新目录，旧实验和 `D:/worlds` 未修改 |
| 场景 | 原有 `prototype-g1` v5 Pack；两 NPC、前室/后室、黄铜钥匙 |
| 模型 | 本机网关请求 `gemini-3.7-flash`；未据此推断网关实际底层模型或容量 |
| 入口 | 原有 `FrozenWorldPlaytestRuntime` 和网页 HTTP API；未自动化浏览器 UI |
| 验证 | 默认 check 27 文件 / 185 测试，相关 Python 21 项，来源/交付/原生提交审计通过 |

## 1. 实际替换

`PlaytestMemoryCore.project` 现在明确请求 `deliveryMode: minimal`。桥继续使用原来的查询、词法/本地向量检索和分数诊断，随后复用简单 ID 候选准入。无 JEV 时，将自然入池的 Observation 交给极简 Delivery；它保留认识正文、来源类型、原始引用、反证存在标记和最多两段可容纳的证据。不再用“支持全部为直接观察/已接受动作”压住正文，也不要求证据整组容纳才交付。正文和必要来源本身超预算仍可省略，并记录原因。

Core 模式的 Character Turn 关闭原生 `prepareStimulus` 和主动 recall；授权 Source 的 catch-up 仍由现有快照完成。正常回应只走一次 Core 召回，不叠加原生检索。最多三项、4500 JSON 字符；宿主继续核对世界、角色、前缀和来源引用，并新增摘选 Source 属于该条认识来源的检查。

继续沿用手动 refresh，不添加自动整理调度。整理仍是原来的 Retain 新来源、Group、Consolidate、索引；旧 Source/Atom 复用。一般家族发现、多分支更新和正式 Memory schema 没有改造。旧复杂 Delivery 留在独立对照代码中，正常 Core 的 Observation 交付不经过它；非 Observation 原始证据呈现仍复用已有代码。

Python 桥作为命令行启动时复用同一模块实例，避免极简交付导入桥后重复安装既有 Source 投影适配。未增加协议、数据库、恢复或兼容层。

## 2. 实测流程

按预先保存的协议，经 `/api/submit` 提交两条不同的未经核实的钥匙用途：看守说后室柜子，另一位访客说前室抽屉。`/api/memory/refresh` 整理两角色各自全部授权 Source，生成自然认知，不植入已知家族正文或目标 ID。

随后真实提交八轮闲聊，再问钥匙用途与确认状态。再次手动整理，最后重复同一问题。共 12 次玩家输入、2 次 refresh，14 个 HTTP 阶段全部 200 且无角色失败；未选择性重试。角色最多一波、两次全局调用机会，近期公开/自身观察各四条；这是有界接入验证，低于默认试玩调度预算。

13 次实际 Character 调用全部来自同行者：11 次 publish、1 次 perform、1 次 abstain。留守者完成两次授权档案整理，但没有实际角色模型调用，不能将本轮表述为两角色连续回应验收。

## 3. Evidence → Finding → Path

| Evidence | Finding | Path |
| --- | --- | --- |
| 首次整理，同行者 7 Source/12 Atom/1 Observation；留守者 5/9/2，均在 seq47 | 原有整理自然形成了“两个未经验证的用途”认识；留守者另外保存实际钥匙保管情况 | 保留现有整理入口，不强制已知家族或指定答案 |
| seq47 档案的九次召回，原检索 Observation 入池均为0；简单准入均为1，正文均实际进入请求 | 旧候选断点在正常网页路径也存在，已被复用的 ID 准入打通 | 记录 baselineRetrieval/admission 和实际模型材料 |
| 八轮闲聊的请求均读到钥匙认识，七条公开回应围绕本轮话题，一次 abstain；无公开钥匙话题侵入 | 角色可忽略不相关认识，但噪声材料仍占预算；回应多次仅“挺好”“挺好听”，自然度收益未证明 | 记录宽准入与短促重复，暂不加语义分类器/JEV必经门 |
| 延迟问题：同行者“没确认。听说能开后室柜子或抽屉，得试。” | 保留未核实和用途分歧；“前室”限定被压缩掉，来源与认识正文仍完整 | 记录精度限制，不将简短回应等同于完整复述 |
| 二次整理后，同行者 24 Source/42 Atom/2 Observation，留守者14/29/1；旧 Source/Atom 原样复用 | 正常新增历史进入现有整理，认知重新生成；不等于6.4已知家族版本谱系更新 | 当前只验收一般整理的接入，不承诺版本保存/通用合并 |
| 最后请求原检索1个认识、准入2个、交付2个；回应“没确认。传闻都不算，得试。” | 对用途仍未作客观确认；偏好认识也被额外交付 | 接受当前有限噪声，后续用实际怪事判断收缩点 |
| seq26 entity.transferred、seq27 accepted interact、seq28同行者获准动作观察，同一事务 | 第一条输入后真实取得钥匙保管；它发生在首次整理之前，不能归因为极简认识收益 | 只将 accepted + committed 计执行；没有 character.moved 或开柜验证 |
| 两次 refresh 前后完整 head 相同；65行Source与世界事件/角色来源对照通过 | 整理未改权威事实，交付仍在授权来源内 | 保留宿主检查及缓存、引用、摘选越权负测 |

自然整理将两种用途都记为支持“尚未确认”的材料，`contradictingAtomIds` 为空。因此本轮反证布尔标记为 false，不能解读为不存在语义分歧或已经核实。Delivery 如实呈现已有结构，正文保留两种说法；它没有重新用模型判断反证。此前混合发言支持、非空反证与不完整证据的回归仍通过。

## 4. 材料、成本和限制

10 次实际 Core 召回共交付11份认识正文，11份都明确证据不完整；正文的所有 Source ID 和引用保留。第一次整理后九次调用各一份，二次整理后最后一次两份。全部模型请求 `canRecall=false`，没有原生隐式记忆或主动 recallEvidence。前两条输入及取钥匙续写在未整理阶段长期材料为空，近期上下文正常。

两次 refresh 累计等待约147.77秒；四个按角色 build 的桥处理约147.22秒。12次 Utility 生成调用，提供商总用量55177 tokens。10次召回桥等待累计约69.42秒，包含 Python/本地模型启动和检索；第一档单次约7—8秒，最后一档约1.81秒，不能声称稳定加速。没有 JEV 或新增生成式查询/投影调用，但仍有本地嵌入计算。

13次 Character加12次 Utility共25次记录的生成调用。Character 路径记录原始返回与调用耗时，没有完整 token usage，不能给出整体 token 成本或付费节约量。整理成本尚未简化。

有意识保留：手动整理之前只提供近期上下文；两次整理之间长期档案停留在上次前缀；宽准入可在无关话题交付认识；部分证据摘选；单轨迹小样本；多角色活跃行为、一般版本谱系、浏览器 UI、桌面打包未验收。默认不传 `--memory-core` 的网页仍用原生记忆，已运行进程不会自动替换。

## 5. 验证和复用

默认 `corepack pnpm@11.7.0 check`：27文件185测试通过。网页 Memory 相关7项包含角色缓存/引用越权、摘选越权、私有活动/变量隔离、取消、HTTP认证以及关闭原生回忆；Python21项为候选准入8、极简Delivery7、认识谱系6。全链审计检查世界事件、授权Source、旧Atom复用、冻结分数下准入/交付重放及实际角色请求。未修改事务或恢复边界，未运行硬崩溃测试。

```powershell
# 新启动正常网页，用宿主“整理长期记忆”按钮
corepack pnpm@11.7.0 experience:web --memory-core --pack examples/world-packs/prototype-g1 --data-dir .tmp/my-simple-core-web

# 本次有界 HTTP 实测；必须为不存在的新目录
node --import tsx tests/experiments/memory-web-continuous.ts .tmp/my-memory-web-continuous
& .tmp/hindsight-vector-venv/Scripts/python.exe experiments/activity-memory/audit_web_continuous.py .tmp/my-memory-web-continuous
```

实际材料位于 protocol/stages/events/bridge/utility、`memory-core/recall-trace.jsonl` 和 `model-trace.jsonl`；初始档案冻结为 `initial-*.json`。`audit.json` 是机械审计，`dialogue-review.json` 是逐条人工阅读，均不当作语义绝对保证。

下一步优先在现有正常试玩里记录多角色与较长交流的问题；若要继续降延迟，应针对本次已测得的每次召回启动和手动整理等待做有限修改。当前没有证据要求恢复复杂 Delivery 或新增必经语义判断。
