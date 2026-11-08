# RPG 插件：取舍记录

2026-11-08，分支 `feat/rpg-plugin`。配合[设计](2026-11-08-rpg-plugin-adventure-design.md)阅读，只记实施前已定的取舍及它们替代了什么。

## 1. 形态：随程序的 Cordis 机制包

做成 `packages/official-rpg`，世界打开时按包声明生成脚本。理由：活动源本来就是脚本源码，状态模块已经能拼进状态脚本，不需要新的提交路径。

替代：10-26 的作者端生成器 `examples/rpg-core/generate.mjs`（作者先跑一遍生成器，再把产物放进包里）。

2026-11-08 已实施为内容接缝：`official-rpg` 导出 `officialRpgContent`（一个 `ContentGenerator`，读 `rpg.json`），经 `ctx.content` 注册，默认组合的 `content` 默认就是它。宿主只有通用的 [pack-content](../../../desktop/host/pack-content.ts)：读配置、核对 `plugin` 字段、生成、查重名、按生成器 id 记摘要（`plugin-set.json` 的 `generatedContent`）。它替代了 `WorldComposition.rpg` 槽位、official-bundle 里的 `officialRpg` 对象、`desktop/host/rpg-pack.ts`，以及透视、分享、`worldpack validate` 各自的 RPG 专用选项；存档里的 `rpgContent` 不做迁移（分支未发布）。队伍随行的移动判定 `movedAlongWith` 一并移入 application。RPG 玩法行为未变。

## 2. 随行：`ctx.rules` 的 resolve 中间件

队长的移动被接受后，中间件追加队员的 `character.moved`。场景转换由 Task 3 统一处理。

替代：牵手的移动后生命周期规则。它只能结束关系，不能移动别人。

补充裁定（控制者已定）：

- “在队”指该角色同时满足两点：列在公开状态 `rpg-party` 里，并且和队长在同一地点。
- 规则层从不写状态。
- 列在名单里但人已不在队长所在地的成员，由 RPG 状态模块在自己的 resolve 调用中移除。
- 不同处的人不随行，也不算在队。名单的清理只发生在队长或她本人下一次执行任何 RPG 状态操作时（规则层不写状态）：清理之后她回到队长身边要重新 `join`；清理之前她回来就仍算在队，而且在这段时间里，公开状态 `rpg-party` 的显示里仍会有她的名字。随行判断（`partyMembers`）每次都按名单加同处现算。清理只随被接受的 RPG 状态操作发生；被拒绝的操作不清理。
- 被清理的人不在场，看不到这次清理，她记得的名单可能仍有自己。所以名单上有自己时，她同时看到“加入队伍”和“离开队伍”，两者都按真实名单作答、不会因为她记错而失败：已不在队里时“离开”什么也不改，只让她看到当前名单；已在队里时“加入”同样只是告诉她当前名单。
- 入队只能由角色自己执行 `status:rpg-join`，目标固定是她自己、加入的是 `party.leader` 的队伍；队长没有替别人入队的操作。
- `rpg-party` 不是全员常知：变化只告诉当时在场的人，不在场的人保留上次看到的名单。
- `lockDuringBattle` 由地图活动的策略执行：战斗阶段它不放行 `status:rpg-leave`；不锁时战斗中只放行离队。

## 3. 状态 `locations` 只影响“谁看得见”，不禁止改动

理由：在家睡觉回血需要在家里改生命，所以不能因为生命数值只在副本里显示就拒绝在家里的修改。

替代：把 `locations` 当作可写范围，在其他地点拒绝改动。

## 4. 每张地图一场活动

地图剧情、固定演出与战斗合并成每张地图一场活动：进入时自动开始，开场旁白用活动现有的 `notice` / `sceneNotice`。理由：一次只能运行一场活动，拆成几场会互相抢占。

替代：把地图剧情、固定演出、战斗各做成独立机制。
