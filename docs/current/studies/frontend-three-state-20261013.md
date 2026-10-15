# 默认舞台三态与活动卡片验收

日期：2026-10-13。源码增量修改；保留 GAL 舞台、规则路径和既有活动机制。浏览器是真实 Chromium，数据来自无模型、无存档的运行时夹具，不能替代真实 NPC 玩法验收。

例如玩家读完 GPT-6 的发言，底部以该发言摘要和输入区回应；展开调查卡片后，左侧仍然显示人物与最近对白，右侧允许从“窗边书架”等合法候选中选择目标。手动返回情景后，卡片保持收缩，不因轮询或新机会反复打开。

## 截图

所有截图来自当前 HTML/CSS/JS、Host/iframe 与公共玩家接口的实际浏览器运行，不是效果图。Claude 与 DeepSeek 使用已有名称占位；GPT-6 使用用户提供的立绘。

| 状态 | 1280×720 | 1920×1080 |
| --- | --- | --- |
| 单角色阅读 | [截图](../../../output/playwright/three-state/reading-1280x720.png) | [截图](../../../output/playwright/three-state/reading-1920x1080.png) |
| 自由回应与对白摘要 | [截图](../../../output/playwright/three-state/response-1280x720.png) | [截图](../../../output/playwright/three-state/response-1920x1080.png) |
| 活动展开且操作可用 | [截图](../../../output/playwright/three-state/activity-open-1280x720.png) | [截图](../../../output/playwright/three-state/activity-open-1920x1080.png) |
| 活动收缩仍进行中 | [截图](../../../output/playwright/three-state/activity-closed-1280x720.png) | [截图](../../../output/playwright/three-state/activity-closed-1920x1080.png) |
| 多角色同场与活动展开 | [截图](../../../output/playwright/three-state/multi-activity-1280x720.png) | [截图](../../../output/playwright/three-state/multi-activity-1920x1080.png) |

## 实施与证据

- 阅读、回应和活动是前端 `data-mode`，不增加世界回合、数据库或核心规则。阅读自动收缩活动；回应替换底部完整对白，保留摘要、受众与描写；活动打开时给卡片预留右侧空间。
- 浏览器在两种尺寸测量活动卡片、当前说话者和对白正文的边界，确认不重叠。活动操作按钮在截图时可执行。玩家收起后等待超过一次宿主轮询，卡片仍关闭。
- 参数候选复用已有 `oneOf` 的名称和原值，继续通过原 `/api/activity` 提交。暂停保留进度、恢复继续活动、中止逃生恢复普通互动；不把这些操作与关闭卡片混为一谈。
- 宿主的原始状态查询可能领先于 iframe 公共更新，因此同时比较已接收历史内容与当前转录；未读期间只保留已展示的活动状态，隐藏新操作与后续结果。世界本身继续提交。
- 重新生成和候选替换保留原路径；阅读测试验证变化前缀之后的内容替换及旧场景失效。

可复现浏览器脚本：[acceptance.js](../../../output/playwright/three-state/acceptance.js)。它在预览夹具启动后检查五类截图、草稿保留、物品结果后的连续阅读、移动同步、候选参数、结果门禁与暂停/恢复/逃生。它只操作本机夹具，不读真实存档或凭证。

启动方式见[默认情景舞台](../frontend-stage.md)。类型检查、lint、桌面后端构建和文档链接检查通过。前端接口/权限/阅读、pack-activities 与官方 demo 共 53 项相关测试分组通过；其中阅读测试覆盖相同对白候选的场景缓存失效。浏览器逐项结果保存在[结果记录](../../../output/playwright/three-state/acceptance-result.txt)。

## 验收边界

未新增后端数据。现有授权历史有序号，但没有逐事件的场景成员或活动快照；本轮采用保留先前展示、读完或跳过同步最终状态的保守方式。不能据此声称精确中途进出场已解决，也不生成不存在的物品事件或通知。

完整真实模型试玩、长期会话、跨存档/候选的完整浏览器矩阵和便携发行包尚未验收。小屏活动仍采用原有覆盖空间，本轮无重叠验收范围是用户指定的两种桌面尺寸。
