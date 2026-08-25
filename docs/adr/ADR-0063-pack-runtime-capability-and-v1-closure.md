# ADR-0063：Pack 运行能力与 v1 格式收口

- 状态：Accepted
- 日期：2026-08-25
- Extends：ADR-0054、ADR-0060、ADR-0061
- Supersedes：ADR-0062 中以 Manifest `schemaVersion` 选择公开对白行为的实现方式
- 上位契约：[Phase 7 实施规格](../spec/phase-7-implementation-v0.2.md)

## 背景

Phase 7 首轮实现把 Pack 公开对白观察行为隐式绑定到 Manifest schema v3，并在同一候选开发周期内给 `worldpack/v1` 增加了通用实体字段。独立审查同时发现：存量 Pack Manifest 只做浅校验，激活路径没有返回规格约定的版本分歧错误，CLI 进程入口还会丢失结构化诊断。

这些问题不会放宽世界事实、Hash 或认知隔离，但如果在 `v0.2.0` Tag 前不收口，数据格式版本与运行行为会继续耦合，创作者也无法获得稳定的错误契约。

## 决定

1. `worldpack-source/v1` 与 `worldpack/v1` 在 `v0.2.0` Tag 前完成字段收口；当前必填字段集合包含显式 `entities`。Tag 后再增加必填字段必须发布新格式版本，不能继续扩展 v1。
2. Pack Manifest v3 的 `contentPack` 必须声明 `runtimeCapabilities.publicSpeechObservationVersion: 1`。公开对白观察由该能力选择，不再由 Manifest schema 版本本身选择。
3. 读取存量 Manifest v3 时深度校验 Compiler 身份、Canonical 版本、插件锁及 Hash、运行能力、Presentation 与初始事实。未知字段、错误 Hash 或不支持的能力全部 fail-closed。
4. 激活同一 `packId + packVersion` 且 `packHash` 不同的制品时，必须在写入前返回 `PACK_VERSION_DIVERGED`；不得仅依赖 Store 的通用幂等冲突兜底。
5. 创作者 CLI 统一输出 Canonical `ErrorEnvelope`：保留 `WorldError`，把 Pack 诊断映射为专用错误码，并隐藏意外异常的内部路径。
6. `PLUGIN_NOT_REGISTERED` 与 `REGISTRY_HASH_MISMATCH` 是实际可达的 Pack 诊断，不再只存在于规格文字。

## 兼容

- `v0.1.0`、旧 Manifest v1/v2、悬疑 v3/v4 Event、Authority 与 Golden bytes 不变。
- 本 ADR 收口的是尚未创建 `v0.2.0` Tag 的 Phase 7 Pack 候选格式；不承诺打开审查修复前生成、但从未发布的 Manifest v3 临时制品。
- Pack 作者内容版本、Compiler 实现版本、项目版本、来源格式版本和 Manifest schema 继续使用彼此独立的版本轴。

## 后果

- 新行为能力可以在将来的 Manifest schema 中延续或升级，不会因数据结构升级而被意外开启。
- 创作者能区分来源错误、插件缺失、Registry Hash 分歧和已激活 Pack 的内容分歧。
- `worldpack/v1` 在 `v0.2.0` 发布后成为真正可冻结的输入/制品契约。

## 验证

- 激活测试覆盖同 id/version 异 Hash，并断言 `PACK_VERSION_DIVERGED`。
- Manifest 测试覆盖全部嵌套对象、Hash、重复项和能力版本的 fail-closed 分支。
- CLI 测试覆盖 Pack 诊断、`WorldError`、用法错误和未知内部错误，未知错误不得泄漏本机路径。
- 酒馆 E2E 继续证明公开对白进入同 Scene 角色 Observation/Memory；旧 v1/v2 与悬疑 Golden 回归不变。
