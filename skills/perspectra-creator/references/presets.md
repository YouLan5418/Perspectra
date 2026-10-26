# 创作原生角色预设

例如同一场书房对话，希望角色少解释、保留口语和各自立场，而不是每人都写一段总结：把这类表达要求写成预设节点。角色知道的信件内容放在角色知识里，钱和钥匙归属仍走规则；预设不能授予隐藏信息或把一句台词变成行动成功。

## 先确定交付格式

| 用途 | 复制的模板 | 校验与使用 |
| --- | --- | --- |
| 某作品的包推荐 | assets/model-preset.json | 复制为作品根部 model-preset.json；`worldpack.cmd preset validate <file> --pack`，然后 Launcher 选择包推荐 |
| Launcher 预设库单项 | assets/named-preset.json | 自定义 name 和 preset；`worldpack.cmd preset validate <file>`，再从预设库导入 |
| 一组可选风格 | 同一交换封装的 presets 数组 | 顶层 format/schemaVersion/presets，各项是 name/preset；每个 preset 独立校验 |
| 某作品的角色专属与角色组 | 作品根部 role-presets.json：`{ characters: { 角色ID: RolePreset }, groups: [{ name, preset, members }] }` | 启动器载入包时校验并弹窗提示玩家一键分配到实例；见 [预设说明第 9 节](../../../docs/current/model-presets.md#9-随包角色预设与一键分配2026-10-24当前源码) |

模板是可修改起点，不能只改标题就宣布用户的完整风格已实现。包推荐只放裸 RolePreset；不要把带 format／name／preset 的交换文件直接改名为 model-preset.json。模型、接口地址、Key、角色映射和世界状态都不属于这两种预设文件。复制到新的文件，不静默覆盖现有预设。

```powershell
& '<程序目录>/worldpack.cmd' preset validate '<预设交换文件>'
& '<程序目录>/worldpack.cmd' preset validate '<作品目录>/model-preset.json' --pack
```

先核对本机 --help 确实提供这个命令；较早的 0.3.1 候选没有它。校验输出 status=valid 并退出 0 才算通过；字段或宏错误退出 1。CLI 不写预设库、不执行文本匹配、不调用模型，仅复用 Launcher 的字段／宏及正则语法校验器。

## 节点、参数与宏

裸 RolePreset 可含 prompt、nodes、textRules、temperature、topP、frequencyPenalty、presencePenalty、maxOutputTokens、stop，不能添加酒馆的 prompts／prompt_order 或未知字段。

- nodes 每项必须有 id、name、enabled、role、position、content。role 是 system/user/assistant；position 只有 beforeContext/afterContext。Core 固定协议仍在首位，授权 Context 是一个固定插槽；assistant 节点是普通消息，不保证 prefill。
- 节点按数组顺序求值、按位置排列。每节点及附加 prompt 最多 16000 UTF-16 单元，总提示最多 32000，节点最多 64。disabled 节点也占数量和原文长度；只在启用节点里展开宏，prompt 不做节点宏展开。
- temperature 为 0–2，topP 为 0–1，两种 penalty 为 -2–2；maxOutputTokens 是 1–32768 整数。stop 最多四条且可能截断结构化输出，默认留空。实际模型／网关是否支持这些参数另行验收。
- 支持 `{{char}}`、`{{user}}`、`{{scene}}`、`{{date}}`、`{{time}}`、`{{trim}}`、`{{//注释}}`、`{{setvar::key::value}}`、`{{getvar::key}}`、`{{random::A::B}}`、`{{roll::1d6}}`。date/time 是请求时本机时间，不是游戏时间。
- setvar/getvar 只在本次请求内存在，不跨角色、请求或 continuation，不是世界变量。未知宏与嵌套宏失败；不能用酒馆宏语法直接替代原生写法。

人物专属语气写成该角色预设，而不是在共享预设公开全部人的秘密。实例中选择“角色专属 > 角色组 > 实例默认”，高层选择完整替换，不是把每层 prompt 叠起来。包推荐是包级默认；作者想给具体角色或角色组配预设时，写进作品根部的 role-presets.json，不要另造格式。玩家在启动器确认分配后，映射写入实例，保存后下次启动生效；玩家也可以不分配、或之后在 Launcher 里自己调整。角色专属完整替代包推荐，共享节点要在每份里各写一份。

## 文本规则

默认不加规则，只有明确的文本清理需求才添加。textRules 每项有 id/name/enabled/stage/target/pattern/flags/replacement；id 唯一，target 为 speech/narration/both。最多 32 条，pattern 最多 1000 单元，不写 `/.../` 分隔符；flags 仅 g/i/m/s/u 且不能重复，replacement 最多 4000 单元，支持 `$1` 替换。

| stage | 会影响的副本 | 不会修改 |
| --- | --- | --- |
| input | 当前角色获授权的最新玩家表达副本 | 玩家原始提交及意图裁定 |
| history | 授权历史／刺激中的对白和叙述副本 | 物品、位置、规则结果或完整世界真相 |
| output | 合法模型表达在正式发布前的对应片段 | 输出协议、行动参数及规则裁定；不是修复非法 JSON 的工具 |
| display | 玩家看到的角色表达副本 | 已提交事件、认知或记忆 |

不要用全局规则删除行动拒绝或伪造受控结果。输出清理后为空或超长会失败，不应冒充角色沉默。实际匹配由有时限和内存限制的 worker 执行，但静态语法通过不保证正则不会超时；用小型代表样例预览，再实际试玩。

## 借鉴酒馆预设与验收

原酒馆预设不是原生格式。静态阅读节点顺序、启用开关、参数、宏与正则，再按本节重写；保留不支持的楼层深度、递归／未知宏、预填充等差异，不把整张卡的脚本复制进预设。源码用户另有 preset:import 离线工具，但打包版不假定有 pnpm；本 Skill 不伪称 CLI 已提供该自动转换命令。

先用 CLI 检查，再在 Launcher 导入／选择并重新启动实例。预设编辑器的样例预览不证明模型风格遵循；需要真实调用时沿用已授权模型并记录模型、应用范围和可见表现，不公开实际私密请求。交付说明参数支持、宏／规则检查和真实风格验收各到哪一步；无法验证的部分明确标注。
