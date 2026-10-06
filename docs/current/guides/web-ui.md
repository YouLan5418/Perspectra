# 创作者自定义游戏网页

当前 Windows 启动器和本机试玩服务会读取所选 v5 世界包中的 `web/` 目录。只要存在 `web/index.html`，`GET /` 就返回创作者页面；否则返回系统默认游戏页。网页素材与世界内容分开，修改 `web/` 不改变世界包编译哈希，也不会仅因换肤使旧存档失效。

## 文件约定

```text
你的世界包/
  worldpack.source.json
  web/
    index.html
    style.css
    app.js
    images/scene.png
    fonts/title.woff2
```

页面可自由安排 HTML 结构，并使用包内 CSS、JavaScript、图片和字体。引用路径以 `/web/` 开头，例如 `<link rel="stylesheet" href="/web/style.css">`、`<script src="/web/app.js" defer></script>`、`<img src="/web/images/scene.png">`。允许的扩展名：`.css`、`.js`、`.mjs`、`.png`、`.jpg`、`.jpeg`、`.webp`、`.gif`、`.woff`、`.woff2`。入口页之外最多 99 个文件，每个文件最多 8 MiB，总计最多 16 MiB；符号链接不被加载。缺少入口页时整个网页回退为默认页；存在入口但文件不合规时启动失败并给出错误。

## 游戏数据与调用

游戏地址包含 `#token=...`，这是当前本机会话的玩家令牌。自定义 JavaScript 从 URL fragment 读取它，请求玩家 API 时设置 `x-playtest-token`。可参考 [AI 美少女包示例](../../../examples/world-packs/ai-girls-awaken-v10/web/app.js)。

| 请求 | 用途 |
| --- | --- |
| `GET /api/state` | 玩家可见场景、转录、运行状态、`availableActions` |
| `POST /api/submit` | JSON `{ "text": "..." }`，提交发言或显式命令 |
| `POST /api/perform` | JSON `{ "actionType": "move" 或 "interact", "parameters": {...} }` |
| `POST /api/pause`、`POST /api/resume` | 控制当前 NPC 反应 |

`web/` 静态文件不要求玩家令牌即可读取，不能放密钥或私密资料。创作者脚本与玩家页面同权，能读取玩家 API 返回的数据并代表玩家提交操作；只使用可信世界包。重要状态变化仍由服务端 Rulebook 裁定，脚本不能直接修改世界数据库。网页服务只监听本机回环地址，API 继续要求会话令牌。页面策略允许从本机加载包内脚本、样式、图片和字体；外部脚本及跨站请求不开放。模型密钥和 NPC 私有上下文不进入玩家页面。

网页改动在下一次启动游戏后生效。AI 美少女包给出了完整 HTML/CSS/JavaScript 示例；不提供 `web/` 的世界包继续使用系统默认页。
