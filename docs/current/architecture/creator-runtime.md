# 当前创作者运行时

World Pack 用于定义人物、地点、物品、认知、场景、叙事与 Interaction。当前网页接受 `worldpack-source/v5` 源目录，以宿主已安装能力编译；旧格式不会自动回退到旧运行时。可参考 `ai-girls-awaken-v10`、`prototype-g1` 和 `hand-in-hand`。

Interaction 定义和绑定提供玩法可选行为，规则负责重要状态的资格与结果。角色与地点定义不等于运行中当前位置；运行时通过提交事件和当前 view 获得状态。创作者仅在当前玩法明确追踪的机制中增加状态约束，不必结构化所有叙事细节。

## 包内活动

当前活动桥位于实验宿主。可信本地脚本声明 title、npcIds、operations，initialize 初始化，policy 决定各主体表达／操作许可，resolve 同步裁定，schedule / onOutcome 返回 wait 或请求某个已声明参与者处理。可选 simulate(request) 为该角色提供局部固定演出决策，null 表示调用真实模型；仅替换响应来源，不改变授权上下文、预设输出处理、格式校验、Rulebook、事务提交或观察分发。

最多 8 个 NPC，玩家身份由宿主绑定，开始时参与者须存在且同场景。状态 public 提供公开材料，private 仅给对应角色，internal 不进入角色视图；脚本不能直接写世界或调用模型。结果范围 self 只限制结果收件人，不能补救把秘密写进 public 的错误。

每次活动输入最多串行 4 次角色激活、每次最多 2 次决策机会，主动 recall 可追加一次补问；最多 12 次模型调用，活动链 90 秒。预算耗尽或失败保留已提交状态，允许显式重试或逃生，不精确恢复未提交机会。

`ai-girls-hosted-guess` 展示主持角色私有答案与多 NPC 有界链；默认能力限制不替角色决定情绪、策略和台词；作者显式声明的固定演出可通过 simulate 提供同格式决策。完整活动结果附带身份／阶段元数据以形成授权经历，但 Core 整理仍须显式开启，默认网页仍原生记忆。

## 创作入口与限制

先看[字段手册](../guides/world-pack-authoring.md)、[试玩步骤](../guides/creator-playtest.md)和[自定义网页](../guides/web-ui.md)。`frontend/` 使用显式 manifest 和 iframe 公共玩家接口，只改展示，不改变世界包编译身份；未提供时使用官方默认模板。新实验使用独立数据目录。

实现：[活动桥](../../../tests/experiments/pack-activity.ts)、[World Pack 工具](../../../packages/world-pack)、[主持示例](../../../examples/world-packs/ai-girls-hosted-guess)。当前不承诺任意玩法零宿主改动、多活动叠加或不可信脚本沙箱。短冒烟不等于长试玩验收。


### 2026-10-07：活动格式失败的有界修正

活动角色调用按 Core 的严格决策 schema 校验，本机发送端继续复用既有扁平 schema 适配。格式非法时只自动修正一次；能够唯一识别模型已选决策及交互选项时，修正请求使用该分支和选项，避免网关展开联合字段。固定数字在修正 wire schema 中用相等的 minimum/maximum 表达，以规避本机 numeric const 调用中多次得到字符串输出的现象（未分析网关内部实现）；Core 仍使用原始 schema 校验，不转换模型字段、不删除混合表达。

格式修正不增加受控动作预算。返回后继续现有世界高水位、活动版本、权限及事务校验。两次均非法保留原轮次，格式失败与服务失败分别显示；重试和逃生仍可用。此实现仅覆盖活动调用，不表示通用 G2 格式修正全部完成。
