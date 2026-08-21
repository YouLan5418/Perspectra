# ADR-0025：Canonical World JSON 和 Hash Envelope

- 状态：Accepted
- 日期：2026-08-22
- 上位契约：[实施规格 §10](../spec/implementation-v0.2.md#10-canonical-jsonhash-与版本)

## 决策

`world-json/v1` 只允许 null、boolean、合法 Unicode string、safe integer、数组和普通对象。对象键按 UTF-16 code unit 排序，数组保序，UTF-8 无 BOM、无空白，不进行 Unicode 规范化。所有 Hash 都包含 kind、hashVersion 和完整值 Envelope，使用小写 `sha256:` 前缀。

## 结果

禁止小数、负零、NaN、Infinity、BigInt、特殊对象、访问器、Symbol、稀疏数组、循环和孤立代理项。Phase 0 由 `canonicalizeWorldJson`、`hashWorldJson` 和跨平台 Golden Fixture 执行该决定。
