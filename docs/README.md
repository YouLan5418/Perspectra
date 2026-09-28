# 项目文档

> 项目已进入 **V1（Perspectra）**。本目录同时存放两个世代：**原型阶段（当前有效）** 与 **Phase 0–9C（历史，仅作证据）**。
> 开发约束见根目录 [AGENTS.md](../AGENTS.md)；文档与现行方向冲突时，不自动恢复旧约束。

---

## 一、当前入口（先读这些）

| 文档 | 作用 |
|---|---|
| [当前原型契约：自由叙述与声明式交互 v0.1](2026-09-19_原型契约-自由叙述与声明式交互-v0.1-report.md) | **方向权威**。契约描述目标，不表示运行时已经实现 |
| [基线说明](PROTOTYPE-BASELINE.md) | 当前原型基线：命令、门禁与验收口径 |
| [G4 架构减法：入口、依赖与删除顺序](PROTOTYPE-G4-ARCHITECTURE-AUDIT.md) | **减法权威记录**：逐刀记录 + 待清理清单 |
| [试玩报告：ai-girls-awaken-v10 · 20 轮真实模型](2026-09-25_试玩报告-ai-girls-awaken-v10-20轮真实模型.md) | 最近一次真实模型体验证据（3 红 3 黄） |
| [G1 收口与 G2 失败闭环核对](PROTOTYPE-G1-G2-ACCEPTANCE.md) | G1/G2 验收结论 |
| [记忆第一步收口：自动与主动召回](PROTOTYPE-MEMORY-RECALL-STAGE1-2026-09-28.md) | 已验证的窄场景、权限边界与未通过范围 |
| [Gemini 记忆阶段复测](PROTOTYPE-GEMINI-MEMORY-2026-09-28.md) | 本机模型兼容验证、长程约定对照与主动查询边界 |

## 二、原型阶段验证记录（G1–G4）

### G3 体验与对照实验

- [G3 真实体验验证：连续世界与观察口径](PROTOTYPE-G3-EXPERIENCE.md)
- [G3 对照实验 01：移动方向与玩家混合表达](PROTOTYPE-G3-CONTRAST-01.md)
- [G3 开放式连续试玩：钥匙短暂交接被叙述虚构](PROTOTYPE-G3-FREE-PLAY-01.md)
- [G3 移动观察与玩家在场反馈：第一轮接线验证](PROTOTYPE-G3-MOVEMENT-01.md)
- [G3 第一组连续试玩：真实模型行为验收](PROTOTYPE-G3-PLAYTEST-01.md)

### 逐轮模块实测（13 轮）

- [01 角色场景与自身状态呈现](PROTOTYPE-PLAYTEST-01.md) ｜ [02 NPC 自由表达](PROTOTYPE-PLAYTEST-02.md) ｜ [03 玩家输入与反应链诊断](PROTOTYPE-PLAYTEST-03.md)
- [04 人设与旁观表现触发的顺序对照](PROTOTYPE-PLAYTEST-04.md) ｜ [05 call_limit 周期的上下文与输出审计](PROTOTYPE-PLAYTEST-05.md) ｜ [06 单独突出自身已发布表达](PROTOTYPE-PLAYTEST-06.md)
- [07 abstain 与非语言表达的语义](PROTOTYPE-PLAYTEST-07.md) ｜ [08 一次 perform，提交结果，再自由表达](PROTOTYPE-PLAYTEST-08.md) ｜ [09 角色可读的执行结果与网页最小集成](PROTOTYPE-PLAYTEST-09.md)
- [10 连续互动中的执行反馈与事实分叉](PROTOTYPE-PLAYTEST-10.md) ｜ [11 当前状态、执行结果与对白的地位](PROTOTYPE-PLAYTEST-11.md)
- [12 通用单角色激活接入](PROTOTYPE-PLAYTEST-12.md) ｜ [13 两 NPC、同物品与跨房间连续试玩](PROTOTYPE-PLAYTEST-13.md)

### 玩家输入

- [玩家输入「表现＋移动」错序：最小修复与验证](PROTOTYPE-PLAYER-INPUT-ORDER-01.md)

## 三、操作手册

- [创作者 World Pack 与真实模型试玩指南](CREATOR-PLAYTEST-RUNBOOK.md)
- [World Pack 创作者字段手册](WORLD-PACK-AUTHORING-MANUAL.md)
- [主线真实模型体验入口与 P9 合并说明](REAL-MODEL-EXPERIENCE.md)
- [V0 本机运行与恢复手册](V0-LOCAL-RUNBOOK.md)
- [Phase 7 创作者运行手册](PHASE7-CREATOR-RUNBOOK.md)
- [Phase 8 创作者运行手册](PHASE8-CREATOR-RUNBOOK.md)

---

# 以下为历史文档索引

完成声明属于对应旧版本，**不是本原型验收**。历史阅读入口：[冻结实施规格](spec/implementation-v0.2.md)，再按主题查阅 [ADR 索引](adr/README.md)。Phase 0～6 功能闭环、[并发与权威边界加固计划](2026-08-22_V0并发与权威边界加固计划.md) 和 [Phase 6 架构闭合计划](2026-08-22_实施计划-Harness-Cordis-World-Phase-6.md) 均已通过本机验收。

## 四、Phase 0–6 与 V0 闭合

- [Phase 0 实现与验证报告](2026-08-22_阶段报告-Harness-Cordis-World-Phase-0-report.md)
- [Phase 1 实现与验证报告](2026-08-22_阶段报告-Harness-Cordis-World-Phase-1-report.md)
- [Phase 2 实现与验证报告](2026-08-22_阶段报告-Harness-Cordis-World-Phase-2-report.md)
- [Phase 3 实现与验证报告](2026-08-22_阶段报告-Harness-Cordis-World-Phase-3-report.md)
- [Phase 4 实现与验证报告](2026-08-22_阶段报告-Harness-Cordis-World-Phase-4-report.md)
- [Phase 5 实现与验证报告](2026-08-22_阶段报告-Harness-Cordis-World-Phase-5-report.md)
- [Phase 6 实现与验证报告](2026-08-22_阶段报告-Harness-Cordis-World-Phase-6-report.md)
- [V0 独立审查修复报告](2026-08-22_V0独立审查修复报告.md)
- [Phase 6 独立审查修复报告](2026-08-22_Phase-6独立审查修复报告.md)
- [Phase 6 架构闭合计划（已完成）](2026-08-22_实施计划-Harness-Cordis-World-Phase-6.md)
- [V0 Release Closure 报告](2026-08-24_V0-Release-Closure-report.md)

### 悬疑 Demo（早期切片）

- [三角色悬疑 Demo：首个可执行切片](2026-08-23_进度报告-三角色悬疑Demo首个可执行切片.md)
- [阶段报告：悬疑 Demo Phase 2——多轮调查与真相揭露闭环](2026-08-23_阶段报告-悬疑Demo-Phase-2.md)
- [悬疑 Demo Phase 2 独立审查修复记录](2026-08-23_审查修复记录-悬疑Demo-Phase-2.md)
- [异步 Round 与本机 Headless 进度报告](2026-08-23_进度报告-异步Round与本机Headless-report.md)
- [审查修复记录：Round 账本与悬疑 Demo](2026-08-23_审查修复记录-Round账本与悬疑Demo.md)
- [GLM 暂停点审查修复报告](2026-08-23_GLM暂停点审查修复报告.md)
- [悬疑 Demo 架构纠偏与四项欠账闭环](2026-08-23_阶段报告-悬疑Demo架构纠偏与四项欠账闭环.md)

## 五、Phase 7–9C

### Phase 7

- [Phase 7 范围形成计划（已由正式规格收敛）](2026-08-24_下一阶段计划-通用内容与真实运行验证.md)
- [Phase 7 最小通用内容闭环报告](2026-08-25_阶段报告-Harness-Cordis-World-Phase-7-report.md)
- [Phase 7 独立审查修复报告](2026-08-25_Phase-7独立审查修复报告.md)
- [Phase 7 独立审查修复审核结论](2026-08-25_Phase-7独立审查修复审核结论.md)
- [Phase 7 独立代码审查报告](2026-08-25_Phase-7独立代码审查报告.md)

### Phase 8

- [Phase 8A 权威结构阶段报告](2026-08-28_阶段报告-Harness-Cordis-World-Phase-8A-report.md)
- [Phase 8 完成与 0.3.0 候选报告](2026-08-29_阶段报告-Harness-Cordis-World-Phase-8-report.md)
- [Phase 8.1 独立审查加固与 0.3.1 候选报告](2026-08-30_阶段报告-Harness-Cordis-World-Phase-8.1-report.md)
- [Phase 8.2 / 8.3 实施门禁收口报告](2026-08-31_Phase-8.2-8.3实施门禁收口报告.md)
- [Phase 8 之后独立代码审查报告](2026-08-27_Phase-8后独立代码审查报告.md)
- [Phase 8 之后提交审查报告](2026-08-28_Phase-8之后提交审查报告.md)
- [Phase 8 完整提交审查报告](2026-08-29_Phase-8完整提交审查报告.md)

### Phase 9

- [Reaction Cycle P0 原型验证报告](2026-08-30_Reaction-Cycle-P0原型验证报告.md)
- [Phase 9A 数据迁移、恢复集合与玩家抢占评审](2026-08-31_Phase-9A迁移恢复与抢占评审.md)
- [Phase 9A 权威骨架阶段汇总](2026-08-31_阶段报告-Harness-Cordis-World-Phase-9A-report.md)
- [Phase 9B 多 wave 权威骨架与运行闭环计划（历史进度）](2026-09-01_阶段报告-Harness-Cordis-World-Phase-9B-progress-report.md)
- [Phase 9B Scheduler、多 wave、抢占与恢复阶段报告（历史进度）](2026-09-01_阶段报告-Harness-Cordis-World-Phase-9B-scheduler-report.md)
- [Phase 9B 完成报告：有界多 wave、通知与可重建 Presentation](2026-09-02_阶段报告-Harness-Cordis-World-Phase-9B-report.md)
- [Phase 9B Qwen 通知与 Presentation 收口交接说明（已完成）](2026-09-02_Phase-9B-Qwen交接说明.md)
- [Phase 9C 实施规划：运行闭环与发布收口](2026-09-02_实施计划-Harness-Cordis-World-Phase-9C.md)
- [Phase 9C v15 旧库与 Golden 基线（P9C.0 证据）](2026-09-02_Phase-9C-v15旧库与Golden基线.md)
- [Phase 9C 接手与行政边界收口（P9C.3 本机完成）](2026-09-05_阶段报告-Phase-9C接手与行政边界收口-report.md)
- [Phase 9C.5 五库备份与真实迁移阶段报告](2026-09-05_阶段报告-Harness-Cordis-World-Phase-9C.5-report.md)
- [Phase 9C.6 首批并发证据与剩余性能门槛](2026-09-05_阶段报告-Harness-Cordis-World-Phase-9C.6-concurrency-report.md)
- [Phase 9C.6 长历史测试结果与重复读取定位](2026-09-05_测试报告-P9C.6长历史基准-report.md)
- [Phase 9 代码质量审核报告](2026-09-06_Phase-9代码质量审核报告.md)
- [Phase 9 独立代码审查报告（有界自主 Reaction Cycle）](2026-09-06_Phase-9独立代码审查报告.md)

## 六、交互抽象 I0–I7（分支 `fix/step-cue-normalization`）

- [交互线 I4 状态与审查响应汇总（一处读完：状态、三项审查发现、验证与仍未做）](2026-09-14_交互线I4状态与审查响应汇总.md)
- [交互抽象与按需交互包方案 V0.1（历史提案基线，保留）](2026-09-13_方案-交互抽象与按需交互包-report.md)
- [交互抽象与按需交互包方案 V0.2（当前 Proposed；仅 I0 黄金部分已实施）](2026-09-13_方案-交互抽象与按需交互包-v0.2-report.md)
- [交互抽象与按需交互包方案 V0.3：通信场景与跨边界传播（方向已确认，实施待做）](2026-09-14_方案-交互抽象与按需交互包-v0.3-report.md)
- [通信契约形状草案 V0.1（候选；不构成既有交互 I4 的冻结依据）](2026-09-14_通信契约形状草案-v0.1.md)

### I0 / I1 / I2

- [交互抽象 I0 黄金基线冻结（ADR-0093 的对照基线）](2026-09-13_交互抽象-I0黄金基线冻结.md)
- [交互抽象 I0-B 运行黄金与契约准备（已接受，历史准备记录）](2026-09-13_交互抽象-I0B运行黄金与契约准备.md)
- [交互抽象 I0-B 版本守卫（原始证据）](2026-09-13_交互抽象-I0B版本守卫.txt)
- [交互抽象 I1 执行核心实施记录](2026-09-13_交互抽象-I1执行核心实施记录.md)
- [交互抽象 I2-a 作者声明与目录编译实施记录](2026-09-13_交互抽象-I2a作者声明与目录编译.md)
- [交互抽象 I2-b 每角色选项视图与参数域实施记录](2026-09-13_交互抽象-I2b每角色选项视图与参数域.md)
- [交互抽象 I2-c 模型与 Host 同源 Schema 实施记录](2026-09-13_交互抽象-I2c模型与Host同源Schema.md)
- [交互抽象 I2-d 表现与持续可见状态契约实施记录](2026-09-13_交互抽象-I2d表现与持续可见状态契约.md)
- [交互抽象 I2 审查摘要（主张、攻击面与已知缺口）](2026-09-13_交互抽象-I2审查摘要.md)
- [交互抽象 I2 审查修复记录（5 条全部成立并修复）](2026-09-13_交互抽象-I2审查修复记录.md)

### I3 / I4

- [交互抽象 I3-a 关系域实施记录](2026-09-13_交互抽象-I3a关系域实施记录.md)
- [交互抽象 I3-b 生命周期相位计划实施记录](2026-09-13_交互抽象-I3b生命周期相位计划.md)
- [交互抽象 I3-c 世界 fold 与 move 收尾实施记录](2026-09-13_交互抽象-I3c世界fold与move收尾.md)
- [交互抽象 I3 审查摘要（主张、已知缺陷与攻击面）](2026-09-13_交互抽象-I3审查摘要.md)
- [交互抽象 I3 收尾：处理器作用域与畸形事实修复](2026-09-14_交互抽象-I3收尾处理器作用域与畸形事实修复.md)
- [交互抽象 I4-a Manifest v10 与冻结选择绑定实施记录](2026-09-14_交互抽象-I4a-Manifest-v10与冻结选择绑定.md)
- [交互抽象 I4-b Host 快照投影与冻结解析器实施记录](2026-09-14_交互抽象-I4b-Host快照投影与冻结解析器.md)
- [交互抽象 I4-b 前置：关系目标无法被作者绑定（已裁定为关系类绑定）](2026-09-14_交互抽象-I4b前置-关系目标绑定缺口.md)
- [交互抽象 I4-c 应用层接线与生产路径 move 收尾实施记录](2026-09-14_交互抽象-I4c-应用层接线与生产路径move收尾.md)
- [交互抽象 I4-d（第一片）模型协议 submit_actions/v6](2026-09-14_交互抽象-I4d第一片模型协议submit-actions-v6.md)
- [交互抽象 I4-d（第二片）Round Authority 6](2026-09-14_交互抽象-I4d第二片Round-Authority-6.md)
- [交互抽象 I4-d 第三片前置：反应依据契约与待决问题（未开工）](2026-09-14_交互抽象-I4d第三片前置-反应依据契约与待决问题.md)
- [交互抽象 I4-d（第三片）反应依据策略与响应式 v2](2026-09-14_交互抽象-I4d第三片反应依据策略与响应式v2.md)
- [交互抽象 I4-d（第四片）反应回合自身观察者的分类与读回顺序](2026-09-14_交互抽象-I4d第四片反应回合自身观察者分类.md)
- [交互抽象 I4-e 交互步骤的表现成为观察事实（模型协议那一半未做）](2026-09-14_交互抽象-I4e交互步骤的表现事实.md)
- [交互抽象 I4-f 模型协议的交互表现：submit_actions/v7](2026-09-14_交互抽象-I4f模型协议的交互表现-v7.md)

### I5 / I6 / I7 与收尾

- [交互抽象 I5-a 独立交互包与 I5 计划](2026-09-14_交互抽象-I5a独立交互包与I5计划.md)
- [交互抽象 I5-b（第一片）退出选项与视图预算](2026-09-14_交互抽象-I5b退出选项与视图预算.md)
- [交互抽象 I5-b（第二片）冻结上限的成对容量证据](2026-09-14_交互抽象-I5b容量-fixture.md)
- [交互抽象 I5-c v10 冻结路径的硬终止窗口](2026-09-14_交互抽象-I5c冻结路径硬终止窗口.md)
- [交互抽象 I5-d 冻结路径的真实模型门禁（付费/手动，单独报告）](2026-09-14_交互抽象-I5d冻结路径的真实模型门禁.md)
- [交互抽象 I5-f 部署面上的 v10 样本（fork / 传输 / 备份恢复）](2026-09-14_交互抽象-I5f部署面的v10样本.md)
- [交互抽象 I6：玩家声明表现的槽位（显式命令本来就有，本片补解释路径）](2026-09-15_交互抽象-I6玩家声明表现槽位.md)
- [交互抽象 I7：真实模型试玩线的四步（生产适配器 / v10 网页入口 / 解释 Provider / 重启验收）](2026-09-15_交互抽象-I7真实模型试玩线四步.md)
- [审查修复记录：I2/I3/I4 三项发现（均成立并修复，含证伪）](2026-09-14_审查修复记录-I2I3I4三项发现.md)
- [审查修复记录：反应证据的持久化边界、失败观察与 Player Intent 的 v10 入口（I4 三条边界达成）](2026-09-14_审查修复记录-反应证据边界与失败观察.md)
- [复核一轮表现归属修复：定义拥有步骤、协议声明与工具一致（六次证伪，一处理由更正）](2026-09-15_审查修复复核-表现归属与协议版本.md)
- [表现码跨列表重复的归一化修复说明](2026-09-13_表现码跨列表重复归一化-修复说明.md)
- [交互抽象：作者文档的 v5 路线与它翻出的 CLI 编译缺口](2026-09-14_交互抽象-作者文档v5路线与CLI编译缺口.md)
- [交互抽象：剩余样本清账与一处记录更正](2026-09-14_交互抽象-剩余样本清账与一处记录更正.md)
- [试玩故障修复：写者租约与失败提示（空闲超期后输入失败 / 重发导致同一意图做两遍）](2026-09-15_试玩故障修复-写者租约与失败提示.md)

## 七、角色交互 C0–C4 与 v8 表现码

- [角色交互 C0 Schema Spike：版本、持久化与 Provider 出闸矩阵](2026-09-11_角色交互-C0-Schema-Spike.md)
- [角色交互 C1 实施记录](2026-09-11_角色交互-C1-实施记录.md)
- [角色交互 C2 实施记录](2026-09-12_角色交互-C2-实施记录.md)
- [角色交互 C3 契约切片记录](2026-09-12_角色交互-C3-契约切片记录.md)
- [角色交互 C3 运行时与 C4 恢复实施记录](2026-09-12_角色交互-C3运行时与C4恢复-report.md)
- [角色交互 C3/C4 模型无关收尾报告](2026-09-12_角色交互-C3C4-模型无关收尾-report.md)
- [v8 表现码契约修复说明](2026-09-10_v8表现码契约修复说明.md)
- [修复后真实模型复测记录](2026-09-10_修复后真实模型复测记录.md)
- [真实模型试玩记录：v8 被拒输出的原因分层与契约缺口](2026-09-10_真实模型试玩记录-v8拒绝原因与契约缺口.md)

## 八、记忆与上下文

- [长期记忆 / 上下文压缩：第一批改动记录](2026-09-11_长期记忆压缩-第一批改动记录.md)
- [关键词召回、结构化线索与名称词典：改动记录](2026-09-12_关键词召回与结构化线索-改动记录.md)
- [连续基线前移：改动记录](2026-09-12_连续基线前移-改动记录.md)
- [摘要重做与正文进上下文：改动记录](2026-09-12_摘要重做与正文进上下文-改动记录.md)
- [上下文成本核算与精简渲染：改动记录](2026-09-12_上下文成本核算与精简渲染-改动记录.md)
- [角色交互与长期记忆两条战线的合并记录](2026-09-12_交互与记忆战线合并-record.md)
- [记忆模块规划：模块边界与长期召回策略演进](2026-09-06_规划-记忆模块策略演进.md)（**非最终版本，不可当基线**）

## 九、独立审查与评审（跨阶段）

- [Harness / Cordis World V0 — 独立代码审查报告](2026-08-24_独立代码审查报告.md)
- [全维度代码评审与路线偏移报告](2026-08-28_全维度代码评审与路线偏移报告.md)
- [独立代码评审问题汇总](2026-08-29_独立代码评审问题汇总.md)

## 十、冻结规格与 ADR

- [规格来源与固定 Hash](spec/README.md)
- [ADR 索引](adr/README.md)
- [冻结实施规格 v0.2](spec/implementation-v0.2.md)
- [通用内容与真实运行架构总纲（Phase 7～11）](spec/general-content-architecture-v0.1.md)
- [Phase 7 正式实施规格：最小通用内容闭环](spec/phase-7-implementation-v0.2.md)
- [Phase 8 正式实施规格：可重建角色心智与多 Scene 上下文](spec/phase-8-implementation-v0.1.md)
- [Phase 8.1 加固规格](spec/phase-8.1-hardening-v0.1.md)
- [Phase 9 实施规格：有界自主 Reaction Cycle](spec/phase-9-implementation-v0.1.md)
- [角色交互与玩家即时成立 V0.1 实施规格](spec/character-interactions-v0.1.md)
- [交互定义抽象冻结实施契约](spec/interaction-definition-v0.1.md)
- [对象交互规格 v0.1](spec/object-interactions-v0.1.md)
- [有界动作组规格 v0.1](spec/bounded-action-groups-v0.1.md)
- [记忆演进实施规格 v0.1](spec/memory-evolution-implementation-v0.1.md)
