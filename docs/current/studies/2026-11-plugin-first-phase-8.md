# 插件优先运行时：阶段 8

日期：2026-11-04。分支 codex/plugin-first-next-seams，基线 151fe33。接续[实施方案](../../superpowers/plans/2026-11-04-plugin-first-next-seams.md)。

例如开发者只希望减少角色每轮收到的设定，不想接管记忆、状态或模型通道，现在可替换 `official-context-knowledge`。默认步骤仍按记忆投影、近期执行证据、已知状态、设定、表情的顺序执行，第三方追加步骤保持注册顺序。

## 已接通

新增 [official-contexts](../../../packages/official-contexts/src/index.ts)，持有稳定 ID、有序默认组合和同 ID 替换。宿主不再在 decide 中手写官方扩充顺序。复用 decisions 的 open/context/decide/close 与错误报告，没有新增服务注册表或排序框架。

公开 `WorldServices.contextSources` 给官方和第三方相同的授权投影能力。已知状态与设定继续使用 WorldGameplay 中的既有筛选算法；这个阶段拆分组合，不声称已经把玩法实现整体搬成插件。来源不返回完整真值，不向模型或 Provider 传入模型凭证。基础角色视图、活动约束、裁定和提交不属于可停用扩充。

源码装配的 `HostSeams.decisionOrder` 指定顺序；遗漏的官方项停用，未定位的第三方项追加；未知或重复 ID 拒绝打开。同 ID Provider 可替代一项，空实例也可明确停用。顺序进入候选环境记录，Provider 的 ID/版本/公开 identity 沿用阶段 6 比较。Launcher 暂无专用排序界面。

宿主 API 增量升为 2.1，已有 2.0 插件仍兼容。新 [focused-knowledge 示例](../../../examples/host-plugins/focused-knowledge.mjs) 要求 2.1：仅过滤已有授权设定条目，保留其余扩充。插件配置影响行为的字段通过公开 identity 声明。

## 验证

完整 check 执行 175 文件、1691 项测试，1690 项通过；唯一失败是模型接缝测试对 WorldServices 字段列表的旧断言。将新公开 contextSources 纳入列表后，相关 25 项测试全部通过，凭证隔离断言保留。类型、边界、Lint、格式检查通过，原有 Lint 警告保留；文档链接检查仍为既有 102 条断链，本次未新增；没有为修复断言修改生产逻辑。

新增回归证明：单独替换表情而保留记忆且每次只 project 一次；显式停用不会补回；改变有序组合后旧候选被拒；知识条件在已知状态后生效；示例可移除原本会交付的设定，且请求中余额只属于本人。

12 组离线基线请求与结果一致。5 组真实响应回放（聊天、分段自主、整合自主、甜蜜日程、狼人杀）全部一致，包括真实格式修正、行动和结果续写；只重绑定临时 UUID，不改变语义字段。

使用 8045 的 gemini-3.8-flash 直接请求：普通聊天 1 次、约 6.7 秒；甜蜜日程完整固定序章后晨间对话 3 次、约 31.8 秒，两例均没有处理错误。固定序章仍为零模型请求；本次未复现阶段 7 的单次晨间无请求观察，但不据此认定其原因已解决。使用新数据目录、关闭长期记忆，不能推导长会话或 Core 整理体验已验收。

后端构建与构建模式的 desktop-launch 启动回归（1 项）通过。没有重建完整便携发行包、操作 Tauri 或增加 Launcher 配置 UI；第三方示例完成源码自动测试，未做其真实模型长试玩。默认路径请求一致不证明第三方插件必然保护隔离；第三方仍是可信代码。

本机证据在 `.tmp/plugin-first-next/phase8-*.log` 与 `.tmp/plugin-first-next/live/phase8-*.json`。没有记录请求头或密钥。阶段 9～11 尚未实施。


## 提交后复核更正

用户复核发现最终工作区的 official-bundle.ts 格式不合规，原交付漏验最终格式状态；记忆异常归因、自主反应时限与记忆窗口耦合也有遗漏。上面的历史验证不能据此作为最终状态已无问题的保证。修复与重新验证见[本轮记录](2026-11-plugin-first-regression-fixes.md)。
