# ADR-0066：Scene v2、动作时刻观察与限域 Director

- 状态：Accepted
- 日期：2026-08-26
- Extends：ADR-0051、ADR-0056
- Supersedes：ADR-0056 中“PlayerSlot 必须恰有一个 focal active Scene”的绝对约束，改为 Round 边界允许零或一个；同时把 Scenario/Player Objective 的实现时点推迟到 Phase 9 或独立规格
- 上位契约：[Phase 8 实施规格 §7～8、§11](../spec/phase-8-implementation-v0.1.md#7-scene-decision-v2)

## 背景

现有单 focal Scene 足以运行酒馆，但无法表达角色暂时离场、队伍分开或多个静止背景 Scene。仅按 Location 生成观察也无法表达同地私聊。Director 若拥有作者真相并直接生成 NPC 对白，会绕过角色自己的知识和 Memory，把全知信息借 NPC 的嘴泄漏。

## 决定

1. SceneInstance 使用 created→active→closed 的不可逆生命周期和耐久 member join/leave Event。Scene 与 Location 分离；World 可有多个 active Scene，同一 Character 最多属于一个 active Scene。
2. Player Character 在 Round 边界可以属于零或一个 active Scene；多个是 Projection invariant 并 quarantine。零 Scene 时不调度 NPC/Director，只允许当前 Affordance 中的 self/environment/move 类行动。
3. `SceneDecisionService` 在固定 baseHeadSeq 计算 focal Scene、成员、可调度 NPC/Director、Visibility Policy 和 decision hash。非 focal Scene 在 AUTONOMY_OFF 下不自动推进。
4. 参与者集合在 Round 开始时冻结。中途离场者保留已形成 Proposal，但离场后不观察后续 Action；中途加入者可观察加入后的事件，下一轮才参与 Agent 调用。
5. Observation 在每个 Action 裁定时按当前事件前缀计算。Rulebook 给出 scene_public/direct/private/self 最大范围，Scene Policy 只能收窄。不同 observer 可获得不同内容；私语旁观者至多知道私语发生。
6. Utterance、per-observer Communication Observation 和 SubjectiveClaim 分层。撤回追加新 Utterance，不改写旧发言；“说 P”不证明 P。
7. Director 每次只绑定一个 focal active Scene。它只能看到 public/director_visible 内容和无私密正文的粗粒度 Dramatic Signals，不读取角色 raw Memory、private cognition、其他 Scene 或 author_only。
8. Director 只调用一次 `submit_director_plan`，输出注册 Environment Proposal 或抽象 Directive。Directive target 必须已在接收角色授权 Context 中；Director 不能直接生成 NPC 对白、修改心理/Memory 或引入自由事实。
9. Directive 只是低权重建议；NPC 仍从自己的 Character Context 通过 `submit_actions` 决定是否响应。Director 失败降级 Noop/Rule，不阻止玩家 Round。
10. Phase 8 只实现 CharacterGoal。ScenarioObjective、PlayerObjective 的类型边界继续有效，但本阶段不创建运行表、RPC 或伪实现。

## 后果

- Scene 成为调度、观察和当前上下文的统一派生边界，而 Location 继续只表达物理位置。
- 角色可离开或重新加入互动，不会因此丢失 Memory，也不会在不在场时继续收到内容。
- Director 可帮助节奏但不能成为全知 NPC 代写器或作者秘密后门。
- 无 Scene 状态可用于过渡和孤立行动，不需要为短暂空场景伪造成员。

## 验证

- created/active/closed、分场、合流、离场、零 Scene、同轮转移、restart 和 fork as-of 全覆盖。
- 同一角色多个 active Scene 触发 `SCENE_MEMBERSHIP_INVARIANT`；旧 Scene policy v1 原字节运行。
- action-moment observer 集随事件前缀变化，私语正文、不可见动作和离场后事件不泄漏。
- Director author/private/future/other-scene canary 不进入请求；非法 Directive 被拒绝，NPC 请求只包含已授权抽象建议。
