# 交互抽象 I2-c 模型与 Host 同源 Schema 实施记录

| 属性 | 值 |
|---|---|
| 日期 | 2026-09-13 |
| 工作树 / 分支 | harness-cordis-world-v0-merged / fix/step-cue-normalization |
| 上位规格 | [交互定义实施契约](../../spec/interaction-definition-v0.1.md) §2、§6.2 |
| 方案 | [交互抽象 V0.2](2026-09-13_方案-交互抽象与按需交互包-v0.2-report.md) §10.1 |
| 实施基线 | I2-b `0291055` |
| 状态 | I2 的**模型/Host 同源 Schema**部分落地；表现与持续可见状态契约仍未接入 |

## 1. 本轮实现

| 模块 | 实现 |
|---|---|
| [contracts/interaction-schema.ts](../../../packages/contracts/src/interaction-schema.ts) | `createInteractionArgumentSchema()`、`createInteractionRequestSchema()` |

两个函数都住在 contracts，只读已经冻结的结构：`createInteractionArgumentSchema` 读定义的 `argumentSchema`，`createInteractionRequestSchema` 读 I2-b 产出的 `InteractionCharacterView`。没有第二份真相——Host 校验器与这两个构造器读的是同一个对象。

## 2. 两个关键性质

**配对是精确的，笛卡尔积在 Schema 层就不合法。** `createInteractionRequestSchema` 把视图里每一个选项变成一条 `anyOf` 分支，分支内 `targetRef`、`bindingId`、`definitionRef`、`arguments` 都是 `const`。因此"对的物品配别人的绑定和定义"这种组合不是被劝阻，而是**没有任何分支能匹配**。规格 §6.2 禁止"把各字段独立 enum 后允许任意笛卡尔积"，这里是用构造方式排除了它。

**保证方向是单向的，且方向是安全的那一侧。** Host 接受 ⟹ Schema 接受，这一条永远成立。反过来不成立，唯一原因是自由字符串：Host 按 UTF-8 字节限长，JSON Schema 的 `maxLength` 数的是码点，所以 `maxLength` 取字节上界——这是宽松的一侧。枚举值两侧精确相等。这个残差与仓库里既有的"schema 接受 ⟹ host 接受"不变式形状一致，只是方向相反且更弱，我在记录里写明了而不是含糊过去。

视图为空时返回 `{ not: {} }`，即"什么都接受不了"——这是"这个角色此刻无可尝试"的诚实翻译，而不是一个碰巧宽松的空 Schema。

## 3. 一致性测试抓到的真实缺陷

第一版把 `type`、`required`、`additionalProperties: false` 都放在顶层，但顶层没有配对的 `properties`（我只在 `anyOf` 分支里写了 `properties`），于是顶层那条 `additionalProperties: false` **把一切都否掉了**——每一个选项都校验失败。

这个错误不会被类型系统发现，也不会被"能编译"发现。它正是同源一致性测试存在的理由：测试断言"视图里每个选项都必须通过自己的 Schema"，第一次运行就把它顶出来了。修法是让分支自足，顶层只留 `anyOf`。已在实现注释里写清楚为什么不给顶层再加一份 `properties`。

## 4. 验证范围

五组新增断言（`view.test.ts` 内，总计 17 项）：

- 视图里每一个选项都通过 `createInteractionRequestSchema`；"对的目标 + 别人的 binding/definition"、错误的 targetRef、多余参数、缺字段全部不通过。
- 视图未提供的参数值（`character:mallory`）不通过；`give` 的 `arguments` 不能为空。
- 视图无选项时 Schema 拒绝一切。
- **字段扫掠**：enum × boolean × integer 三字段的十个候选对象逐一对比 `parameters()` 与派生 Schema，断言"Host 接受 ⟹ Schema 接受"，并断言扫掠确实两侧都有命中（否则该测试不构成证据）。
- 自由字符串的方向性：四个中文字符（12 字节）被 Schema 接受但被 Host 拒绝，而 Host 接受的 `abcd` 一定被 Schema 接受。

## 5. 仍未接入的部分

| 规格条款 | 状态 |
|---|---|
| §5 表现与持续可见状态契约（新版表现绑定、状态来源校验） | **未接入** |
| §6.2 退出选项优先保留与容量失败 | 未接入（需 I3 的 `end-contact` 提供恢复类入口） |
| `interact@2` / `submit_actions/v6` 协议接线 | 未接入，属 I3/I4 |
| Manifest v10 绑定与生产入口 | 未接入 |

**I2 Gate 仍未关闭**：本轮让"模型/Host 同源 Schema"成立，但"表现不能虚构持有/接触/支撑"与"持续可见状态单一来源"仍没有新的实现落点。

关于表现那一条需要说明一点：就**交互路径**而言，"不能虚构持有/支撑"在结构上已经成立——事件只能由已注册效果产生，`effectCapabilityRefs` 与 `effect.eventTypes` 闭合了可产生的事件类型，表现字段根本不参与事件构造。I2 真正缺的是把**表现绑定到交互步骤**的那份声明（`performancePolicyRef`：哪些 cue、放在 independent 还是 onSuccess、声音绑 speak、步态绑 move）。它要和 I3 的关系定义一起定义才有意义，因为首批五个动作里没有一个是"带表现接触"的。

## 6. Evidence → Finding → Path

E1：规格 §2 要求"模型 Schema 与 Host 验证从同一结构派生"。F1：两份独立实现会漂移，且漂移只在"模型能提交、Host 拒绝"时暴露。P1：两个构造器与校验器读同一个冻结对象，并用扫掠测试钉住方向。
E2：规格 §6.2 禁止独立 enum 的笛卡尔积。F2：独立枚举会让模型看到计划必然拒绝的组合。P2：每个选项一条 `const` 分支。
E3：自由字符串的字节/码点差异无法在 JSON Schema 里精确表达。F3：若取码点上界，Schema 会比 Host 更严，破坏"Host 接受 ⟹ Schema 接受"。P3：取字节上界（宽松侧），并把这个残差写进测试与记录。
E4：顶层 `additionalProperties: false` 缺配对 `properties` 会静默否掉一切。F4：类型系统与编译都无法发现。P4：由一致性测试断言"每个选项必须通过"，已在首次运行中抓到并修复。

## 7. 工程验收结果

`corepack pnpm@11.7.0 check` 退出码 0。全量逐文件 statements/branches/functions/lines 均 100%。
报告合计 statements 12117/12117、branches 8516/8516、functions 2396/2396、lines 10327/10327。
既有 P0～P6、性能三项、子进程硬终止 49 项均通过；I1 八项跨包测试与 I2-b 十二项视图测试未改一行即通过；原编译黄金与 I0-B 运行期黄金原样通过，未使用 `--update`。
lint 仅剩既有 `grouped-runtime.test.ts:25` 的 optional chaining warning。
未调用真实模型；本轮无新增持久化窗口。
