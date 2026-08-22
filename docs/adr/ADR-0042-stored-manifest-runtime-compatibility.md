# ADR-0042：存量 Manifest 的只读运行时兼容

- 状态：Accepted
- 日期：2026-08-23
- Supersedes：ADR-0026 中运行时只接收当前 Manifest 结构的隐含假设

## 背景

WorldSpec V1 会在编译时上转为 V2，但早期版本已经把 schemaVersion 1 的 Compiled Manifest 和旧 Genesis 事件写入 WorldStore。Manifest Hash、Genesis 事件和事件链都属于不可改写的世界事实；用当前编译器重新激活会改变 Manifest Hash 和 Genesis 词汇，并触发幂等冲突。

## 决定

1. WorldStore 继续原样保存并校验已写入的 Manifest 字节及其原始 `manifestHash`，不做就地迁移、不重写 Genesis、不伪造新的激活事务。
2. Kernel 提供 `runtimeManifestFromStored`：schemaVersion 1 在内存中经纯函数编译得到 V2 执行视图；schemaVersion 2 进行当前运行所需字段的显式校验；未知版本 fail-closed。
3. 运行时视图只供 Rulebook、PlayerBinding、队列限额和 Runtime Availability 使用，不参与已有 Branch 的 Hash、Event、Export 或重放身份。
4. 新 WorldSpec 仍统一编译并持久化为 V2。该兼容层只保证已接受的 V1 数据可继续挂载和执行，不允许 V1 绕过当前新建世界的契约。

## 后果

- 存量 Branch 无需重新激活即可被当前 `WorldApplication` 挂载。
- V1 世界的历史事件词汇保持原样，当前 Reducer 通过既有 `character.upsert` 等兼容路径重建状态。
- 后续增加 Manifest schemaVersion 时，必须新增显式只读适配或版本门，不能依赖 TypeScript 强转。

## 验证

- Kernel 单元测试固定 V1→运行时 V2 视图、V2 最小结构校验与未知版本拒绝。
- Application 集成测试直接写入真实 V1 Manifest/旧 Genesis 数据库，再由当前组合根挂载并提交 Round；测试不调用重新激活。
