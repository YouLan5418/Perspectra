# ADR-0032：Model Profile、Budget Reservation 与降级

- 状态：Accepted
- 日期：2026-08-22
- 上位契约：[实施规格 §14](../spec/implementation-v0.2.md#14-directorprovider-与模型预算)

## 决策

模型配置通过不可变 Model Profile 引用；每轮按稳定参与者顺序预留预算，再允许并行调用。超时、失败或预算耗尽只使对应参与者 unavailable 或触发确定性降级，不阻塞玩家 Round。历史重放不调用模型。

## 结果

Phase 0 禁止模型和网络，只实现可替换 Provider 及完全无模型闭环。Harness LLM Bridge、Token 计量和 LLM Replay 必须在 Phase 3 通过独立契约测试后接入。
