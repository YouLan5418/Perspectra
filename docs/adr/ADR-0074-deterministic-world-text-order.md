# ADR-0074：确定性世界文本顺序

- 状态：Accepted
- 日期：2026-08-29
- Extends：ADR-0025
- 上位契约：[Phase 8.1 加固规格 §3](../spec/phase-8.1-hardening-v0.1.md#3-确定性排序)

## 背景

`world-json/v1` 已冻结 UTF-16 code unit 对象键顺序，但部分领域数组和执行顺序仍使用 `localeCompare`。该函数依赖宿主 Locale/ICU，可能令相同非 ASCII 输入在不同 Node 或操作系统上形成不同 Manifest、Projection、Context、Authority 或 Hash。

## 决定

1. Contracts 导出唯一的纯 UTF-16 code unit 字符串比较器；其顺序与 JavaScript 关系比较及 Canonical JSON 对象键顺序一致。
2. 所有影响稳定数组、执行次序、派生状态或 Hash 的生产排序必须使用该比较器；禁止 `localeCompare`。
3. 不做 Unicode normalization，不使用自然语言、拼音或语言学 Collation。
4. 已激活数据库和历史 Hash 不重写。ASCII 兼容 Golden 必须全等；非 ASCII 新计算从本 ADR 起获得唯一顺序。

## 后果

确定性不再依赖操作系统区域设置或 ICU 版本。面向人的本地化展示排序如果未来需要，必须在非权威 Presentation 层单独实现，不能复用为世界顺序。

## 验证

Contracts Golden 覆盖 ASCII、中文、组合字符、全角字符、代理对和未规范化等价文本；仓库生产 TypeScript 中 `localeCompare(` 必须为零。

