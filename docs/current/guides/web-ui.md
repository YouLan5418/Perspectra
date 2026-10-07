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
