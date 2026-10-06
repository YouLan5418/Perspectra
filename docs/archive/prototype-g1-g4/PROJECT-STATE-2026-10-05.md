# 当前项目状态与入口（2026-10-05）

> 本文保留10月5日提交前的实现与验收快照。代码现已提交并合入main，分支与工作树收口见[2026-10-06项目状态](../../current/PROJECT-STATE.md)。

| 属性 | 内容 |
| --- | --- |
| 当前工作树 | `Perspectra V1` |
| 当前分支 | `codex/world-capability-experiment` |
| 整理时HEAD | `cc008ed`，二十条Observation Bank的批量JEV对照 |
| 工作树状态 | 包含后续认识、Delivery、网页接入与地点修复的未提交源码/报告；HEAD不代表全部现行实现 |
| 项目性质 | 多角色扮演原型实验；以自然互动、角色主体性、认知隔离和关键事实一致为目标 |
| 当前记忆 | 默认原生记忆；源码网页的`--memory-core`显式启用简化实验路径 |
| 最近检查 | 地点修复后类型、Lint、27文件185项通过；本次整理仅修改文档与产物位置 |

## 1. 从哪里开始

| 任务 | 入口 |
| --- | --- |
| 理解产品方向与开发边界 | [AGENTS](../../../AGENTS.md)、[当前原型契约](../../current/prototype-contract.md) |
| 直接试玩或制作世界包 | [试玩指南](../../current/guides/creator-playtest.md)、[World Pack手册](../../current/guides/world-pack-authoring.md) |
| 运行简化记忆实验 | [当前实验入口](../../../experiments/activity-memory/README.md) |
| 看简化决策和各阶段验收 | [记忆认知简化方案](../memory-evolution/2026-10-05_记忆认知体系简化方案.md) |
| 看最新双角色体验、缺陷与修复 | [6.6实测及修复报告](../../../experiments/activity-memory/reports/report-normal-playtest.md) |
| 查旧实验命令和对照 | [实验历史](../../../experiments/activity-memory/HISTORY.md)、[文档索引](../../README.md) |
| 查整合前的分支与环境历史 | [10月3日状态快照](PROJECT-STATE-2026-10-03.md)，其中配置与分支状态按当时理解 |

## 2. 当前实现边界

World Pack使用`worldpack-source/v5`源目录，源码网页经`FrozenWorldPlaytestRuntime`运行Manifest v10。玩家的普通自然语言作为发言；移动、取物、交接等受控变化用网页交互或显式命令触发可信裁定。角色使用`perform/publish/abstain`自行选择行为和表达，已提交结果生成授权观察，再进入有界后续激活。

角色请求仅提供该角色有权接收的当前场景、近期观察、自身历史与派生材料。移动后`character.locationId`已修复为同一前缀角色view的当前位置，与`scene.locationId`一致。World Event Log仍是权威事实来源；认识、模型提案与对白本身不证明重要状态已经改变。

包内变量、可信本地作者脚本与单活动原型沿既有机制使用；参见[创作者脚本与活动方案](2026-10-02_创作者脚本与临时交互限制方案.md)。它们不表示通用插件平台、多活动并行或完整创作者产品已实现。

简化Core记忆采用既有授权Source和手动整理：Retain→Group→Consolidate→索引，读取时原检索→简单ID准入→极简Delivery→Character。认识正文优先，来源与反证存在标记保留，证据可以摘选；最多三项/4500 JSON字符，角色/世界/前缀与引用权限仍校验。该模式关闭重复原生检索及主动recall，JEV只留作可选对照。默认原生记忆路径保持自己的实现，不用上述Core行为解释它。

## 3. 代码职责与研究边界

| 位置 | 当前职责 |
| --- | --- |
| `tests/experiments/playtest-web-entry.ts`、`playtest-server.ts` | 源码网页启动与本机API |
| `tests/experiments/playtest-frozen-runtime.ts` | 世界包装配、角色激活、网页状态与Core选择 |
| `packages/application/src/prototype-character-turn.ts`、`prototype-activation-cycle.ts` | 隔离角色激活、执行后续写和有界调度 |
| `packages/kernel`、`contracts`、`interaction-runtime`、`interactions-basic` | 裁定、共享契约和受信任交互能力 |
| `packages/store-sqlite`、`memory` | 事件、角色view、原生授权来源与记忆 |
| `packages/provider-chat`、`agents` | 模型请求与角色适配 |
| `packages/world-pack`、`examples/world-packs` | 世界包编译/工具与示例内容 |
| `experiments/hindsight-core` | 随仓库保存的分层记忆核心与本地资产描述 |
| `experiments/activity-memory` | Core桥、当前极简交付、独立对照、审计和报告 |
| `tests/prototype` | 当前原型自动回归；与历史全量规格分开验收 |
| `desktop` | 本机启动器；Core的Python/模型资产尚未纳入桌面发布包 |

现有包布局继续使用。实验入口、离线审计和复杂Delivery/JEV对照不会仅因文件仍存在就成为正常网页的必经流程。当前整理不移动源码或更换导入路径。

## 4. 最近的验证与实际问题

| Evidence | Finding | Path |
| --- | --- | --- |
| 6.2复杂/极简Delivery对照，认识正文0/6→6/6 | 交付阻塞得到具体修复，JEV没有证明为必经 | 保留极简阅读及授权检查，复杂实现用于对照 |
| 6.4真实新Source与已知家族更新闭环 | 有限认识更新可影响表达/取证方式；非通用家族发现 | 独立实验保留，不扩大正常网页schema |
| 6.6默认预算：19次输入、2次整理、25次角色调用；浏览器与90行Source审计 | 两角色能按自身可见信息交流，未把传闻确认为用途，私有暗号未泄露 | 继续正常试玩；小样本不宣布完整G3或稳定认识收益 |
| 地点修复先红后绿；185项检查；新目录6次输入/1次整理/12次实际请求、38行Source | 当前地点字段与事件前缀一致，整理后召回和隔离仍正常 | 缺陷关闭，保留最小移动回归 |
| 旧认识送入无关闲聊；同行者重复追问柜子、忽略新话题 | 宽准入噪声及持续目标牵引仍有体验影响 | 观察具体重复回合，优先找局部收缩点 |
| 6.6整理约77秒，修复复验约57秒，数据规模不同 | 手动整理和Python/本地检索启动仍有等待；未证明速度收益 | 分开记录整理与召回成本，按已测瓶颈处理 |

一般家族发现、多分支通用更新、完整多场景角色体验和桌面Core打包继续作为未验收范围。角色输出符合程序权限不等于自由叙述永远语义一致；旧G3失败记录继续保留。

## 5. 实验记录放在哪里

| 目录/文件 | 用途 |
| --- | --- |
| `.tmp/memory-web-continuous-20261005-v1` | 6.5有限网页接入轨迹 |
| `.tmp/simple-memory-playtest-20261005-v2` | 6.6正常双角色原轨迹；`browser-artifacts/`归档8份截图/快照/console文件 |
| `.tmp/simple-memory-playtest-20261005-v3` | 地点修复后的真实复验；当前保留运行的修复版服务 |
| 各数据目录的`memory-core/` | 授权缓存、私有请求、返回与召回trace，只供本机审阅 |
| `normal-stages.json`、`normal-audit.json`、`normal-dialogue-review.json` | 实际流程、机械审计及人工复核 |
| `context-location-check.json` | 修复复验逐请求对照调用时已提交地点 |

源码、测试、报告保留在仓库；模型权重、Python环境、世界数据库和私有trace放在`.tmp`。浏览器工具默认产物目录已加入忽略规则，最终证据归入对应实验目录。旧数据与失败证据不删除；`D:/worlds`及只读调研工作树保持原边界。

## 6. 验证与后续工作

普通代码修改运行类型检查、相关测试及必要集成；Context/Memory/角色行为修改还要看真实模型。默认命令仍为`corepack pnpm@11.7.0 check`，不代表体验验收。纯文档与归档整理核对链接、文件保全和diff，本次不重新调用模型或重跑完整套件。

下一步以更长和更多场景的正常试玩验证角色主体性、话题切换与记忆噪声；按真实失败或已测等待选择小改动。尚无证据要求恢复复杂Delivery、新增必经语义分类、通用版本协议或大范围包重组。
