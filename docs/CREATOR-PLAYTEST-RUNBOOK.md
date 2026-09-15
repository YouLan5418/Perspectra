# 创作者 World Pack 与真实模型试玩指南

> 当前入口是私有源码中的本机创作与试玩工具，不是在线创作者平台。网页只监听 `127.0.0.1`；Pack 不得包含 API Key、Provider 地址、系统提示或脚本。模型输出仍只是提案，最终动作必须经过 Rulebook 裁决。

本次建议使用 **v4 Pack + `--interactions`**。`object-interactions/v1` 生成 Manifest v8，体验两步行动组和物品交互；`interaction-catalog/v2` 生成 Manifest v9，并增加人工玩家即时牵手及参与者解除。两种新模式中玩家普通文本都是对白，移动和交互使用明确命令；DeepSeek 模式不再依赖 Ollama 翻译玩家输入。下文先走 v8 路径，v9 角色示例在 §3 单列。

**交互字段（`worldpack-source/v5` → Manifest v10 → `submit_actions/v7`）不走网页试玩。** 它把交互包与定义冻结进世界，词汇与表现策略由 Pack 自己声明；`experience:web` 说的是旧实验协议，尚未接上 v7。要跑这条路线请看 [字段手册 §17.3](WORLD-PACK-AUTHORING-MANUAL.md) 与 §8 的说明。

## 1. 准备运行环境与模型

所有命令在仓库根目录执行，使用 Node 22.19+ 或 24+ 和项目固定的 pnpm：

```powershell
node --version
corepack pnpm@11.7.0 --version
corepack pnpm@11.7.0 install --frozen-lockfile
```

DeepSeek 接入只支持代码中的固定地址 `https://api.deepseek.com/chat/completions`。Key 只通过当前启动进程的环境变量传入。以下输入不会把 Key 明文写入命令历史或文件：

```powershell
if ([string]::IsNullOrWhiteSpace($env:DEEPSEEK_API_KEY)) {
  $playtestSecret = Read-Host '输入 DeepSeek API Key' -AsSecureString
  $env:DEEPSEEK_API_KEY = [System.Net.NetworkCredential]::new('', $playtestSecret).Password
  Remove-Variable playtestSecret
}
$env:HCW_DEEPSEEK_MODEL = Read-Host '输入你的 DeepSeek 账号可用的模型 ID'
```

未设置 `HCW_DEEPSEEK_MODEL` 时，程序默认字符串为 `deepseek-v4-flash`；这不是远端模型可用性验证。请使用自己账号实际可用的 ID。没有 Key 时启动会失败，不会自动换 Provider。只有提交玩家消息或继续 NPC 反应才会发出角色模型请求；这些请求会产生 API 用量。

如果选择本机 Ollama，先启动服务并确认模型已安装：

```powershell
ollama list
$env:HCW_OLLAMA_MODEL = 'qwen3.5:4b'
```

`HCW_OLLAMA_ENDPOINT` 可配置本机 HTTP 地址，默认 `http://127.0.0.1:11434`，不接受远程 Ollama 地址。两种 Provider 的完整新协议输出上限均为 2048 tokens；Ollama 超时 120 秒，DeepSeek 超时 30 秒。失败或不明确结果不会自动重发。

## 2. 创建、校验和编译世界

下面三个目录用途不同：`$source` 是作者源文件，`$artifact` 是编译制品，`$data` 是本次试玩数据库。第一次创建时 `$source` 应不存在；修改已有世界时跳过 init。

```powershell
$source = 'D:\worlds\my-world'
$artifact = 'D:\worlds\my-world.worldpack.json'
$catalog = 'D:\worlds\my-world.interactions.json'
$data = 'D:\worlds\my-world-playtest-v8'

corepack pnpm@11.7.0 worldpack init --profile expressive-social $source
Copy-Item -LiteralPath '.\examples\world-packs\possession-interactions.json' -Destination $catalog

corepack pnpm@11.7.0 worldpack validate $source
corepack pnpm@11.7.0 worldpack test $source
corepack pnpm@11.7.0 worldpack compile $source --out $artifact
corepack pnpm@11.7.0 worldpack inspect $artifact
```

可先不改模板，确认能运行后再改内容。示例目录绑定模板中的 `entity:ticket-bundle`；改了物品 ID，必须同步改 `$catalog` 的 bindings。目录放在源目录之外，不向 `worldpack.source.json` 添加新字段。目录只在激活时校验，不会被单独的 `worldpack validate $source` 验证。

保留 `manifestation.json` 的 `mode: "enabled"`。`worldpack test` 当前仍可能返回 `assertionsExecuted: 0`，这不是多轮行为验收完成。

## 3. 启动网页并确认协议

DeepSeek：

```powershell
corepack pnpm@11.7.0 experience:web --deepseek --pack $artifact --interactions $catalog --data-dir $data
```

Ollama（两者选一个，不要对同一目录同时启动两个进程）：

```powershell
corepack pnpm@11.7.0 experience:web --pack $artifact --interactions $catalog --data-dir $data
```

打开终端打印的完整 `http://127.0.0.1:随机端口/#token=随机值` 地址。在网页调试抽屉确认：

| 字段 | 本次应看到的值 |
| --- | --- |
| `manifestVersion` | `8` |
| `outputProtocol` | `submit_actions/v5` |
| `playerInputMode` | `speech-and-explicit-commands` |
| `provider` / `model` | 选择的 Provider / 模型 ID |

**不需要预先执行 `worldpack activate`。** `experience:web` 自己激活世界，数据库直接在 `$data` 下。`worldpack activate` 是另一种 Host 入口，写入其目录的 `data/` 子目录，地址和玩家绑定也不同；不能把执行它当成网页试玩已激活。需要该入口时使用另一个目录。

未带扩展开关的 v4 Pack 会生成旧 Manifest v6；只带 `--action-groups` 则是 Manifest v7 / submit_actions/v4，仍使用 `take`。`--interactions` 已包含两步能力，不能再同时带 `--action-groups`。目录为 v1 时生成 Manifest v8，目录为 v2 时生成 Manifest v9；两者都保持 submit_actions/v5。

要验证角色即时交互，可改用仓库自带的完整 v4 编译制品和 v2 目录，并使用新的数据目录：

```powershell
$artifact = '.\examples\world-packs\ai-girls-awaken.worldpack.json'
$catalog = '.\examples\world-packs\ai-girls-awaken.character-interactions.json'
$data = 'D:\worlds\ai-girls-character-playtest'

corepack pnpm@11.7.0 experience:web --deepseek --pack $artifact --interactions $catalog --data-dir $data
```

此路径应显示 Manifest v9、submit_actions/v5 和 `playerInputMode=speech-and-explicit-commands`。Creator 入口有意保持 `legacy-speech/v1`：普通文本仍是对白，角色关系必须使用显式命令；这不代表 `player-intent/v1` 的生产 Provider 门禁已关闭。

## 4. 在网页中实际操作

以下命令使用未改名的模板 ID，每行单独提交：

```text
/say Alice，你现在最担心什么？Bob，你有什么打算？
/interact entity:ticket-bundle core:take
/interact entity:ticket-bundle core:give character:alice
/say Alice，请把票据交还给我。
/interact entity:ticket-bundle core:drop
/move location:station-platform
```

这是操作示例，不保证每条成功：NPC 可能先拿走票据，也可以不按玩家的请求归还。drop 需要玩家实际持有；give 还要求对方 active 且同地点。新模式的旧 `/take` 会被拒绝。`/say` 之后的文字以及普通非命令文本均作为发言；写“我拿起票据”不会自动拿取，括号中的动作也不会自动执行。

NPC 可以自主提交一次发言加一次 move/interact，允许两种顺序，也可以只做一步或沉默。两步连续裁定，失败停止后续步骤，成功前缀保留。表现使用闭合码；玩家暂时没有新版表现输入槽，不要依赖旧的自然语言 Cue 翻译。

Manifest v9 示例还可提交：

```text
/interact character:gpt core:hold-hand
```

成功后关系先进入同一 Root Round 的玩家候选 S1，GPT 随后独立选择松手、移动、说话或不反应。不要用玩家文本声明“她没有挣脱”“她永远服从”；这些内容不能替代目标自己的 Action，也不能建立心理或未来事实。关系参与者会获得动态 `core:release-hand` Affordance，第三方不会枚举 relationId。

| 试玩场景 | 核查重点 |
| --- | --- |
| 请角色移动后说话 | 先有实际 move，后续发言按新 Scene 分发 |
| 两个角色争同一物品 | 只发生一次成功拿取；失败者后续步骤不应宣称成功 |
| 玩家拿取、递交、请求归还、放下 | 持有关系形成完整循环，归还是对方独立选择 |
| 收件人已离开 | give 失败，物品留在原持有者；前面已经说过的话仍保留 |
| NPC 连续回应与沉默 | 调用有上限，不要求用满所有 wave；沉默不是格式错误 |
| 关闭后重开 | 世界 Head 与记录保留，启动本身不重复执行动作 |

页面只展示玩家获授权的观察，物品转移显示其 ID 与持有者或地点结果。详细失败原因以本机耐久记录为准，模型自称“完成”不算成功证据。

## 5. 保存、继续和收集证据

按 Ctrl+C 关闭，再用**相同 Pack、相同目录文件内容、相同扩展开关及相同 `$data`**重启，可继续同一世界。修改 Pack 或交互目录后使用新的试玩目录；Pack 内容修改还需提高 packVersion 并重新编译。不要用旧 v6 数据目录试图隐式升级到 v8。

网页调试抽屉能看到 Head、Tick、Cycle 状态和调用次数。`$data\requests` 保存请求/响应证据，包含 renderer、Provider 输入、响应 proposal、模型用量和失败分类。新模式应出现 `grouped-playtest/v2`，响应 proposal 应为 schemaVersion 5。该目录可能含 NPC 私有上下文，仅供本机诊断；Key 不写入证据。

| 证据 | 用途 |
| --- | --- |
| `*.request.json` | 检查发给模型的交互候选、协议和输入哈希 |
| `*.response.json` | 检查模型实际提案；提案仍可能被领域规则拒绝 |
| `*.invalid.json` | JSON 或协议格式无效，没有被当作合法动作执行；`validationError` 为具体原因，`rawOutput` 为被拒输出的前 65,536 个字符，`rawOutputTruncated` 标明是否截断。Provider 响应无法解析时正文为 null |
| `*.failure.json` | 传输失败或结果不明确，不自动重试 |
| `world.sqlite` 中的 `entity.transferred` / `action.resolved` / Observation | 核查真实效果与接收范围；停服后再做离线诊断 |

记录有问题的一轮：玩家输入、当时页面状态、相关请求文件名、预期与实际结果。不要把模型的完整私有上下文复制到公开反馈里。

2026-09-10 表现码契约修复后，`grouped-playtest/v2` 按动作生成表现 schema：独立表现不含声音/步态；声音仅用于成功发言，步态仅用于成功移动；两个数组不能重复，也不能同时为空（没有表现时省略 `manifestation`）。无效提案仍整条拒绝。历史 `grouped-playtest/v1` 请求和失败证据不回写；重放请求得到的是新的模型输出，不能据此确定历史失败原文。

## 6. 编辑世界内容与旧模式区别

`expressive-social` 从“雨夜同行”复制一份完整且可运行的 v4 结构。可以先只改标题、角色描写和初始认知，确认能运行后再改 ID 与交叉引用。

| 文件 | 创作者控制的内容 |
| --- | --- |
| `worldpack.source.json` | Pack ID、版本和全部来源文件清单 |
| `world.json` | 标题、描述、时间模式和初始公共事实 |
| `characters.json` | 角色名称、控制类别、位置、公开刻画、驱动和原则 |
| `cognition.json` | 各角色独立的 Claim、Goal、关系、情绪、矛盾、承诺和未完成事项 |
| `memory.json` | 每个角色的 Memory Profile 和注意主题 |
| `locations.json`、`entities.json` | 地点与可拿取物品 |
| `scenes.json` | Scene 生命周期、位置、成员和观察边界 |
| `player-slots.json` | 唯一手动玩家角色 |
| `reaction.json` | NPC 自主反应开启或关闭 |
| `manifestation.json` | 角色外显表现开启或关闭 |
| `presentation.json` | 确定性呈现配置 |
| `assertions.json` | Testkit 验收计划，不进入角色上下文 |

角色的 `controllerClass: "manual"` 表示玩家；本机试玩 Host 会为所有 active、非 manual 角色动态建立模型绑定，不再要求角色名必须是 Alice 或 Bob。角色仍只会看到各自获授权的 CharacterView、Memory 和 Scene。

若启用自主反应，`reaction.json` 必须是：

```json
{
  "schemaVersion": "worldpack-reaction/v1",
  "mode": "responsive",
  "profile": "responsive/v1"
}
```

该 Profile 固定最多 3 waves、8 次 NPC 调用、每角色最多 2 次；创作者不能在 Pack 中放宽这些安全预算。若不希望 NPC 在玩家输入后继续互相回应，将内容改为：

```json
{
  "schemaVersion": "worldpack-reaction/v1",
  "mode": "disabled"
}
```

外显表现默认启用：

```json
{
  "schemaVersion": "worldpack-manifestation/v1",
  "mode": "enabled"
}
```

**以下自由文案与玩家 Cue 说明仅适用于未加扩展开关的旧 v6 模式。** v7/v8 使用闭合表现码，不支持这些自由输入。旧模式启用后，模型可以在对白或动作旁附带表情、视线、姿态、手势、声音和外观变化。它们仍需经过裁定和观察权限，玩家基础界面会显示为一行舞台动作加一行对白。完整字段与安全边界见 [World Pack 创作者字段手册](WORLD-PACK-AUTHORING-MANUAL.md#15-开启角色外显表现)。

玩家也不需要填写 JSON，可以直接把主行为和外显表现写在同一条自然语言里：

```text
我皱着眉，避开 Bob 的视线说：“随你。”
```

本机玩家输入翻译器会保留原文中的对白片段，并只提取原文中确实出现的可观察 Cue。它不会把“嫉妒”“害怕”等内心状态直接公开，也不能替玩家补写表情。推荐使用全角括号或星号明确标注舞台动作，例如 `（皱眉，避开视线）随你。`，尤其适合带问号的对白。

旧 v6 模式仍要求一个 `speak`、`move` 或 `take` 主行为。完全沉默、只有表情动作的输入会要求澄清，不会伪造一句对白；这是 ADR-0083 的 V1 单 Action 边界。

## 7. 版本与本机数据边界

相同 `--data-dir` 会打开同一持久世界；相同玩家幂等提交不会重复调用模型。每次不传 `--data-dir` 时，试玩入口会在 `.tmp` 下创建一个新世界。

Pack 的 `packId + packVersion` 一旦激活，内容 Hash 就被锁定。修改内容后应提升 `worldpack.source.json` 中的 `packVersion`，重新编译，并使用新的数据目录。不要手改 SQLite、Manifest 或 Hash 来覆盖旧世界。

浏览器只收到玩家角色获授权的观察。完整模型请求和响应保存在 `<data-dir>\requests`，可能含角色私密上下文，仅供本机诊断，不应提交或分享。

## 8. 当前限制与排错

- `worldpack test` 当前验证确定性编译和 WorldSpec 适配，并如实返回 `assertionsExecuted: 0`；真实多轮行为由仓库测试和手动网页试玩验证。
- 所有非玩家角色暂时共用同一个模型与采样配置；还没有逐角色 Provider 配置界面。
- **v5（定义锁）世界目前只用付费实验门禁驱动真实模型**：`node --import tsx tests/experiments/v10-provider-gate.ts --model deepseek-flash`（`DEEPSEEK_API_KEY` 只走环境变量）。网页试玩尚未接上 `submit_actions/v7`；真实适配器还需要把 Host 的 `tools` 契约渲染成 JSON Schema，并把上下文里的 `developer` role 映射成端点认识的 role——两条都写在 [I5-d 记录](2026-09-14_交互抽象-I5d冻结路径的真实模型门禁.md) 里。
- **玩家在 v5 世界上可以声明"怎么做"**：显式命令走 `/act interact` 的第五个键 `performance`（冻结请求本来就有，不需要新版本），自由文本走解释器的 `actions[].performance`（`player-intent-candidate/v2`，见[字段手册 §17.3](WORLD-PACK-AUTHORING-MANUAL.md)）。说得越出定义的接受清单不会被丢掉，宿主会要求澄清。
- 试玩页不支持热替换 Pack。修改内容后需重新编译并启动新世界。
- v1/v2 Pack 可以加载；显式 v3/v4 `responsive/v1` 才会启用多 wave 自主反应，只有 v4 能启用外显表现。
- 旧 v6 模式需要 Ollama 翻译自然语言动作，即使角色模型使用 DeepSeek；新 v7/v8/v9 模式使用对白和明确命令，DeepSeek 路径不调用 Ollama；Creator 的 v9 入口尚未启用自然语言 Player Intent Provider（所以上面的自由文本表现只在仓库测试里被驱动，显式命令那条不需要 Provider）。
- 出现 `PACK_REFERENCE_INVALID` 时，优先检查改名后的角色、地点、Scene、认知 basis 和玩家绑定引用。
- 出现 `PACK_VERSION_DIVERGED` 时，说明同一 Pack 版本的内容已经改变，应提升版本并使用新数据目录。
- 出现完整性错误或 quarantine 时，停止写入并按 [V0 本机运行与恢复手册](V0-LOCAL-RUNBOOK.md)处理。

字段完整定义见 [World Pack 创作者字段手册](WORLD-PACK-AUTHORING-MANUAL.md) 和 [ADR-0069](adr/ADR-0069-worldpack-v2-source-file-shapes.md)；自主反应边界见 [ADR-0080](adr/ADR-0080-world-pack-v3-reaction-policy-creator-entry.md)，外显表现边界见 [ADR-0083](adr/ADR-0083-manifestation-observable-expression.md)。

## 9. Evidence → Finding → Path

| Evidence | 可复现观察 |
| --- | --- |
| E-001 | `worldpack init --profile expressive-social` 生成显式 `worldpack-source/v4`、`reaction.json` 和 `manifestation.json` |
| E-002 | `validate → test → compile → inspect` 由版本化编译器产生并复核不可变 Pack Hash |
| E-003 | 网页运行时读取 compiled Pack，并按 Manifest 动态绑定 active、非 manual 角色 |
| E-004 | Ollama/DeepSeek 只接收宿主组装的角色上下文，动作仍经 Inbox、Validator、Rulebook 和 World Commit |
| E-005 | `grouped-runtime.test.ts` 通过实际 WorldPlaytestRuntime、编译 Pack、模拟 DeepSeek HTTP 响应，验证 v4/v5 根轮与反应、玩家物品循环、重开和证据不含 Key |
| E-006 | `ai-girls-awaken.character-interactions.json` 经 `compiler-v4.test.ts` 适配为 Manifest v9，目录同时覆盖实体和角色目标 |

Finding F-001：E-001～E-004 证明创作者无需修改 Kernel 即可编写并真实试玩一个多角色世界；这仍是本机开发者工作流，不等同于 GUI 创作者产品。

Finding F-002：E-006 证明显式角色交互可在 Creator 路径激活，但自然语言 Player Intent 必须等生产 Provider/Profile 单独接入，不能由目录文案隐式开启。

Path P-001：创建来源目录 → 编辑内容 → 校验与编译 → 选择本机部署侧 Provider → 打开网页试玩 → 根据真实体验修改并提升 Pack 版本。

本轮验证使用 HTTP 响应替身，没有调用收费模型；远端模型可用性、自然语言选择质量和长期试玩体验由实际试玩确认。

2026-09-10 完整 `corepack pnpm@11.7.0 check` 通过：966 项覆盖率测试、生产源文件四项逐文件 100% 覆盖率、P0～P6 集成、3 项性能测试和 39 项子进程硬终止测试。新网页适配器的完整流程另由 E-005 覆盖。

2026-09-12 角色交互模型无关收尾后，完整 `check` 再次通过：107 个覆盖文件、1136 项覆盖率测试、四项全局及逐文件 100%，P0～P6、3 项性能测试和 49 项子进程硬终止测试；真实 Provider 长程试玩仍需另行执行。
