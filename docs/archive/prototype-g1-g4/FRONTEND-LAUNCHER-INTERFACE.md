# 前端与本机启动器接口边界

状态：2026-09-29 首版实现边界。Windows 桌面启动器和本机游戏接口已接通；玩家界面与真实模型体验仍需继续验收。

## 当前可用

`experience:web` 在单进程中装配 v5 World Pack、运行时和本机 HTTP 服务。服务只监听 `127.0.0.1`，启动时生成随机令牌；网页通过 `x-playtest-token` 调用接口。

| 方法与路径 | 用途 | 响应 |
| --- | --- | --- |
| `GET /api/state` | 读取玩家试玩状态 | `PlaytestState` |
| `POST /api/perform` | 提交 `{ "actionType": "move", "parameters": object }` 或 `actionType: "interact"`；仍由当前规则裁定 | `PlaytestState` |
| `POST /api/submit` | 提交 `{ "text": string }`，包括发言和显式命令 | `PlaytestState` |
| `POST /api/pause` | 暂停后续 NPC 反应 | `PlaytestState` |
| `POST /api/resume` | 恢复 NPC 反应 | `PlaytestState` |

`GET /` 优先提供世界包 `web/index.html`，缺少时提供默认试玩页；`GET /web/*` 只提供同目录中允许的 CSS、JavaScript、图片和字体。这些属于本机网页资源，不计入游戏 API。`PlaytestState` 含玩家转录、场景摘要和调试字段，不能直接当作远程产品 DTO。`PlaytestState.availableActions` 现在承载当前玩家可尝试的移动与交互候选；默认网页和 AI 美少女示例页会将其渲染为按钮。默认网页仍保留命令说明与诊断字段。

## 第一版前端需要的边界

启动器是本机控制入口，负责选择 World Pack、存档和模型配置，启动及停止游戏进程。启动完成后，宿主默认浏览器打开游戏前端，直接调用游戏服务。启动器不代理每轮游戏请求。

| 能力 | 放置位置 | 第一版要求 |
| --- | --- | --- |
| 浏览世界包 | 启动器 | 从管理目录列出有效 v5 源目录，显示标题和路径 |
| 新建、选择存档 | 启动器 | 新游戏使用独立数据目录；续玩保持原世界包，拒绝不匹配的选择 |
| 选择模型配置 | 启动器 | 展示 Provider、模型名和端点；第一版密钥由启动器进程环境传给后端，不在窗口展示或写入存档 |
| 调整原型运行参数 | 启动器 | 设置反应波次、NPC 调用总数、每角色激活次数、反应时限，以及最近观察和自身观察条数；下次启动生效 |
| 启停与错误 | 启动器 | 只管理自己启动的游戏进程，启动成功后给出本机游戏地址 |
| 场景和转录 | 游戏服务 | 复用玩家授权视图，只呈现该玩家有权看到的内容 |
| 提交表达和操作 | 游戏服务 | 继续走现有提交、Rulebook 裁定和 Event 提交路径 |
| 当前可尝试交互 | 游戏服务 | 已实现：从当前玩家授权视图与 Rulebook 候选生成；通过 `GET /api/state` 的 `availableActions` 返回 |

这些运行参数保存在启动器配置中，不写入世界包或存档；续玩可重新选择。当前“上下文长度”控制角色请求中的最近观察窗口，不是模型请求总 token 或字节数。世界包检查器中的 reaction 摘要仍显示编译包默认值，不能用它判断本次试玩采用的启动参数。

前端菜单需要显示名、目标、参数要求与可提交引用。现有 `FrozenInteractionRulebook.affordances()` 可列出角色移动目的地和交互候选，但目前供运行时使用；`InteractionViewOption` 只有目标引用、绑定 ID、定义引用和参数，缺少完整的前端显示文案。当前已复用候选计算；人类可读的交互显示名与参数说明仍待完善。候选只表示“现在可以尝试”，提交仍按最新状态重新裁定。

## 接口增长原则

1. 现有四个游戏路由继续可用；已增加 `POST /api/perform`，候选随 `GET /api/state` 返回。新玩法继续复用结构化 `interact` 操作与 Rulebook，不按玩法增加 HTTP 路由。
2. 世界包负责内容和交互绑定；需要新权威效果的玩法由受信任的交互实现提供。新增玩法不要求为每个动作增加一条 HTTP 路由。
3. 启动器管理接口与游戏接口分开。存档备份、导入、删除和模型密钥持久化均不作为第一版的隐含能力。
4. `WorldApplication` 的原始事件、角色视图、记忆、管理和写入方法不直接映射到浏览器。对外读取先按玩家身份投影；权威变化经现有规则裁定。
5. 当前接口仅供本机单用户使用。局域网或公网访问需要另行确定身份、会话和权限边界。

## 前端开工的最小验收

- 启动器可选择有效世界包、独立新存档或匹配的旧存档、模型配置，然后打开本机游戏页。
- 游戏页显示玩家可见场景、转录、忙碌和错误状态；普通文本不自动执行受控动作。
- 菜单来自服务端当前候选；旧候选在世界状态变化后提交，仍由 Rulebook 接受或拒绝。
- 玩家页和启动器返回值不包含模型密钥、NPC 私有上下文或未授权观察。

现有接口出处：`tests/experiments/playtest-server.ts`、`playtest-frozen-runtime.ts`、`playtest-web-entry.ts`；交互候选出处：`packages/kernel/src/frozen-interactions.ts`、`packages/contracts/src/interaction-definition.ts`。现行玩家命令语义见 `docs/archive/prototype-g1-g4/PROTOTYPE-PLAYER-COMMAND-MODE.md`。
