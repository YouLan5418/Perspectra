# ADR-0034：Event、Action、Projection 与 Rule Registry

- 状态：Accepted
- 日期：2026-08-22
- 上位契约：[实施规格 D-024](../spec/implementation-v0.2.md#2-最终决策索引)

## 决策

每个 Compiled Manifest 包含闭合的 Event、Action、Projection 和 Rule Registry。Definition 以 name、正整数 version 和 schemaHash 精确标识；启动期注册，Manifest 锁定后冻结。未知名称、未知版本、重复定义或运行时追加一律 fail-closed。

## 结果

Phase 0 的 `VersionedRegistry` 输出稳定排序 Manifest 和域隔离 Hash。Registry 不提供最近版本回退，也不接受执行函数进入 Hash 数据。
