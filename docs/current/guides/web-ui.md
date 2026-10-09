# 创作者自定义游戏前端

> 玩家操作见 [玩家指南](player-playtest.md#5-社区前端与授权)。

> 社区前端授权已实现，含内容绑定、双记录、HMAC 与受信任模式；当前边界见 [授权交付](../frontend-authorization.md)。下文的沙箱描述仍适用于默认模式。

当前原型使用显式 `frontend/` 目录。旧 `web/` 不再作为可执行入口，也不再让社区脚本持有 Core 令牌；没有 frontend 的包使用官方默认模板。完整边界、限制与验收见 [最小沙箱实验](../frontend-v1.md)。

## 文件约定

```text
你的世界包/
  worldpack.source.json
  frontend/
    manifest.json
    index.html
    app.js
    style.css
    assets/banner.svg
```

`manifest.json`：

```json
{"apiVersion":1,"capabilities":["view","history","speak","perform","subscribe","resources"]}
```

只支持 API 1 和表中六种能力；未知能力不授予。入口引用 `/frontend/sdk.js`，再引用 `/frontend/custom/app.js`、CSS、图片等。默认沙箱不能使用内联脚本、外部脚本、fetch 或 WebSocket；社区模板由不允许同源权限的 iframe 承载。已明确授权的受信任模式使用独立来源并开放网络与浏览器存储，详见授权交付。示例见 [AI 美少女前端](../../../examples/world-packs/ai-girls-awaken-v10/frontend/index.html)。

包内文件快照最多 100 个、单文件 8 MiB、总计 16 MiB；不跟随符号链接或目录连接。缺少目录时默认回退；存在目录但入口或 manifest 不合规则启动失败。支持 HTML、CSS、JS/MJS、JSON、常见图片、字体和音频；准确扩展名见 [加载器](../../../tests/experiments/playtest-pack-web.ts)。

静态素材可以无令牌读取，**不得放密钥、NPC 私密资料或数据库副本**。资源接口只返回当前包已加载素材的虚拟 URL，不能读取任意路径。前端文件不改变世界内容编译 Hash；修改后重新启动游戏生效。

## 公共玩家接口

```js
const api = window.Perspectra;
const initial = await api.ready;
console.log(initial.capabilities, initial.view);
const view = await api.getView();
const unsubscribe = api.subscribe(event => {
  if (event.view) render(event.view);
});
const actionId = api.newActionId();
await api.speak("你好。", actionId);
// 超时重试必须复用 actionId 和完全相同的操作内容。
await api.perform(view.actions[0].id, api.newActionId());
const { url } = await api.resource("assets/banner.svg");
```

| 方法 | 数据或效果 |
| --- | --- |
| ready / getView | 游戏标题、玩家名、当前可见场景、状态、公开转录、当前操作 |
| getHistory | 同一公开转录，不含角色私有 Context |
| speak | 玩家发言或已有显式命令；仍走既有 Core 输入边界 |
| perform | 引用当前 optionId；Core 提供参数并裁定，不能注入参数 |
| subscribe | 公共视图变化，含 historyAppend；断连后重新获取快照 |
| resource | 当前包内已加载前端素材 URL |

模板不调用 `/api/*` 或 `/frontend-api/*`：这些 HTTP 调用由受信任 Host 执行，经专用 MessagePort 返回公开数据。初始化 API 版本、能力和视图不携带令牌。Host 的活动逃生、长期记忆等管理入口不开放给模板。

幂等范围是当前运行中的 Core 网页服务：并发、已完成及失败请求均保留。同一 actionId 改变内容会被拒绝；失败不会用同 ID 再执行一次。进程重启后不保留去重记录，重新发起操作前先检查公开历史。该原型没有跨重启 exactly-once 承诺。

## 从示例开始

复制 [launcher-demo 的 frontend 目录](../../../examples/world-packs/launcher-demo/frontend)，保留 manifest、SDK 加载和宿主通信方式，再修改布局与展示。该目录随 v5 源包一起加载；不要用双击 index.html 的结果替代真实宿主验收，SDK 的 ready 需要宿主建立通道。

先在默认沙箱完成发言、历史刷新和当前选项操作，再测试受信任模式与撤销。异步动作期间禁用重复提交，处理 paused/error 状态；社区界面失去响应时玩家仍可通过宿主进入官方界面。活动管理、预设编辑、故事线与私有请求检查不属于当前公共 SDK。

`view.actions[].id` 是当前 Core 生成的机器身份，按不透明值使用，不解析、不自行哈希或拼接参数；按钮可读性使用 label。动作失效后重新 getView 获取当前选项。超时先刷新公开历史与状态；如需重试同一未确认请求，复用相同 actionId 和参数，不把换 ID 当成无限重试机制。

> 受信任前端访问的远程内容可以在不改变游戏包摘要的情况下发生变化。

本地前端内容授权不能固定远程脚本的未来版本。无论何种模式，公开资源目录都不能存放密钥、角色私有资料或存档。

## 官方默认界面布局

官方模板采用右侧对话主区与左侧场景/行动侧栏，跟随系统切换浅色和黑灰深色；正文使用 17px 字号，角色使用不同识别色，引用对白与叙述通过文字色区分。移动和物品互动分组显示；窄屏下改为上下排列。输入框支持 Enter 发送、Shift + Enter 换行，中文输入法确认候选时不会发送。查看旧对话时保留位置，可用“回到最新对话”返回底部。

模板颜色、字号、字体和圆角集中在 `packages/frontend/src/default-template.ts` 的 `DEFAULT_STYLE` 变量中；深色值在 `prefers-color-scheme: dark` 下覆盖。宿主工具栏和活动面板也跟随系统主题。

宿主顶部“游戏工具”包含重新加载、切换官方默认界面及 Core 后台记忆整理；“中止活动 / 恢复”始终保留在外层。活动以可折叠面板放在游戏界面下方，不覆盖包内继续按钮或输入框；点击展开即可开始，开始后展开操作区。社区模板不需要复制这些宿主控制，也不会因此获得私有能力。

默认界面提供发言和可折叠的细节描写两个输入框，统一发送；任一项可留空，合计最多 2000 字符。描写属于外显表现，不是私密心理，也不能直接修改受控世界状态。公共 `speak` 请求可传 `{ text, narration }`，宿主复用一次现有 speak 动作提交；仅传 `{ text }` 时仍支持原有显式命令。失败重试复用两个字段及 actionId。

## 公开活动选项

view.activity 可提供 title、active、phase 和 public，用于显示序章章节、已提交台词及游戏日标签；不会返回角色 private、internal 或脚本玩家来源。view.actions 可包含无需额外输入参数的活动操作、当前版本绑定的开始／恢复节点选项，仍通过 perform(optionId, actionId) 执行。带额外参数的活动操作留在宿主表单；该支持不授予任意活动管理权限。

[官方试玩前端](../../../examples/world-packs/model-girls-official/frontend/index.html) 使用该接口逐项演出与快进，结束后提供公开、定向、私密和仅自己的原有表达范围。连接失败时保留同一 actionId 重试；活动已提交但 NPC 当前节点待发表时，可刷新视图后使用“恢复当前活动节点”。不要通过改本地 DOM 或伪造对白推进权威游标。

活动视图与转录、当前操作一样在已有刷新点投影，公开订阅只读取该投影，避免末端回合快照期间轮询重新打开迁移写事务。活动实际操作仍重新校验当前权威版本；忙碌期间显示上一次提交完成的视图。

## 多人响应等待（2026-10-09）

官方试玩包在处理期间显示阶段、等待秒数和已发表回应；等待秒数从页面看到 busy 开始，重载后重新计时。完成后可以继续行动；达到预算或模型失败时说明玩家输入与已发表回应保留，未完成部分没有提交。无需为催促角色再次发送同一句。默认模板同样显示显式玩家反馈，并允许已结束的 error 状态继续输入。启动器的“游玩配置 → 运行参数 → 普通反应周期 → 全部角色反应总时限（秒）”默认 120 秒，可调整为 5–300 秒；全部角色的上下文准备、串行模型请求和结果提交共用此时限。参数按包保存，下次启动生效；已有显式保存值保持原值，正在运行的实例不热更新，也不引入后台自治。

包前端运行时，外层活动面板默认收起，玩家可主动展开备用操作；默认模板仍按活动状态展开。官方试玩包快进收到已结束的失败状态时自动停止，保留当前游标，玩家可恢复该节点。

官方试玩包保持默认沙箱权限，发送按钮直接调用 SDK，不依赖浏览器 form 默认提交。真实系统浏览器中，缺少 allow-forms 会在 submit 事件前阻止默认表单提交；因此点击与 Enter 都走同一 compose 方法，不扩大沙箱权限。

包内接收者列表仅在可选角色变化时重建，普通刷新保持选择和下拉选项节点。启动器与真实系统浏览器的复验结果及未覆盖范围见[玩家界面试玩记录](../../../examples/world-packs/model-girls-official/PLAYER-VALIDATION.md)。

## 试玩包底部输入栏

玩家点击左侧“受众范围”，可选择公开、定向、私密或仅自己；悬停定向／私密展开当前授权在场角色，点击角色后显示所选范围与姓名。也支持点击展开、Tab 聚焦、向右箭头进入角色列表和 Escape 收起。角色离场后清除该接收者，要求重新选择，不自动换成另一人。

输入栏按用户提供的布局稿分两层：上方为无内边框的正文输入区，下方工具栏依次放受众、受众说明、细节描写、快捷键提示和粉色圆角发送按钮。点击受众说明图标展开当前范围解释；细节描写在正文与工具栏之间展开。正文支持 Enter 发送、Shift + Enter 换行及中文输入法。右侧上箭头在请求开始时立即改为旋转加载图标，后续 busy 期间保持加载并禁止重复发送；完成、截止或已结束的失败恢复发送。断线时停止加载并禁止发送。权限与请求仍走已有 SDK 的 scope / addresseeIds 校验。

本次核对真实 HTML/CSS/JS 在浏览器默认沙箱中的受众选择、发送字段、加载恢复、离场／空场、受众说明弹层、细节描写展开与发送，以及 375px 窄屏布局，SDK 使用测试替身；未为这项布局修改重跑真实模型剧情。

## 试玩包历史记录

玩家点击顶部历史记录图标打开 Galgame 式对话回顾面板，深色背景遮罩下按顺序显示角色姓名、对白和叙述。打开时定位到最新；向上回看时，普通刷新与新增回应保持阅读位置，可点击“回到最新”。关闭按钮、Esc 或点击遮罩返回游戏，焦点回到历史图标。序章尚未揭示姓名时仍显示“？？？”。窄屏改为姓名与内容上下排列。

面板只读取已有公共 SDK 的 view.history，不新增历史读取接口、不请求全局事件或其他角色私有记录；记录范围沿用现有玩家历史投影。查看记录不暂停宿主已在进行的角色处理。文本以 textContent 渲染，不执行台词中的 HTML。

默认沙箱浏览器已核对图标打开、三种关闭方式、叙述分段、滚动位置、空记录、序章姓名隐藏及窄屏；使用 SDK 测试替身，不代表重新完成真实模型剧情验收。
