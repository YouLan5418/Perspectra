# 极简 Delivery 与 6.2 JEV 消融（2026-10-05）

| 属性 | 内容 |
| --- | --- |
| 实际问题 | 认识已进候选、JEV已接受，复杂Delivery仍因发言支持证据与完整证据组预算拒绝正文 |
| 用户选定方向 | 独立极简Delivery对照；保留授权与引用检查，正文直接交付，证据允许摘选 |
| Delivery结果 | `.tmp/memory-minimal-delivery-20261005-v1`，24次首步选择、36次Character调用 |
| 6.2结果 | `.tmp/memory-jev-ablation-20261005-v1`，24次首步选择、30次Character调用、6次实际JEV调用 |
| 数据 | 同一6.1三条延迟轨迹、八次无关互动、登记/同对象装饰/不同对象设计三个刺激 |
| 状态 | 两组实验及审计完成；认识阅读阻塞已解除，正式网页与长期行为闭环未验收 |
| 取舍 | 后续实验采用极简认识交付；JEV保留可选对照，不作为已证明必要的必经步骤 |

## 1. 极简机制与必要边界

新增`minimal_delivery.py`，不修改原复杂Delivery。认识先通过现有宿主授权快照和原Archive引用校验，再检查角色、世界、已知时间及候选选择范围。首次对照只交付原JEV已选中的认识；6.2无JEV臂明确从同一授权候选池选择，不伪造JEV接受结果。

选中认识优先于非认识材料交付，内容是：原认识正文，`subjective_inference`及“本角色的可修正认识；不是权威世界事实”标签，引用Source类型，是否仍有引用反证，少量关键证据及摘选覆盖信息。

最多摘选一条反证和一条最近支持证据，保留各自来源类型与原证据文本。预算只容得下正文和必要标记时，认识仍保留，证据可以不展示；明确记录反证总数/已展示数和`complete=false`。整个正文与标记都放不下时才拒绝该认识，不从正文中间截断。这里的反证标记表示现有认识引用中仍有反证，没有另行模型判断“已解决”。

不要求支持证据全为direct observation/accepted action，不要求整个Evidence Group必须完整进入预算。全体原引用仍核验并保留于trace，不因摘选而删除Source或修改认识。非Observation材料继续复用原证据投影，避免把局部对照扩成整个Delivery重写。

这是实验中的主观材料交付变化，不是世界事实权威变化：模型仍只提出行动；Rulebook裁定与World Event Log提交照常执行。JEV也不承担授权、真实性或行动裁定。

## 2. 冻结与验收方式

两组均使用6.1正式v2的同一候选池、Query、分数、认识正文、Source、非Memory请求、Capability和已提交前缀，不重新嵌入、调阈值或注入目标认识ID/答案。预算仍最多3项、4500 JSON字符，每次激活最多2次Character调用。登记每轨迹/每臂两次，两个负控各一次。

Delivery对照复用已保存JEV决定，原交付必须能够确定性重放；极简路径只替换认识处理。6.2重新实际调用原JEV协议，为有JEV臂准备材料；无JEV臂不作判断调用，两臂使用同一极简交付器。每个案例的准备结果由重复Character样本复用，不测JEV重复稳定性。

所有Character调用保留请求、返回、transport用量和Turn结果。仅Rulebook接受、action.resolved实际提交且同事务生成Capability Source才计取证。`dialogue-review.json`记录逐条人工阅读；invalid_output不计成功回应，不选择性重试。

两个负控仍保留之前的登记问题于recent上下文。因此旧登记话题侵入不能唯一归因于Recall；同对象认识的多读/少读则由冻结材料直接核实。

## 3. 原 Delivery 与极简 Delivery

| 登记任务，6次/臂 | 原Delivery | 极简Delivery |
| --- | --- | --- |
| 实际读到认识正文 | 0/6 | 6/6 |
| 有效发布中表达牌面冲突 | 0/6 | 6/6 |
| 实际取证 | 6/6，均重复读大厅牌 | 3/6，均询问工作人员 |
| 仅提出核实建议 | 0/6 | 3/6 |
| 失败激活 | 0 | 0 |

极简路径的三条登记认识均引用3条原子证据，实际摘选2条；`complete=false`，本次引用的唯一反证已展示，另一条支持证据未展示。含工作人员发言的支持没有压住正文，仍明确标成reported_speech/未经独立核实。低预算回归另验证证据完全放不下时仍保留正文与反证存在标记。

原路径六次读牌后均推荐203，没有表达旧105信息的分歧。极简路径六次有效发布均使用冲突/差异信息；三次真实询问后也仍保留工作人员“这周没去过”的限定，没有把回忆升级成已确认的实际登记位置。例：raw-evidence样本0询问后说“公告牌信息之前看也有点冲突，有的写一楼105，有的写二楼203”，并保留工作人员记忆限制。

实际取证次数变少不单独说明体验更好或更差。此次改善是认识终于被阅读、角色表达保留冲突，并且部分动作从重读同一牌面改为问人。其余建议没有执行，冲突尚未由新证据消解。raw-evidence极简样本1在询问后的对白仍出现“刚才看了看楼里的公告”；本次仅提交询问，不能把该时间措辞算作新增读牌Source。

负控中，原路径与极简路径各2/6出现实质登记话题侵入。定义为给出登记目的地或重新提出办理登记，而非仅提一下之前注意的文字。两条发生在updated-cognition轨迹，材料与recent都可能影响回应；不能声称极简交付消除了旧话题侵入。

## 4. 6.2：同一极简 Delivery，有/无 JEV

| 刺激 | 有JEV正文实际阅读 | 无JEV正文实际阅读 | 材料是否相同 |
| --- | --- | --- | --- |
| 登记，6次/臂 | 6/6 | 6/6 | 每条轨迹两臂相同 |
| 同对象装饰，3次/臂 | 0/3 | 3/3 | 不同；JEV全部UNRELATED |
| 不同对象设计，3次/臂 | 0/3 | 0/3 | 每条轨迹两臂相同，无目标认识候选 |

登记及不同对象案例的首步请求相同，任何行动差异不能归因于JEV。登记实际询问有JEV2/6、无JEV1/6，均来自raw-evidence轨迹；其余有效发布只建议核实。

有JEV的paired-evidence登记样本0返回Markdown包裹的JSON，原生Turn判为`failed/invalid_output`，没有发布或提交Source。其文本虽然表达了分歧，不能算有效角色回应。因此登记有效表达冲突为有JEV5/6、无JEV6/6，保留失败并未重试。这个协议失败发生于两臂输入相同的案例，不能据此声称JEV导致失败。

同对象装饰三个无JEV样本多读到了旧登记认识；raw-evidence和paired-evidence仍正常评价边框，没有把登记冲突拉进当前话题。updated-cognition两臂都转回登记任务：有JEV问“直接去二楼203吗”，无JEV问“先去一楼105看看，还是直接去二楼203”。同对象实质侵入均1/3。不同对象也均1/3，两臂材料相同；合计负控侵入均2/6。

JEV确实减少了三份无关认识的阅读，但本次没有稳定减少话题侵入，也没有证明它提高登记行动质量。小样本只支持：在这组场景中，无JEV可以由角色自己理解和忽略部分无关认识，体验接近；不足以删除旧实现或承诺所有对象话题都不需要JEV。后续实验把JEV作为可选比较，不增加分类器、关键词拦截或新的筛选模型。

## 5. 调用、用量与等待

| 项目 | 原Delivery | 极简Delivery | 极简+JEV | 极简无JEV |
| --- | --- | --- | --- | --- |
| 首步选择 | 12 | 12 | 12 | 12 |
| Character调用 | 20 | 16 | 15 | 15 |
| prompt_tokens | 56,533 | 49,041 | 45,975 | 46,540 |
| completion_tokens | 1,554 | 1,452 | 1,336 | 1,327 |
| total_tokens，提供商原值 | 70,953 | 65,136 | 60,193 | 61,069 |
| Character激活累计耗时 | 103.342秒 | 98.513秒 | 84.528秒 | 84.520秒 |
| 新JEV准备调用 | 0，共用已存决定 | 0，共用已存决定 | 6 | 0 |

6.2六次JEV调用累计4.012秒，单次约0.600—0.902秒；usage为input_tokens 4,922、output_tokens 270、cost字段0.000206724。cost按提供商原值保留，币种与Character价格未核实，不计算整段费用。无JEV臂省去的是这些判断调用；同对象材料多读带来本次三样本prompt_tokens增加1,052，不能只比较JEV费用。

材料准备与Character激活分开执行，重复样本复用准备。激活耗时也受到真实行动分叉、格式失败及采样影响，不能把两臂累计差值当成在线端到端提速，更不能把一次判断省掉称为免费。

## 6. 验证与有意识接受的限制

`corepack pnpm@11.7.0 check`通过27个文件184项测试。Python极简Delivery5项、候选7项、原反证裁剪5项、原排序4项，共21项通过。极简测试覆盖含发言认识不再被压住、无证据预算仍保留正文、未选认识不可交付、角色/世界/未来Source/伪造引用失败，以及无JEV臂不伪造判断接受。

两组只读审计通过：冻结输入及候选池、主观正文、来源类型、摘选覆盖、确定性交付重放、非Memory请求一致、实际取证Source原子提交。48次首步选择、66次Character调用全部保留，包含1次invalid_output。程序授权与提交边界通过，不等于任意自然语言语义一致性已证明。

接受部分证据未读，但须清楚保留来源、反证存在及不完整标记；不把省略解释为不存在或已解决。认识无法无限堆入预算，正文与标记仍有容量上限。当前仍复用原候选评分与非认识证据投影，不能称为整条Memory链完全简化。

没有修改原复杂Delivery、正式Memory schema、Rulebook、World State或历史试玩目录；没有新增恢复机制。正式网页连续试玩、长历史、多认识竞争、JEV重复稳定性及完整延迟认识行为闭环尚未验证。接下来按6.3比较即时原始证据与已有认识，继续保留真实行动指标，再做6.4；不因表达改善就跳过长期闭环。

## 7. 重跑与文件

新增入口：`minimal_delivery.py`、`minimal_delivery_contrast.py`、`test_minimal_delivery.py`、`audit_minimal_delivery.py`与`tests/experiments/memory-minimal-delivery.ts`。只对共用宿主审计增加本阶段材料/失败结果识别，没有更改角色协议或增加输出修复重试。

```powershell
node --import tsx tests/experiments/memory-minimal-delivery.ts .tmp/delivery-fresh --prepare-delivery
node --import tsx tests/experiments/memory-minimal-delivery.ts .tmp/delivery-fresh --run
.tmp\hindsight-vector-venv\Scripts\python.exe experiments/activity-memory/audit_minimal_delivery.py .tmp/delivery-fresh
node --import tsx tests/experiments/memory-minimal-delivery.ts .tmp/jev-fresh --prepare-jev
node --import tsx tests/experiments/memory-minimal-delivery.ts .tmp/jev-fresh --run
.tmp\hindsight-vector-venv\Scripts\python.exe experiments/activity-memory/audit_minimal_delivery.py .tmp/jev-fresh
```

每次使用新目录，默认复用6.1 v2；可用第四个CLI参数指定另一份符合结构的冻结候选实验。`HCW_DELIVERY_SAMPLES=1..3`只控制登记重复数，负控各一次。JEV准备使用现有凭证配置，Character使用现有本机网关，不输出或持久化凭证。审计不调用提供商；两组逐样本结果、失败和人工检查在对应`audit.json`、`dialogue-review.json`中。
