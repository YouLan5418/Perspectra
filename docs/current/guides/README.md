# 玩家与创作者指南

本目录对应当前 v5 源包、Tauri Launcher 与公共玩家接口。历史版本的命令、字段和验收记录不作为当前操作说明。

| 使用者 | 要做什么 | 入口 |
| --- | --- | --- |
| 玩家 | 从配置模型到续玩、预设、故事线和授权 | [玩家试玩指南](player-playtest.md) |
| 创作者 | 复制示例、修改角色与世界、校验 v5 包 | [v5 创作指南](world-pack-authoring.md) |
| 创作者 | 用 Launcher 或源码进行真实模型验收 | [创作者试玩](creator-playtest.md) |
| 创作者 | 添加活动、公开和私有变量 | [活动与变量](activity-and-variables.md) |
| 前端作者 | HTML/CSS/JS、公共接口、沙箱边界 | [自定义前端](web-ui.md) |
| 源码使用者 | 安装、启动及检查命令 | [本机运行](local-runbook.md) |

详细格式和实现边界见 [预设](../model-presets.md)、[故事线](../storylines.md)、[前端授权](../frontend-authorization.md) 与 [创作者运行时](../architecture/creator-runtime.md)。这些设计与验收文档包含分阶段记录；日常操作优先从上表进入。

[旧 v1–v4 字段手册](../../archive/creator-guides/world-pack-authoring-v1-v4.md) 仅供历史查阅。当前不提供 `worldpack init`，不需要旧 `--action-groups` / `--interactions` 开关。
