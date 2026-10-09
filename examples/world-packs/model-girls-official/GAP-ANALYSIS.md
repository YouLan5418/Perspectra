# 官方试玩包能力差异与阻塞处理

对照用户总体设计 V1.0、序章稿 V1.2 与当前源码。文档中的设想作为需求材料，不当作已经存在的配置字段。下表区分原有能力、本次改动与未验收部分。

| 试玩需求 | 调查结论 | 本次处理 |
| --- | --- | --- |
| 可信 Activity 生命周期、限制表达、同步规则提交、有界角色链 | 已具备，活动桥在 pack-activity.ts | 复用，不新增游戏引擎 |
| 替换当前 NPC 模型输出，同时进入普通表达／观察路径 | 已具备可选 simulate | 编写固定 publish 脚本；不把台词直接写进前端历史 |
| 五条中性玩家模拟表达正常入历史并标记来源 | 原桥只能提交活动结果，不能原子带玩家表达，构成序章阻塞 | 补 resolve.playerExpression；按已有 speak 校验，与进度同事务；来源仅审计 |
| NPC 发表失败或读档不跳过一句 | 若操作先推进游标再发表，会漏句 | 补可选 onPublished，让发表和进度同事务；恢复既有版本锚点 |
| 包内界面继续／快进 | 原 SDK 过滤活动选项，只能外层面板操作 | 公开无额外参数的当前选项及版本绑定开始／恢复；不开放任意管理 API |
| 条件晚餐／蛋糕事件 | 原脚本没有授权场景事实输入 | initialize / resolve 复用同前缀的可见物品和场景投影；拒绝条件不提交 |
| 米、熟饭、吃完的一锅饭 | 原 basic 仅拿取／交付／接触，没有料理结果规则 | 新小料理可信交互实现，复用已有扩展与 entity.upsert；不是新 Action 类型 |
| 私密交流与内容隔离 | 原系统已有 direct/private；活动桥缺 private 的旁观发生通知 | 复用原范围；补 occurrence-only 授权观察，旁人没有内容 |
| 蛋糕合法移动和各人不同认知 | 原系统已有物品归属、可见持有及授权目击 | 制作包内蛋糕，复用 take/give/drop；跨房间事件起点，不强制偷吃结局 |
| 序章最后自由交接 | 原系统可结束 Activity 并回普通处理 | 脚本末句后 inactive；无额外玩家承诺和自由阶段预写结局 |
| 跨日与长期记忆 | 原系统已有授权经历和记忆；没有全天持续后台自治 | 显式活动日标签与回访入口；跨压缩真实模型召回仍待体验验收 |
| 背景与立绘 | 非底层阻塞 | CSS 背景与占位名字牌；正式美术和声音后补 |
| 网页连续推进 | 实际浏览器发现浮层遮挡及轮询 SQLite 锁 | 宿主面板进入正常布局；活动视图复用现有刷新投影，操作仍校验权威版本 |

## 源码证据

- [Activity 桥](../../../tests/experiments/pack-activity.ts)：表达许可、同步 resolve、schedule、simulate、授权观察和活动事件。
- [普通与活动宿主](../../../tests/experiments/playtest-frozen-runtime.ts)、[末端回合包装](../../../tests/experiments/playtest-tail-runtime.ts)：序章结束后的处理、快照与版本验证。
- [公共 SDK 投影](../../../packages/frontend/src/player-view.ts)、[宿主页面](../../../tests/experiments/playtest-host-page.ts)：公开字段、opaque 选项与 iframe 通道。
- [授权可见物品](../../../packages/application/src/character-visible-items.ts)、[料理实现](../../../packages/interactions-basic/src/home.ts)：不从叙事或全局库存推断重要状态。
- [回归](../../../tests/prototype/official-demo.test.ts)、[完整序章实验](../../../tests/experiments/official-demo.ts)：对应提交／权限／状态边界。

## 后续真实验收

已使用用户提供的本机 8046 / gemini-3.7-flash 完成关键场景样例，详见 [LIVE-VALIDATION.md](LIVE-VALIDATION.md)。实玩补修了普通角色 wire schema 的数值版本，料理真正提交成功；默认 30 秒串行反应截止仍保留为已知体验限制，复验采用已有 120 秒配置，未改默认值。没有冰箱层级、份额和后台自治仍是首版明确接受的限制。长期自然度及未覆盖组合继续按 [PLAYTEST.md](PLAYTEST.md) 检验。
