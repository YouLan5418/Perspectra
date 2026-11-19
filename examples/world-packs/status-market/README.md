# 集市钱袋：状态栏示例

玩家、同行者和留守者在集市摊位前闲逛，每人带着 100 的钱。同行者上个月借了玩家三十一直没还，想趁玩家不注意悄悄塞回钱袋（包里也保留了偷窃操作）。暗中塞钱或偷窃之后，结果只告诉动手的人：玩家的状态栏仍显示 100，并立刻标为“上次确认”（角色上下文里同样是 current=false）。也就是说，失主马上知道钱袋有了变化，但不知道现在是多少、是谁动的；执行“查看钱包”或付账后，才看到真实余额。对“暗中偷窃”而言这是当前的限制：失主会察觉到“有变化”。留守者从头到尾不知道两人的余额。时间是所有人都看得到的公共状态，每轮结束加 10。

本包从 [prototype-g1](../prototype-g1) 复制，只改了名称、人设与认知文字，并在 `worldpack.source.json` 的 assetFiles 登记 [scripts/status.js](scripts/status.js)：

- 状态：`money`（每个角色一份，只告知本人）、`time`（公共，alwaysKnown）。
- 操作：`buy`（参数 price）、`slip-money`（悄悄往别人钱袋里塞钱，参数 targetId、amount；只有 NPC 能做）、`steal`（只有 NPC 能做，targetId 必须是在场角色；不能偷自己）、`check-purse`（无参数，出现在行动菜单里）。
- 每轮钩子：时间加 10。

2026-10-19 新增结构化委托示例：`quests` 是按稳定 ID 索引的对象，每个委托有 stage 与 notes 数组，并由作者 JSON Schema 校验。点击“领取演示委托 → 完成演示委托 → 领取委托报酬”，最后余额增加 30、阶段变为 claimed，同次提交保证不会只加钱而漏记领取。这个演示用显式完成操作展示机制；实际游戏应在 resolve 中检查自己的完成条件。

状态脚本的 policy 只根据角色已知进度筛选上述选项，执行时再次检查；resolve 按真实进度裁定，重复领奖和旧选项都会被拒绝。NPC 同样可以自行选择这些操作。状态栏以 JSON 显示自己的委托记录，其他角色不会自动获得它。[knowledge.json](knowledge.json)使用 when Schema，在角色自己的委托已知为 done 时才交付[领奖说明](task-reward.md)。它与文档受众、关键词、预算共同生效，不自动触发操作，也不强制角色行动。对象按整个状态键告知，不能把公开信息和秘密混在同一键里再只公开一部分。

余额不足时“购买”仍是被接受的结果，不扣钱，但会告知真实余额；“不能偷自己”是 rejectReason，什么都不提交。测试夹具里的 HP、决斗活动、`set-time` 和 `cheat-hp` 没有放进本包；活动范围（`activities`）的写法见[作者指南](../../../docs/current/guides/activity-and-variables.md#3-状态2026-10-19当前源码)。

## 无模型实验

```powershell
node --import tsx tests/experiments/status-market-offline.ts
```

用本地假模型服务按脚本驱动：第一轮玩家说话、同行者偷窃；第二轮玩家查看钱包；第三轮买 20；第四轮再说一句。每次新建 `.tmp/status-market-<时间戳>`，保存玩家每步的状态栏和每次角色请求收到的 knownStatus。检查失窃后玩家余额为 100 且 current=false、查看后为 70 且 current=true、买后为 50、时间依次为 10/20/30/40、同行者和留守者的请求里从未出现别人的钱袋；任一项不满足则退出码为 1。它不调用真实模型，不证明角色表现。

## 真实模型试玩

2026-10-19 已用 OpenCode DeepSeek v4.1 flash 和 Core 记忆跑过一次 14 轮试玩，记录见[真实试玩](../../../docs/current/studies/status-market-deepseek-playtest-20261019.md)；驱动为 [status-market-playtest.ts](../../../tests/experiments/status-market-playtest.ts)。前三次（含给偷窃机会、加强动机）同行者都没有偷；第四次换成“悄悄还钱”后，同行者第一次有机会就塞了 30，失主状态栏一直显示“上次确认 100”，查看钱包后变成 130。驱动的输入组有 `market`、`theft`、`unattended`。

### 手动试玩

需要另行授权模型调用后再运行，走默认 Core 记忆，使用新的数据目录：

```powershell
$env:HCW_LOCAL_MODEL = '<已授权的模型>'
$env:HCW_LOCAL_ENDPOINT = '<已授权的 OpenAI 兼容端点>'
corepack pnpm@11.7.0 experience:web --pack examples/world-packs/status-market --data-dir .tmp/status-market-play-20261019
```

建议步骤：先随意聊几句给同行者下手的机会；在状态栏看到余额变成“上次确认”后，追问同伴“我的钱是不是少了”；再输入 `/status check-purse {}` 或点“查看钱包”；最后 `/status buy {"price":20}`。人工检查：失主看到“上次确认”后，是否凭空编出被偷的金额或嫌疑人，或把“可能变了”说成已确认的事实（失主知道有变化是预期的）；角色是否把台词里的“我付了钱”当成余额变化；留守者是否凭空知道别人的余额。

源码自动化见 [状态测试](../../../tests/host/pack-status-runtime.test.ts)，包含结构化值校验失败不提交、条件菜单、重复领奖、知识按角色隔离、分叉和重新生成；使用模拟模型协议，不证明真实角色体验。旧存档无法在新版本打开；现有便携发行包不包含状态能力。

## 官方舞台组件示例

本包的 [frontend/components.json](frontend/components.json) 把「行囊」和「四下看看」放在桌面工具栏，并把行囊在窄屏移到对白旁。私聊对象、物品数量和角色名字仍由官方舞台按当前阅读进度显示。可以从只配置一个按钮开始。

```json
{"version":1,"components":{"inventory":{"anchor":"toolbar","label":"行囊","narrow":{"anchor":"index"}}}}
```

将文件保存为世界包目录下的 `frontend/components.json`。文件可独立于 `theme.css` 和 `stage.json` 存在。删除这个文件即可恢复原组件。自带 HTML 页面的包使用自己的页面。

| 组件 ID | 允许的 anchor | 其他选项 |
| --- | --- | --- |
| inventory | index（默认）、toolbar、story | label、order、图标 bag |
| nearby | story（默认）、toolbar | label、order、图标 diamond |
| sendAudience | footer-end（默认）、footer-inset（从输入区末端向内 16px） | 图标 arrow；范围、对象和发送键作为一个组合移动 |
| identity | waist（默认）、above-waist（相对原名牌上移 16px） | 图标 dots；应用于所有可见角色 |

- `size` 可选 `standard`（原尺寸）或 `large`（至少 48px 高）。`tone` 可选配好前景和背景的 `forest` 或 `indigo`。已有的悬停、展开、说话人和禁用状态仍由官方舞台驱动。
- 导航键及身份牌的 `shape` 可选 `soft` 或 `pill`。发送区固定保留圆键和受众胶囊。省略 `icon` 使用原图标。四项 ID 同时作为官方元素的 `data-stage-component` 标识。
- `label` 允许 1–6 个字符，以字母、汉字或数字开头，后面也可用空格、中点或短横线。自定义文字保留在无障碍名称中，导航键同时保留原功能名。身份牌显示公开角色名，受众显示当前所选范围与对象。
- `toolbar` 是右上辅助工具区，`story` 是对白旁情境操作区，`index` 是行动索引。相同区域的两个可移动导航键按 `order` 从小到大排列（0–9，默认 5；相同值时背包在前）。它们排在区域的固定操作之后。打开索引时背包按钮归入索引，关闭后回到配置区域。周围物品沿用情境显隐，索引查阅项保持可达。
- 视口宽度不超过 640 CSS 像素时叠加 `narrow` 对象。可覆盖本组件允许的外观和锚点字段。整个文件上限 8 KiB。未知字段和值会在宿主日志中给出字段位置和允许值；错误版本或无法解析的文件整体回退。参数不接受脚本、HTML、远程 URL、权限、动作或任意 CSS。

在源码根目录可直接检查包资源和配置诊断。

```sh
node --import tsx --input-type=module -e "import {loadPackWeb} from './apps/host/src/runtime/pack-frontend.ts'; await loadPackWeb('examples/world-packs/status-market')"
```
