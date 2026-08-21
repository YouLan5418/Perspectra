# ADR-0026：WorldSpec、Compiled Manifest 与 Genesis

- 状态：Accepted
- 日期：2026-08-22
- 上位契约：[实施规格 §9](../spec/implementation-v0.2.md#9-worldspecmanifest-与-genesis)

## 决策

声明式 WorldSpec 必须先经严格 Schema、引用、插件 allowlist 和精确版本解析，编译为冻结的 CompiledWorldManifest，再生成稳定 GenesisPlan。运行时只执行 Manifest，不重新解释 WorldSpec。Genesis 是 Tick 0 的单一行政事务并以 activationKey/specHash 幂等。

## 结果

Phase 0 只实现 Manifest 所需的 Canonical、Hash 和 Registry 契约，不实现 WorldSpec Compiler 或正式 Genesis。后续实现不能把 Secret、函数、脚本或任意绝对路径放入 WorldSpec。
