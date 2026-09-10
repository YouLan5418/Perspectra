# ADR-0086：对象声明的物品交互

- 状态：Accepted（用户授权第一阶段实施；工程验收另记）
- 日期：2026-09-10
- Supersedes（局部）：ADR-0085 的新世界 take 顶层动作词汇
- Extends：ADR-0085；历史 Manifest 和协议不改写

## 决定

1. Manifest v8 显式绑定 object-interactions/v1 目录；submit_actions/v5 使用 speak、move、interact，最多一次发言和一次世界操作。v7/v4 保持 speak、move、take。
2. 目录分为 definitions 与实体 bindings。创作者声明 interactionId、label 和确定性 operation；首版 operation 为 take/drop/give。自定义 ID 可以复用这些操作，但不能通过文案增加效果、跳过前置条件或控制其他角色。通用条件/效果组合 DSL 与规则插件注册另行版本化，不在首版伪装为已支持。
3. interact 参数为 targetId、interactionId、arguments；give 的 arguments 唯一字段为 recipientId，其他操作为空对象。交互指提案，不是创作者直接声明世界事件。
4. take 需要物品无人持有且同地点；drop/give 需要行动者持有物品；give 还需不同的 active 角色同地点。给物只改变持有关系，不表示对方同意、承诺或作出身体反应。
5. 成功产生 entity.transferred，携带完整前后持有/地点状态；重建严格核对前缀。失败只给行动者反馈。每个交互仅一次持有状态迁移，不能封装移动与多个世界操作。
6. Context 枚举当前可尝试的目标与交互参数；仅包括同地点无人持有的物品和自己持有的物品。give 收件候选再按当前 Scene 可见角色裁剪。执行时在最新候选事件前缀重新验证，Context 选项不是授权票据。
7. 目录通过新世界激活参数提供，规范化后纳入 specHash/ManifestHash；已激活世界不读取可变外部文件。旧 Pack 文件与 Hash 不变。
8. Reaction 保持现有动作与调用预算，闭合动作集合新增 v8 对应版本；SQL 无新列，既有 JSON 字段保存精确集合。恢复必须与 Manifest 匹配。

## 非目标与后续

角色握手、递物邀请等请求/接受/拒绝协议属于第二阶段，不在事务或行动组内等待模型。状态开关、消耗品、创作者条件/效果 DSL 需增加明确验证器后再开放。

## Evidence → Finding → Path

原规则只能 take，持有关系没有完整循环。以同一物品 take → give → drop → take、竞争、过期选项、上下文裁剪与恢复测试验证新交互入口；验收前保留实施中状态。
