# ADR-0030：本地 Principal、WorldAddress 与最小权限

- 状态：Accepted
- 日期：2026-08-22
- 上位契约：[实施规格 §15](../spec/implementation-v0.2.md#15-安全权限secret-与内容策略)

## 决策

V0 是本机、单租户、单可信操作员系统。所有入口显式携带品牌化 `tenantId + worldId + branchId`，不得依赖环境中的当前世界。Character Agent Handle 固化 WorldAddress 和 characterId，不能指定其他 actor 或直接读取 WorldStore。

## 结果

Phase 0 的 Store、Runtime 和 Simulation API 均要求完整 WorldAddress。远程监听、认证、多用户协作和 Plugin 沙箱不在 V0 范围；未来开放网络前必须新建认证 ADR。
