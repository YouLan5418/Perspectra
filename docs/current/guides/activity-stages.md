# 活动专属舞台

例如遗迹战斗显示血量与技能，计数实验显示计数与操作；宿主仍提供「回场景看看」「返回活动」和独立的「中止活动」。两者共享同一注册、授权、传输和 perform 路径。创作者也可以用包内 HTML 和 CSS 为某个活动排版。

## 为包内活动绑定 HTML 和 CSS

例如，让「读便笺」打开一张纸笺，其他活动继续用原舞台。在工作台的「活动专属页面」选择「读便笺」，导入 HTML 与 CSS，保存后点「预览活动页面」。已有包也可以直接填写 `frontend/activity-pages.json`。键是活动键，工作台或 `worldpack editor activity-pages <包目录>` 可以列出候选。

```json
{
  "read-note": {
    "html": "activities/note.html",
    "css": "activities/note.css"
  }
}
```

| 字段 | 要求 | 用途 |
| --- | --- | --- |
| 活动键 | 每条绑定必填 | 指向当前包的活动。可选脚本活动、工作台活动或已启用玩法生成的活动，如 `rpg-map-ruin-1`。 |
| `html` | 必填 | 相对 `frontend/` 的本地 HTML 路径，放在 `activities/` 或其子目录。 |
| `css` | 选填 | 同一目录树内的一份独立 CSS。宿主在 HTML 已声明的样式之后附加；如果同一文件已被链接，只加载一次。 |

HTML 可直接用 `<link rel="stylesheet" href="./note.css">`，也可以链接多份包内样式，此时可留空工作台的「附加 CSS」。图片、字体和样式表用相对路径一起放在 `frontend/activities/` 下。CSS 的 `url(...)` 相对该 CSS 文件解析。样式只作用于该活动页面。宿主保留「回场景看看」「返回活动」「中止活动」和工具栏。解除绑定可在工作台选择「使用原舞台」。

```html
<h1 data-activity-title></h1>
<p>窗台上压着一封尚未拆开的便笺。</p>
<div data-activity-actions></div>
```

| HTML 标记 | 玩家看见什么 |
| --- | --- |
| `data-activity-title`、`data-activity-phase` | 正在进行的活动标题、阶段。 |
| `data-activity-field="score"` | 当前活动的公开字段 `score`，字段缺省时留空。 |
| `data-stage-field="title"` | 当前玩法已授权给玩家的舞台投影中的顶层字段。 |
| `data-activity-actions` | 引擎填入当前可执行的选项和对应参数控件，例如技能和目标选择。 |
| `<button data-activity-operation="activity:leave">放回便笺</button>` | 自定义按钮文案和样式。只有当前恰好有一个匹配选项且无需填写参数时按钮才可用。 |

页面使用声明式标记，作者 JavaScript 与外部网络资源在此处禁用。按钮通过宿主提交并重新核对玩法操作，HTML 不能自行结算世界状态。完整作品级网页可沿用[自定义前端接口](web-ui.md)。[便笺 HTML](../../../examples/world-packs/porch-note/frontend/activities/note.html) · [独立 CSS](../../../examples/world-packs/porch-note/frontend/activities/note.css)

## 配置元素的操作和条件显示

在 HTML 中给按钮、图片或容器一个唯一的 `id`。在「活动专属页面 → 元素交互与显示」选择该元素，给按钮选「点击时执行什么」，再点「添加显示条件」。两项都选填。绑定在页面记录的 `elements` 数组中，工作台保留原 HTML 与 CSS。带参数的操作会在已绑定按钮旁显示对应表单；宿主只提交当前实例提供的选项。

例如，选择「展开便笺」按钮，点击操作选同名活动选项，显示条件选「玩家持有 · 开信刀 → 等于 → 是」。信封本身也可按同一条件应用已有 CSS 类。完整配置见[门廊便笺](../../../examples/world-packs/porch-note/frontend/activity-pages.json)。

| 条件来源 | 候选与运行时取值 |
| --- | --- |
| 活动阶段、操作可用、玩家持有 | 分别比较阶段文字、当前活动是否提供某项操作、指定物品是否在玩家手里。 |
| 活动共享、玩家本人 | 工作台枚举低代码活动声明的变量；手写脚本可从试玩视图读取更多字段。个人字段只取玩家自己的记录。 |
| 世界状态 | 比较玩家当前已知的公共状态。缺失、过期或只属于其他角色的记录不满足条件。 |
| 舞台 | 先设「试玩起点」，点「读取试玩字段和操作」。例如在遗迹一层的战斗中，选择守卫的生命百分比，小于 `30` 时更换图片。列表成员按稳定的 id 或 key 绑定，排序变化不影响选择。 |

数值支持等于、不等于及大小比较，布尔和文字支持等于、不等于。字段缺失或类型不符时条件不成立。显示规则全部满足才显示该元素。满足条件的 CSS 类可以叠加，多个换图规则同时满足时采用最后一条。图片元素更换自身图片，其他元素更换背景；条件解除后恢复原图。规则不会提交游戏动作。

外部 Agent 用 `worldpack editor activity-page-candidates <包目录> <请求.json>` 读取同一组 HTML 元素、操作和字段。传入 `{"key":"read-note","html":"activities/note.html"}` 可读静态候选，另传 `trial:true` 和可选的 `scenes` 可读取独立试玩中的字段。将返回的 `field` 原样用于规则。以下是单个元素的绑定，存入现有 `activity-page-save` 请求的 `page.elements`。

```json
{
  "id":"open-note",
  "operation":"activity:open-note",
  "rules":[{
    "field":{"source":"held","key":"entity:opener"},
    "compare":"eq",
    "value":true,
    "effect":{"kind":"show"}
  }]
}
```

`effect` 也可用 `{"kind":"class","value":"damaged"}` 或 `{"kind":"image","value":"activities/art/cracked.webp"}`。图片与 HTML、CSS 一起随包导出。

## 原生舞台的注册和输入

投影复用已有 `GameplayDefinition.playerView`，随模块注册和卸载；没有新增 Cordis 服务或第二套玩法投影注册表。输入新增 `activities`：仅所属模块、当前激活且玩家参与的活动，经 `ActivityStateRules.scoped` 授权，含 public、玩家自己的 private 和当前在场参与者 ID；没有 internal、其他角色 private 或世界真值。

模块可返回一个 `stage`：

```ts
playerView: ({ activities = [] }) => {
  const activity = activities[0]
  if (!activity) return {}
  return { stage: {
    renderer: 'stage-lab.counter',
    activityKey: String(activity.activityKey),
    activityId: String(activity.id),
    revision: Number(activity.revision),
    payload: { title: '登记实验', count: 0 }, // 实际实现从授权 public 白名单读取
  } }
}
```

B8 的既有模块调用边界隔离投影异常。展示校验器检查有限 JSON、65,536 字符 payload 上限及标识；所属活动/id/revision 不匹配时拒绝该模块展示。Host 转发时再次与当前前台活动匹配，仅一个匹配结果可用。其他模块的展示和通用操作不受失败模块影响。

可信宿主代码将 `ActivityStageRenderer` 列表交给 `createHostServer` 最后一个可选参数。官方组装的默认列表为 `officialStageRenderers`；代码样例见 [第二活动夹具](../../../tests/support/activity-stage-fixture.ts)。登记包含 id、moduleId、style、create(root)。id 重复或无效在服务器开始服务前失败。浏览器同时校验 renderer ID 和投影所属 moduleId，防止其他模块冒用已登记的官方渲染器。

factory 是编译进既有默认静态资产的自包含函数，不允许捕获 Node 闭包依赖；不是从包加载脚本，也不用 eval。实例的 `update(payload, context)` 仅收到有限 payload、当前活动已提供操作、busy/阅读/反馈与受控 perform/read；不收到完整 PlayerView 或 Core 引用。需要清理临时监听器时实现 dispose。渲染器可信，不是第三方脚本安全沙箱；继续使用原 iframe CSP 和网络限制。

## 生命周期与回退

- 每个 HTTP 服务固定一份渲染器资产列表；模块投影继续使用现有实例注册生命周期。模块卸载后不再产出 stage，客户端清除实例。
- 新活动实例或渲染器变更销毁旧渲染实例；暂停、结束、失效、切回默认均撤销旧回调。更新绑定活动 ID、修订号和末端候选，旧操作不能越界；重复点击有本地门禁，服务端仍最终验证。
- 未登记 ID、模块不匹配、投影失效、渲染抛错均回退通用卡片。渲染失败在当前展示绑定内保持关闭；暂停／恢复、重新进入或换绑定可重试。
- 默认舞台 main DOM 不重建，保留草稿和阅读状态；专属舞台覆盖时 main inert，返回时恢复焦点。宿主工具栏在 iframe 外。
- HostState 不再有 battle；通用 PlayerView 使用 `activityStage` 或显式 null。服务器→Host→MessagePort 两次 delta 都传递清除；SDK 合并时删掉清空字段，后续 full fetch 也不恢复旧舞台。

## RPG 与验证夹具

RPG `content.ts` 用 playerView 产生通用 stage；`battle-presentation.ts` 和 `stage-renderer.ts` 位于 RPG 包。RPG 专属界面以当前角色和双方状态为主，按选择技能、选择合法目标、确认的顺序展示操作。技能与目标取玩法投影和当前操作参数约束的交集，提交沿用宿主 perform。战斗记录按需展开；有未读时，默认前端只显示当前叙事及继续、跳过入口，读完后再显示最新战况。默认前端仅向 RPG 渲染器传递浏览器侧提交状态及已授权的当前自身魔力；已有投影未提供精确技能消耗。其他活动沿用各自的渲染与回退路径。原 `officialRpgBattleView` 仍是 RPG 内部白名单投影，不是独立 Host 注册途径。

计数实验是测试侧受信任原生活动，拥有自己的声明、操作、状态和 playerView；不是把 RPG payload 改名，也没有使用 TRPG GM 数据。本地可信活动可复用这个注册方式。

这次修改触及 Core 的**只读展示输入与校验**，没有改变权威裁定、世界事务、调度或存档服务；RPG 结算文件和持久数据版本保持原值。测试与浏览器实际范围见[交接记录](../../superpowers/plans/2026-11-16-activity-stage-registration.md)。

## 试玩

在仓库根目录、Node 24／pnpm 11.7.0：

```sh
corepack pnpm@11.7.0 exec tsx tests/experiments/activity-stage-preview.ts rpg
corepack pnpm@11.7.0 exec tsx tests/experiments/activity-stage-preview.ts lab
corepack pnpm@11.7.0 exec tsx tests/experiments/activity-stage-preview.ts fallback
```

每次只运行一条，打开打印的 URL。rpg 可打一回合；lab 点击“增加计数”，切回默认卡片继续，再打开专属界面；fallback 故意令渲染器抛错，默认卡片仍可增加计数。Ctrl+C 清理临时 SQLite。当前云容器需设置 COREPACK_HOME=/tmp/perspectra-corepack。不接触计费模型。
