# ADR-0075：Session 死信序号连续性

- 状态：Accepted
- 日期：2026-08-29
- Extends：ADR-0027
- 上位契约：[Phase 8.1 加固规格 §4](../spec/phase-8.1-hardening-v0.1.md#4-session-死信连续性)

## 背景

发送端首次领取 Outbox 时永久分配连续 `sessionDeliverySeq`，消费端只接受 cursor+1。`v0.3.0` 只让 critical dead letter 阻塞后续领取；非关键序号 N 死信后，N+1 会被领取并被消费端以乱序拒绝，最终形成无意义的级联死信。

## 决定

1. 已分配 Session 序号的 Outbox 位置不可跳过。任何较早 dead letter 都阻塞同 Session 的较晚项，不区分 critical。
2. 人工 retry 保留原序号和内容绑定，成功后 FIFO 才继续。
3. Phase 8.1 不提供 skip、自动 tombstone 或伪 Observation。若未来需要明确放弃非关键投递，必须新增带消费端原子语义的协议和 superseding ADR。
4. `critical` 继续控制 Branch 归档等行政严重度，不再参与 Session FIFO 连续性的判断。

## 后果

单条非关键失败会让该 Session 明确停在可恢复位置，而不会污染后续消息。其他 Session 仍可并行运行，世界提交不回滚。

## 验证

测试覆盖非关键死信、后续关键/非关键项、多 Worker、重启、手工 retry、原 seq 复用和最终连续 cursor。

