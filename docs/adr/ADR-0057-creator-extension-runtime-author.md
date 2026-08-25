# ADR-0057：创作者 Action 扩展、插件锁与 Runtime Author

- 状态：Accepted
- 日期：2026-08-25
- Extends：ADR-0026、ADR-0030、ADR-0034、ADR-0050
- 上位契约：[通用内容架构总纲 §9](../spec/general-content-architecture-v0.1.md#9-action插件与创作者扩展)、[§11](../spec/general-content-architecture-v0.1.md#11-runtime-author)

## 背景

创作者需要题材动作、解释器短语和运行中导演能力，但允许 Pack 编写脚本、任意 guard/effect 或直接发 Event，会让不受信任内容绕过 Registry、Rulebook、权限和审计。另一方面，把所有新动作都要求改 Kernel，会再次产生悬疑玩法侵入 Kernel 的问题。

## 决定

1. Pack 可启用已注册 Action，定义 alias、固定参数、解释器短语、Presentation 模板、Character capability 和 Scene affordance filter；最终 Action 始终是精确注册的 type/version。
2. 新硬语义由 Host 安装的受信任插件完整提供 Schema、Validator、Capability、Affordance、Resolver、Event Registry、Reducer、Observation policy 和 Presentation input schema。
3. Pack 锁定 plugin id、精确 SemVer 和 registry hash；Host allowlist 显式允许。缺失或漂移 fail-closed，不回落最近版本、不自动下载。
4. Phase 7 不提供通用规则 DSL、任意脚本、宏、任意 Event 注入、网络访问或外部路径。
5. Runtime Author、Player、Admin 是不同 Principal capability。Runtime Author 只能提交注册 AuthorCommand，实例化预编译 Scene/CharacterTemplate、改变 lifecycle/Goal/Objective、触发注册环境变化或调整未来 participation/availability。
6. AuthorCommand 经过 Schema、Capability、policy、Event/Authority/Audit；不能直写 SQLite、Projection、Memory，不能注入任意定义。它增加 seq，但默认不推进玩家 Tick。
7. Agent/Director 不能自由创建永久角色。角色创建只来自 Genesis、受控 Runtime Author 或精确可信 spawn policy。

## 后果

- 内容表达力可以通过审核过的插件扩展，而 Kernel 保持题材无关。
- Pack 仍是数据，插件才是代码；二者生命周期、信任和版本责任清晰分离。
- Runtime Author 能组织开放世界，但不能成为绕过世界事实和审计的后门。
- Phase 7 暂不解决第三方不受信任插件沙箱。

## 验证

- 未注册/未 allowlist/Hash 漂移插件在 Writer Lease 和激活前失败。
- alias、固定参数和 `/act` 仍经过 Affordance、Validator 和 Rulebook。
- AuthorCommand capability、Schema、审计、seq/no-Tick、重启与幂等测试完整。
- 任何 Player、Observer、Agent 或 Director 直接 emit Event、创建永久角色或访问 Store 的路径都被拒绝。
