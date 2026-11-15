# 两间房的搜证

玩家和澄在客厅，阿茹在卧室。搜查消耗一点精力，发现一封信；重复搜查仍消耗一点精力，线索列表只保留一份。精力为零时正式拒绝，代码为 `INSUFFICIENT_ENERGY`。同房角色看到翻找，不知道线索标识；房外角色不收到翻找观察。

实现是 [scripts/gameplay.cjs](scripts/gameplay.cjs)，复用仓库的共同搜证示例；[worldpack.source.json](worldpack.source.json) 用 `scripts.gameplay` 显式启用，初始精力为 2。包不需要模型凭据来运行机械推演。

在仓库根目录运行：

```sh
corepack pnpm@11.7.0 worldpack simulate examples/world-packs/investigation examples/world-packs/investigation/scenario.json
```

[scenario.json](scenario.json) 验证三次搜查、实际 SQLite 状态、结构化拒绝、观察隔离、实际模型请求及玩家面板。退出码 0 表示通过，2 表示执行后断言失败，1 表示命令或装配失败。`interact` 从当前候选匹配；`action` 是完整正式提案，可用来检查没有候选时的拒绝，不绕过身份、参数或规则检查。

默认舞台使用同一个包和正式 `perform` 操作，行动抽屉有“搜查房间”，状态抽屉有精力和线索，设置里可暂停搜查。云端验收采用进程内固定模型响应并实际点击了 Chromium 页面；未验证真实模型角色自然度、Windows Tauri 或发行包。普通启动时使用玩家自己的模型配置，不应把推演当成真实模型体验。

推演输出中的 `modelInputs` 是作者检查用的、逐角色实际授权请求；它不是可以转发给所有角色的共享上下文。`contextExcludes` 在角色根本没有收到请求时也失败，避免把“没调用”误判为隔离已验证。`knows` / `doesNotKnow` 检查已提交观察，`panelsContain` / `panelsExclude` 检查玩家投影，`fault` 精确匹配正式插件故障身份、操作及非法返回标志。
