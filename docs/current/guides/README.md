# 玩家与创作者指南

本目录对应当前 v5 源包、Tauri Launcher 与公共玩家接口。标为“当前源码”的功能不在 test3 便携包里，差异见[项目状态](../PROJECT-STATE.md)。历史版本的命令、字段和验收记录不作为当前操作说明。

2026-10-24：本轮程序包不附试玩内容；源包需另行取得或创作。随包 CLI 的命令、退出码及范围见[创作校验](../../../scripts/release/CREATOR.zh-CN.md)。创作工具接通、完整程序构建、真实体验和公开发行分别记录，不能互相替代。

| 使用者 | 要做什么 | 入口 |
| --- | --- | --- |
| 创作者 | 只有程序包时，让 AI 生成和修改自己的源包 | [perspectra-creator Skill](../../../skills/perspectra-creator/SKILL.md) |
| 玩家 | 官方试玩包的序章与生活事件 | [包说明](../../../examples/world-packs/model-girls-official/README.md) |
| 玩家 | 没有序章、没有预定结局的四人晚宴（当前源码） | [赔罪晚宴](../../../examples/world-packs/model-girls-dinner/README.md) |
| 玩家/开发者 | 当前 test3 的交付和验收范围 | [便携构建记录](../studies/launcher-portable-test3-20261009.md) |
| 玩家 | 从配置模型到续玩、预设、故事线和授权 | [玩家试玩指南](player-playtest.md) |
| 创作者 | 复制示例、修改角色与世界、校验 v5 包 | [v5 创作指南](world-pack-authoring.md) |
| 创作者 | 用 Launcher 或源码进行真实模型验收 | [创作者试玩](creator-playtest.md) |
| 创作者 | 在浏览器里只读查看对话、物品去向、模型请求与记忆 | [创作者调试接口](../creator-debug-api.md) |
| 创作者 | 添加活动、经裁定的状态与状态栏 | [活动与状态](activity-and-variables.md) |
| 创作者 | 按权限和关键词交付设定、区分角色态度与客观变量 | [世界设定](world-knowledge.md) |
| 前端作者 | HTML/CSS/JS、公共接口、沙箱边界 | [自定义前端](web-ui.md) |
| 画师 | 立绘、表情差分和拼合图的尺寸与对齐要求 | [立绘出图要求](portrait-art.md) |
| 源码使用者 | 安装、启动及检查命令 | [本机运行](local-runbook.md) |

详细格式和实现边界见 [预设](../model-presets.md)、[故事线](../storylines.md)、[前端授权](../frontend-authorization.md) 与 [创作者运行时](../architecture/creator-runtime.md)。这些设计与验收文档包含分阶段记录；日常操作优先从上表进入。

[旧 v1–v4 字段手册](../../archive/creator-guides/world-pack-authoring-v1-v4.md) 仅供历史查阅。当前不提供 `worldpack init`，不需要旧 `--action-groups` / `--interactions` 开关。
