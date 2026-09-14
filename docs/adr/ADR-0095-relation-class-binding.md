# ADR-0095：关系目标按类绑定

- 状态：Accepted（用户于 2026-09-14 在三个候选解法中选择案一）
- 日期：2026-09-14
- Extends：[ADR-0093](ADR-0093-interaction-definition-abstraction.md)
- 局部细化：[ADR-0093](ADR-0093-interaction-definition-abstraction.md) 引入的 `InteractionBindingV3` 对 `kind: 'relation'` 的目标语义
- 上位规格：[交互定义实施契约 §2](../spec/interaction-definition-v0.1.md)

## 背景

首批五类动作里的 `base:end-contact` 以**关系实例**为主目标：

```ts
const contactRole: InteractionRole = { name: 'contact', kind: 'relation', source: { kind: 'primaryTarget' } }
```

运行时的绑定匹配是精确匹配——请求的 `targetRef` 必须与该绑定的 `targetRef` 完全一致。所以"解除一条关系"必须有一条指名它的绑定。

但关系实例的身份是**运行期派生**的：`deterministicId('relation', { address, sourceActionId, relationKind, initiatorId, targetId })`。静态 Manifest 不可能预先枚举实例 id，而编译/作者路径的绑定来源只有 `entities[].interactionBindings` 与 `characters[].interactionBindings`。两者合起来意味着：**这个定义在当前绑定模型里根本无法被作者绑定**。

I3-a 验证 `end-contact` 时用的是手工构造的选择，测试自己发明了 `relation:held` 这个 id，所以"绑定关系目标"看起来是通的。被验证的命题是"给定一条指名绑定，解除成立"，而不是"世界能声明出这条绑定"——可达性从未被检查。

## 提议决定

`kind: 'relation'` 的绑定的 `targetRef.id` **命名一个类，不命名实例**：它是有权被解绑的、由某个定义创建的活跃关系集合。

1. 绑定的 `targetRef.id` 必须是**本世界已启用的定义 id**。
2. 该定义的效果必须声明 `character.relation-started`；否则这根绑定永远寻址不到任何东西，属于激活完整性错误。
3. 请求仍带具体实例 id。匹配规则为：请求的 `targetRef.kind` 必须是 `relation`，且该实例在宿主快照中的 `interactionId` 必须等于绑定声明的类。
4. 类是从**宿主候选快照**读取的事实，不是请求能声称的东西。伪造的实例 id 没有任何类可归属，因此无法借用别的绑定。
5. 视图按"该类的每个已授权活跃实例"各枚举一次选项，选项里的 `targetRef` 是**实例**，不是类。

## 后果与替代方案

- 与规格 §2 的表格一致：`contact` 仍是主目标。
- 与 I3 收尾的处理器作用域**语义相同**：那里已经用"创建它的定义 id"作为关系实例的范围键（`consumes`）。本决定只是把同一层寻址补到绑定上。
- 不需要新定义版本，不需要改事件、角色或效果语义。
- 代价：`InteractionBindingV3` 对 `relation` 的 `id` 含义发生变化，`registry.ts` 的精确匹配规则对关系目标放宽为"实例属于类"。这是**冻结契约的语义变更**，因此单独记录在本 ADR，而不是顺手改在实现里。

**被否决的替代方案：**

- 把 `end-contact` 改成角色主目标 + 派生关系（`base:end-contact@2`）。它绕开了匹配规则，但与规格 §2 的表格冲突，且"解除"的地址从关系变成人，与 `contact:end-on-move` 的按实例收尾不再同构。
- v10 首批不含 `end-contact`。它不动任何契约，但会让 I3 Gate 的"目标可同轮解除"在新路径上永久打折，且是**对外可见的功能缺口**，不是内部欠账。

## 验证边界

- 编译期：`compileInteractionCatalog` 拒绝未启用的类；`validateInteractionTargets` 拒绝目录里没有的类 id。
- 存储期：v10 的 `runtimeManifestFromStored` 对类 id 做同一判据的失败关闭重读。
- 激活期：`freeze()` 拒绝未启用的类，以及不产生关系的类。
- 裁定期：不同类的实例经该绑定请求时抛出；视图只枚举被授权且活跃的实例。
- 端到端：作者源声明 `relationBindings` → 编译 → `freeze()` → 用同一份字节解除一条 `base:hold-hand` 建立的关系。

本决定不改变"关系身份由 World、来源 Action、定义锁与双方派生"（I3-a）与"不得由 Kernel 识别 `hand_hold`"（规格 §4）两条既有约束。
