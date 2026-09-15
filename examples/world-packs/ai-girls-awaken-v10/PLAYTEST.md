# 《一觉醒来，我的大模型们都变成了美少女》v10 试玩

这是原 `ai-girls-awaken` 的 2.0.0 升级版本。旧目录继续作为 v6-v9 兼容黄金，不要覆盖。

```powershell
$env:DEEPSEEK_API_KEY = '<从安全环境注入>'
corepack pnpm@11.7.0 experience:web -- --deepseek --pack examples\world-packs\ai-girls-awaken-v10 --data-dir D:\worlds\ai-girls-awaken-v10-playtest
```

普通中文输入走 `player-intent/v1`，也可以使用 `/act` 显式命令。Pack 启用了 Manifest v10、`submit_actions/v7`、`responsive/v2` 和基础交互包：三个物品可拿起、放下、递交；GPT、Claude、DeepSeek、GLM 可作为牵手目标；已有牵手关系可解除。

不打开浏览器的真实模型冒烟测试：

```powershell
node --import tsx tests/experiments/frozen-playtest-drive.ts --model deepseek-flash --pack examples/world-packs/ai-girls-awaken-v10 --scenario ai-girls --turns 2
```

每次修改 Pack 内容都应提高 `packVersion` 并使用新的数据目录。
