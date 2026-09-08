# 创作者 World Pack 与真实模型试玩指南

> 当前入口是私有源码中的本机创作与试玩工具，不是在线创作者平台。网页只监听 `127.0.0.1`；Pack 不得包含 API Key、Provider 地址、系统提示或脚本。模型输出仍只是提案，最终动作必须经过 Rulebook 裁决。

本指南完成一条最短路径：只编辑 World Pack 的 JSON/Markdown 内容，编译为不可变制品，再让本机 Ollama 或 DeepSeek 驱动其中的非玩家角色。

## 快速开始

以下命令均在仓库根目录执行。先创建一个支持复杂认知、多 Scene、有界 NPC 自主反应和外显表现的 v4 Pack：

```powershell
$source = 'D:\worlds\my-world'
$artifact = 'D:\worlds\my-world.worldpack.json'
$data = 'D:\worlds\my-world-playtest'

corepack pnpm@11.7.0 worldpack init --profile expressive-social $source
```

编辑 `$source` 中的内容文件，然后依次校验、测试、编译和检查：

```powershell
corepack pnpm@11.7.0 worldpack validate $source
corepack pnpm@11.7.0 worldpack test $source
corepack pnpm@11.7.0 worldpack compile $source --out $artifact
corepack pnpm@11.7.0 worldpack inspect $artifact
```

使用本机 Ollama 试玩：

```powershell
ollama list
corepack pnpm@11.7.0 experience:web --pack $artifact --data-dir $data
```

默认角色模型和玩家输入翻译器均使用 `qwen3.5:4b`。终端会打印带一次性随机令牌的本机网页地址。

明确使用 DeepSeek Flash 试玩时，启动进程必须能读取环境变量 `DEEPSEEK_API_KEY`：

```powershell
corepack pnpm@11.7.0 experience:web:flash --pack $artifact --data-dir $data
```

此命令会产生外部 API 请求与可能的费用。DeepSeek 驱动角色，玩家自然语言动作翻译仍由本机 Ollama 完成；Key 不写入 Pack、浏览器状态或本地请求证据。

## 编辑世界内容

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

启用后，模型可以在对白或动作旁附带表情、视线、姿态、手势、声音和外观变化。它们仍需经过裁定和观察权限，玩家基础界面会显示为一行舞台动作加一行对白。完整字段与安全边界见 [World Pack 创作者字段手册](WORLD-PACK-AUTHORING-MANUAL.md#15-开启角色外显表现)。

## 继续、重建与修改

相同 `--data-dir` 会打开同一持久世界；相同玩家幂等提交不会重复调用模型。每次不传 `--data-dir` 时，试玩入口会在 `.tmp` 下创建一个新世界。

Pack 的 `packId + packVersion` 一旦激活，内容 Hash 就被锁定。修改内容后应提升 `worldpack.source.json` 中的 `packVersion`，重新编译，并使用新的数据目录。不要手改 SQLite、Manifest 或 Hash 来覆盖旧世界。

浏览器只收到玩家角色获授权的观察。完整模型请求和响应保存在 `<data-dir>\requests`，可能含角色私密上下文，仅供本机诊断，不应提交或分享。

## 当前限制与排错

- `worldpack test` 当前验证确定性编译和 WorldSpec 适配，并如实返回 `assertionsExecuted: 0`；真实多轮行为由仓库测试和手动网页试玩验证。
- 所有非玩家角色暂时共用同一个模型与采样配置；还没有逐角色 Provider 配置界面。
- 试玩页不支持热替换 Pack。修改内容后需重新编译并启动新世界。
- v1/v2 Pack 可以加载；显式 v3/v4 `responsive/v1` 才会启用多 wave 自主反应，只有 v4 能启用外显表现。
- 本机 Ollama 必须已经运行；DeepSeek 模式仍依赖 Ollama 完成玩家动作翻译。
- 出现 `PACK_REFERENCE_INVALID` 时，优先检查改名后的角色、地点、Scene、认知 basis 和玩家绑定引用。
- 出现 `PACK_VERSION_DIVERGED` 时，说明同一 Pack 版本的内容已经改变，应提升版本并使用新数据目录。
- 出现完整性错误或 quarantine 时，停止写入并按 [V0 本机运行与恢复手册](V0-LOCAL-RUNBOOK.md)处理。

字段完整定义见 [World Pack 创作者字段手册](WORLD-PACK-AUTHORING-MANUAL.md) 和 [ADR-0069](adr/ADR-0069-worldpack-v2-source-file-shapes.md)；自主反应边界见 [ADR-0080](adr/ADR-0080-world-pack-v3-reaction-policy-creator-entry.md)，外显表现边界见 [ADR-0083](adr/ADR-0083-manifestation-observable-expression.md)。

## Evidence → Finding → Path

| Evidence | 可复现观察 |
| --- | --- |
| E-001 | `worldpack init --profile expressive-social` 生成显式 `worldpack-source/v4`、`reaction.json` 和 `manifestation.json` |
| E-002 | `validate → test → compile → inspect` 由版本化编译器产生并复核不可变 Pack Hash |
| E-003 | 网页运行时读取 compiled Pack，并按 Manifest 动态绑定 active、非 manual 角色 |
| E-004 | Ollama/DeepSeek 只接收宿主组装的角色上下文，动作仍经 Inbox、Validator、Rulebook 和 World Commit |

Finding F-001：E-001～E-004 证明创作者无需修改 Kernel 即可编写并真实试玩一个多角色世界；这仍是本机开发者工作流，不等同于 GUI 创作者产品。

Path P-001：创建来源目录 → 编辑内容 → 校验与编译 → 选择本机部署侧 Provider → 打开网页试玩 → 根据真实体验修改并提升 Pack 版本。
