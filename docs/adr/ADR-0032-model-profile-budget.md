# ADR-0032：Model Profile、Budget Reservation 与降级

- 状态：Accepted
- 日期：2026-08-22
- 上位契约：[实施规格 §14](../spec/implementation-v0.2.md#14-directorprovider-与模型预算)

## 决策

模型配置通过不可变 Model Profile 引用；每轮按稳定参与者顺序预留预算，再允许并行调用。超时、失败或预算耗尽只使对应参与者 unavailable 或触发确定性降级，不阻塞玩家 Round。历史重放不调用模型。

## 结果

Phase 3 已实现版本化 Model Profile、调用前稳定 Token 预留、失败/超时/预算耗尽降级、Harness 端口契约和本地 Model Replay。实际 Harness Bridge 仍默认禁用；无模型玩家路径不依赖任何 Provider。
