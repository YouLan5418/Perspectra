# 创作者只读调试接口

核对日期：2026-10-13。源码接口已接通，尚未增加调试界面或重建发行包。

例如钥匙已经交给另一名角色，但角色仍说自己拿着：先查 entities 的保管关系和最近事件，再选中角色查 currentView 的授权观察、latestRequest 的清洗后历史与本次召回，最后检查长期记忆来源。工具只读已安装数据，不执行交互、召回、补齐来源或调用模型。

## 从 Launcher 调用

Launcher 原生服务提供 `inspectCreator(instanceId, query)`，底层调用 `launcher_request`，operation 为 `creator-debug`。它只允许检查当前已启动实例。

在 Launcher 源码组件中可以这样读取当前角色：

```typescript
import { inspectCreator } from '../services/desktop.ts'

const world = await inspectCreator(instanceId)
const characterId = world.characters[0]?.id
const detail = characterId === undefined ? world : await inspectCreator(instanceId, { characterId, limit: 50 })
```

宿主 HTTP 入口为 `GET /api/creator-debug`，沿用 `x-playtest-token` 与同源检查。token 只由宿主持有；游戏 iframe 的 Perspectra SDK 和 Frontend API 均不开放本接口。采集开关复用现有 `/api/request-inspector`，Launcher 使用 `inspectRequests(instanceId, true)`。未开启采集仍可读当前世界，但没有实际调用快照。

## 查询参数

| 参数 | 行为 |
| --- | --- |
| characterId | 可选；必须是本世界已声明角色。省略时只读世界总览 |
| afterSeq | 可选；返回该事件序号之后的记录。省略时返回最近 limit 条；设为 0 从开头遍历 |
| limit | 默认 50，范围 1～100；同时限制事件页和每个记忆分层的条数 |
| memoryOffset | 默认 0；每个记忆分层各自从此偏移读取 |

未知字段、重复 HTTP 参数、非法分页、未知角色或超过当前 headSeq 的游标返回 400；无宿主令牌返回 401，错误 Origin 返回 403；世界切换期间返回 409；未接入接口的运行入口返回 404。损坏数据校验失败返回 500，不作为空档案处理。接口不接受文件路径、任意命令或写入参数。

## 返回内容与含义

类型定义见 [CreatorDebugSnapshot](../../tests/experiments/creator-debug.ts)，实现见 [运行宿主](../../tests/experiments/playtest-frozen-runtime.ts)。

| 字段 | 内容与边界 |
| --- | --- |
| capturedAt / address / worldVersion / headSeq / tick | 当前采集时间、世界地址、运行版本、已提交前缀与 tick；返回整份快照的身份 |
| busy / paused / captureEnabled | 当前宿主状态及实际请求采集开关 |
| characters | 全部声明角色的位置、场景、生命周期和最近移动事件；processing.transport 是最近捕获请求的传输状态，lastActivation 是最近已完成反应周期中的角色结果 |
| entities | 事件日志重建的受追踪实体状态、最近变更。holderId 表示保管或携带，未单独追踪法律所有权。effectiveLocationId 可以来自保管者位置，locationBasis 明示推导来源；不能据此宣称精确姿态或桌面位置 |
| variables | 当前安装的公开变量及全部角色私有变量；未安装变量模块时为 null。读取不运行作者脚本，不重建历史值 |
| activities | 各活动最近提交状态，含参与者、game 的公开／私有／内部变量；未开始的 state 为 null。这些信息仅限创作者宿主 |
| events | 事件页、nextAfterSeq 和 hasMore。后续用 nextAfterSeq 继续读取；完整记录保留事件类型、数据与序号 |
| character.currentView | 当前 headSeq 的授权观察、认识、目标等；它不是过去某次模型的实际请求 |
| character.latestRequest | 该角色最近一次捕获的实际请求，含清洗和预设处理后的 messages、contextParts、模型、时间、传输状态及 usage。无采集记录或已被容量淘汰时为 null；asOfWorldSeq 仅在已有认知前缀可用时附带 |
| character.memory | Core 已安装档案中的各数组分层分页，例如 sources、facts、episodes、observations；archivePrefix 标明整理边界。maintenance 显示该角色待整理前缀和正在运行／排队的任务。原生完整档案尚未接入，明确返回 native 与限制说明 |

本次实际召回内容位于 `latestRequest.contextParts` 中名为 `memories` 的分项。长期档案有某条记忆，并不证明它在这次被发送给模型；认识和对白也不等于权威世界事实。

信息受众依据 `observation.upsert` 的 `data.value.observerId` 和实际观察内容检查。对白的 addresseeIds 是交谈对象，不能当作全部听众；分页跨过相关事件时继续读下一页，不推测缺失受众。

请求检查器仍展示全局最近 4 条，额外保存每角色最近一次调用；角色快照限制为 32 个角色及约 800 万序列化字符，优先淘汰最早捕获角色。原单请求正文上限保留，超限明确 omitted；停止采集、清空记录或关闭运行时会清除角色快照。档案保留自己的持久化生命周期。不会捕获认证头、Provider 配置、响应正文或思考正文；作者主动写入上下文的私密文本仍属于私有调试数据。

## 验证与当前限制

自动化覆盖宿主权限、Frontend API 拒绝访问、查询边界、世界和事件分页、按角色保留／清空、Core 来源校验与查看不触发 catch-up。已有变量和活动测试核对创作者读取私有值不改变普通角色权限。

不推测未发生的处理机会、角色意图或不可见记忆；lastActivation 与最新传输状态可能来自不同处理时刻。包变量没有事件级变更历史，当前接口不补造变量差异。没有过去世界任意时刻预览、原生完整记忆档案、逐条清洗规则轨迹或自动诊断。未验证新界面的体验、真实模型长会话或发行包。
