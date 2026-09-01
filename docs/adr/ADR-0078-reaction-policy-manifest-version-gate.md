# ADR-0078：Reaction Policy 的 Manifest 版本门

- 状态：Accepted
- 日期：2026-09-01
- 上位目标：[Phase 9 实施规格](../spec/phase-9-implementation-v0.1.md)
- Extends：ADR-0026、ADR-0042、ADR-0054、ADR-0067、ADR-0077
- Supersedes（局部）：任何通过可选字段扩展 Manifest v1～v4、并据此开启自主反应的实现设想

> **兼容警告：** Manifest v1～v4 的字节、Hash 与运行语义保持冻结；即使外部对象额外携带同名字段，也不得启用 Reaction Cycle。自主反应只能由 Manifest v5 的必填 `reactionPolicy` 明确开启。

## 背景

ADR-0077 已决定旧 Manifest 和缺少策略字段的 World 一律解释为 `disabled`，但尚未冻结策略进入编译契约的版本方式。把 `reactionPolicy` 作为 Manifest v4 的可选扩展会产生两类问题：同一版本出现两种形状，且旧世界可能在重新读取或重新编译时被隐式赋予新行为。

Phase 9B 需要先建立能力门，再创建 Root Round 派生 Cycle。能力门必须能同时回答：运行时是否允许反应、策略限额来自哪里，以及旧世界的 Hash 是否仍保持逐字节全等。

## 决定

1. 新增 Manifest v5。其余字段继承 Manifest v4，另有必填的 `reactionPolicy`：

   ```ts
   type ReactionPolicyV1 =
     | { version: 'reaction-policy/v1'; mode: 'disabled' }
     | {
         version: 'reaction-policy/v1';
         mode: 'responsive';
         profile: 'responsive/v1';
       }
   ```

2. Manifest v1～v4 的有效策略恒为 `disabled`。运行时兼容视图可以返回这一解释，但不得修改存储字节、Manifest Hash、Genesis 或既有 World Pack 编译结果。
3. Manifest v5 必须精确校验 `reactionPolicy` 的字段集合和值。缺字段、未知字段、未知版本、未知模式或未知 profile 全部 fail-closed；不得回退到默认策略。
4. `responsive/v1` 的具体限额继续由 ADR-0077 和 Phase 9 规格冻结，不在 Manifest 内接受创作者自定义数字：最多 3 waves、8 次 NPC 调用、每角色 2 次、每次至多一个 `speak@1`。
5. `worldpack-source/v2`、`worldpack/v2` 与 Manifest v4 永久保持原输出。创作者启用自主反应必须使用后续显式版本化的 World Pack 来源/编译契约；不得给 v2 加可选字段。
6. 在 Manifest v5 的正式创作者编译入口完成前，生产组合根不得通过测试夹具、环境变量或应用默认值开启自主反应。

## 结果

- v0.3.0 及更早世界不会因升级宿主而开始自行行动。
- 能力判断只依赖耐久、Hash 锁定的 Manifest，不依赖进程配置或调用方约定。
- 新 World Pack 版本需要承担一次显式迁移成本，但避免污染已经发布的 v2 契约。
- P9B 后续可以把“创建 Cycle”写成简单的 fail-closed 分支：只有精确的 Manifest v5 `responsive/v1` 才进入该路径。

## 证据链

### Evidence

- E-001：`runtimeManifestFromStored` 当前只接受 Manifest v1～v4，World Pack v2 编译器固定输出 Manifest v4。
- E-002：ADR-0077 与 Phase 9 规格均要求旧 Manifest/缺字段 World 解释为 `disabled`，且策略必须锁入 Manifest。

### Finding

- F-001：在 Manifest v4 上增加可选字段会造成已发布格式的静默扩展，无法同时满足显式能力门和旧 Hash/语义冻结。

### Path

1. 先让运行时识别并严格校验 Manifest v5；
2. 再新增显式 World Pack 编译版本产生 v5；
3. 最后才允许 Root Round 事务按该策略创建 Cycle。
