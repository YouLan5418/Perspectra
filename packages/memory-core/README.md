# 官方长期记忆（Core）

例如角色回忆玩家曾说“明天来喝茶”，宿主只交给它有权知道的来源；Core 提炼经历、整理可修正认识，召回时保留来源类型及反证标记，不把对白当成已裁定的世界事实。

默认实现为 Node.js / TypeScript。记忆构建、E5 索引、召回与交付均在 Node worker 中运行，Host 和 Launcher 不需要 Python。保留现有 `official-memory-core` 接缝、档案结构和宿主授权校验；更换实现会改变运行时身份，不承诺旧运行时存档直接重开，也不放宽身份检查。

| 内容 | 位置 |
| --- | --- |
| 授权快照、后台整理、预算与故事节点档案 | [core-memory.ts](src/core-memory.ts) |
| Provider 与按模型配置分组 | [core-provider.ts](src/core-provider.ts) |
| Node worker 生命周期 | [worker-client.ts](src/node/worker-client.ts) |
| build / recall / reproject | [runtime.ts](src/node/runtime.ts) |
| Source / Atom / Episode / Observation | [archive.ts](src/node/archive.ts)、[episodes.ts](src/node/episodes.ts)、[retain-prefix.ts](src/node/retain-prefix.ts) |
| 本地 E5、检索与交付 | [e5.ts](src/node/e5.ts)、[retrieval.ts](src/node/retrieval.ts)、[admission.ts](src/node/admission.ts)、[delivery.ts](src/node/delivery.ts) |
| 模型协议传输 | [utility.ts](src/node/utility.ts) |
| 固定资产与许可证 | [e5-assets.json](e5-assets.json)、[LICENSE-hindsight](LICENSE-hindsight) |

在仓库根目录安装锁定依赖并准备本地权重：

```powershell
corepack pnpm@11.7.0 install --frozen-lockfile
node scripts/setup-memory-assets.mjs
```

准备脚本下载并校验固定 revision 的六项资产，默认保存到 `.tmp/hindsight-e5-small`。已有文件也必须通过哈希校验；不自动覆盖损坏资产。可用 `HCW_HINDSIGHT_ONNX_DIR` 或脚本第一个参数指定目录。**运行时不会下载权重，也没有 Python 回退。** `--memory-none` 只用于明确不需要长期记忆的开发与测试；第三方记忆插件可通过现有接缝替换 Core。

源码入口默认读取本包 Node 源文件。设置 `PERSPECTRA_RUNTIME_ROOT` 时读取 `memory-core/node/core-worker.mjs`，模型位于 `models/e5-small`；构建后的 worker 外置 `onnxruntime-node` CPU 原生依赖。源码与发行布局的实际验证结果见[迁移记录](../../experiments/node-memory/README.md)。

`python/` 只保留为离线算法对照依据，不参与默认启动、Host 身份计算或发行装配。历史研究脚本仍可能需要独立 Python 环境；它们不是玩家运行条件。Node 迁移保留当前 quality 检索和 minimal Delivery，不接回旧实验检索或复杂 Delivery 分支。

自动测试、真实本地 E5、真实整理模型、完整角色试玩及发行包验收分别记录；其中任何一项通过都不代表其他项已完成。
