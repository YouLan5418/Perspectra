# 示例世界包

本目录下除下列历史素材外，其余子目录都是 `worldpack-source/v5` 源目录（[hidden-cure-next](hidden-cure-next/README.md) 下按用例分为 D1–E 四个源目录），可以用 `corepack pnpm@11.7.0 experience:web --pack <目录> --data-dir <新目录>` 运行，或在 Launcher 中选择。2026-10-21 核对时，这 18 个顶层源目录都能用当前编译器编译。

## 历史素材

以下内容只为对照历史文档中的设计与试玩记录而保留。当前编译器和宿主都不支持它们的格式；不再维护，也不迁移到 v5。

| 素材 | 格式 | 说明 |
| --- | --- | --- |
| [ai-girls-awaken](ai-girls-awaken/README.md) | `worldpack-source/v4` | 可运行版本见 [ai-girls-awaken-v10](ai-girls-awaken-v10) |
| [model-girls-home](model-girls-home/README.md) | `worldpack-source/v3` | |
| [rainy-road-companions](rainy-road-companions/README.md) | `worldpack-source/v2` | world-pack 编译器测试仍以它为素材，在测试内升级为 v5 |
| [tavern-social](tavern-social/README.md) | `worldpack-source/v1` | |
| `ai-girls-awaken.worldpack.json` | `worldpack/v4` 编译产物 | 与 ai-girls-awaken 同批 |
| `model-girls-home.worldpack.json` | `worldpack/v3` 编译产物 | 与 model-girls-home 同批 |
| `ai-girls-awaken.interactions.json`、`possession-interactions.json` | `object-interactions/v1` | 旧物品交互目录 |
| `ai-girls-awaken.character-interactions.json` | `interaction-catalog/v2` | 旧角色交互目录 |
