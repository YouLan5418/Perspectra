# ADR-0050：Rulebook 注册与悬疑试金石边界

- 状态：Accepted
- 日期：2026-08-23
- Supersedes：ADR-0048、ADR-0049 中把调查 Resolver 作为 Kernel 内建语义的部分
- Extends：ADR-0026、ADR-0034、ADR-0039、ADR-0049

## 背景

悬疑 Demo 的目的，是以秘密、不同观察与来源化记忆验证角色认知隔离；它不是产品唯一玩法。把 `inspect`、`ask`、`present_evidence`、`accuse` 及结案规则直接放入 Kernel，会让验收场景反向定义通用世界运行时，并阻碍其他题材组合自己的规则。

v3/v4 Manifest、Registry、Genesis 和已提交 Event 已是冻结权威，不能因代码归属变化而重解释。

## 决定

1. Kernel 提供精确版本匹配的 `RulebookRegistry` 与 `RulebookResolver`。通用组合根只注册 v1/v2 的 `speak`、`move`、`take`。
2. 悬疑组合根显式注册 v3/v4 Resolver；调查裁定实现、证据状态和结案规则属于 Demo 层。通用动作继续委托 Core 语义。
3. Manifest 的 Event/Action/Rule Registry、v3/v4 Genesis 作者种子及 Hash 算法仍由 `world-spec` 冻结；搬迁不更名、不升版、不改变排序。
4. 精确 Resolver 缺失时，在 Writer Lease 获取或 Round 受理前返回非重试 `RULEBOOK_NOT_REGISTERED`；禁止回落到默认规则。
5. v3 存量世界在悬疑组合根内继续运行、fork、archive 和 quarantine recovery；v3 的新激活被拒绝。v4 仅允许在显式注册调查 Resolver 的组合根中新激活。
6. 搬迁前冻结 v3/v4 Resolution canonical bytes/hash，以及 v4 完整 Event Hash、Bundle Hash、Authority Hash、Manifest/Registry Hash；搬迁后 expected 不得随实现更新。

## 后果

- Kernel 恢复为题材无关的确定性裁定宿主。
- 悬疑仍是认知隔离的高强度验收场景，而不是默认产品语义。
- 新题材可使用同一个正式注册边界组合 Resolver，不需要修改 Kernel。
- 通用宿主误开悬疑世界会明确失败，不会以错误规则继续写世界事实。

## 验证

- Core Registry 只解析 v1/v2；悬疑 Registry 精确解析 v3/v4，重复注册失败。
- 通用 `WorldApplication` 挂载 v4 返回 `RULEBOOK_NOT_REGISTERED` 且不取得 Writer Lease。
- 搬迁前后 Golden 全等。
- v3/v4 存量世界覆盖提交、fork 后继续提交、archive、quarantine recovery。

## 生命周期兼容矩阵

| 世界/组合根 | 新激活 | 挂载与提交 | fork 子分支 | archive | quarantine recover |
|---|---:|---:|---:|---:|---:|
| v3 / 悬疑组合根 | 拒绝 | 允许 | 允许 | 允许 | 允许 |
| v4 / 悬疑组合根 | 允许 | 允许 | 允许 | 允许 | 允许 |
| v3 或 v4 / 通用组合根 | 不适用或拒绝 | `RULEBOOK_NOT_REGISTERED` | 不取得 Writer Lease | 不取得 Writer Lease | 不取得 Writer Lease |

v3 禁止项按 `builtin:speak-move@3` 精确匹配，不占用其他创作者将来可能使用的版本号。`WorldApplication` 与低层 `WorldBootstrap` 都执行同一新激活屏障；测试中的存量 v3 数据由冻结的低层历史 Fixture 构造，不通过当前激活入口绕过该决定。
