# ADR-0047：玩家 CharacterView 必须受 PrincipalBinding 约束

- 状态：Accepted
- 日期：2026-08-23
- Extends：ADR-0030、ADR-0039

## 背景

`WorldApplication.characterView` 是作者/运行时组合所需的内部能力，但早期本机 JSON-RPC 将它原样暴露为 `view.character`。任何本机调用方只要猜到 `characterId`，就能读取 Bob 等 NPC 的私有 Claim。这会在接入真实模型或交互壳后破坏“角色只能看到自己的 CharacterView”不变量。

## 决定

1. 玩家侧 `view.character` 请求必须携带 `principalId` 和 `characterId`。
2. `WorldApplication.characterViewForPrincipal` 只在冻结 Manifest 存在完全匹配的 `PlayerBinding(principalId, characterId)` 时返回视图；否则返回 `UNAUTHORIZED`。
3. 本机 CLI 使用同一参数面：`view character <tenant> <world> <branch> <principal> <character> [asOf]`。
4. 作者/调试代码可以在进程内调用未降权的 `characterView`，但该方法不进入 JSON-RPC Port，也不得作为玩家或模型工具暴露。

## 后果

- 玩家入口无法横向读取其他角色的 Claim、Goal 或 Observation。
- Demo 的全知 snapshot 仍可用于作者验收，但必须由展示层显式投影玩家字段。
- 将来增加管理员/观察者角色时需要新的显式 capability，不能复用 PlayerBinding 绕过。

## 验证

- Application 和 JSON-RPC 测试同时覆盖匹配绑定成功、玩家读取 NPC 返回 `UNAUTHORIZED`、非法 principal fail-closed。
- CLI 解析测试固定 principal 与 character 两个必填参数。
