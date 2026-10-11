# 关键角色自主行动实验

玩家与同行者在前室，留守者独自在后室。留守者的目标是准备自己的安排，然后自行决定是否移动到前室讨论。玩家不必向留守者发消息。

本分支源码入口已读取登记在 `assetFiles` 中的 `autonomy.json`。未登记的同名文件不生效；现有便携发行包未包含这项能力。

```powershell
$env:HCW_LOCAL_MODEL = 'gemini-3.8-flash'
$env:HCW_LOCAL_ENDPOINT = 'http://127.0.0.1:8045/v1/chat/completions'
corepack pnpm@11.7.0 experience:web --pack examples/world-packs/character-autonomy --data-dir .tmp/character-autonomy-manual
```

使用新数据目录，并确认模型服务实际可用。也可以在本分支源码构建的 Launcher 导入本目录，在“运行参数 → 自主行动”调整预算。

样例明确把成功发言、移动、取得钥匙认定为推进行为，每次给留守者一个机会；普通对白是否计数是作者选择，不由模型判断“剧情意义”。目标复用 cognition.json。留守者可以不行动；不强制完成目标，也不在玩家停止输入时运行后台计时器。

配置字段、预算和限制见[创作者运行时](../../../docs/current/architecture/creator-runtime.md#关键角色自主行动2026-10-11实验分支)。

8045 / `gemini-3.8-flash` 已完成两组共 8 个玩家回合的真实短试玩：场外空刺激唤醒、裁定后移动与目标对白、私语暗号隔离，以及每两回合自主一次。单轮等待约 9–72 秒，尚未验收长期目标推进或多个自主角色，详见[实验记录](../../../docs/current/studies/character-autonomy-20261011.md#8045--gemini-38-flash-真实短试玩)。
