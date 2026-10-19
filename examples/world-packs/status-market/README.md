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

源码自动化见 [状态测试](../../../tests/prototype/pack-status-runtime.test.ts)，包含结构化值校验失败不提交、条件菜单、重复领奖、知识按角色隔离、分叉和重新生成；使用模拟模型协议，不证明真实角色体验。旧存档无法在新版本打开；现有便携发行包不包含状态能力。
