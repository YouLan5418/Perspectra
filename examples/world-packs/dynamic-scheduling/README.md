# 前台与后台动态调度实验

玩家和留守者起初位于后室，同行者与目击者位于前室。玩家走到前室时，两边角色分别得到自己有权观察的离开或到达刺激；后室角色的对白不会出现在前室玩家视图中。

运行可重复的受控串行／动态对比：

```powershell
node --import tsx tests/experiments/dynamic-scheduling.ts
```

脚本对后室模型请求注入 2 秒延迟，记录首条玩家可见回应、前台后续回应、并发峰值和最终玩家视图。每次使用 `output/dynamic-scheduling/comparison-*` 新目录，失败时直接报错。

本地 8045 模型服务可用时，可以运行真实模型：

```powershell
node --import tsx tests/experiments/dynamic-scheduling.ts --live
```

真实模型模式使用 8045 的 `gemini-3.8-flash`，思考强度为 low，给后室请求注入 20 秒等待，以便观察前台在后台尚未完成时的互动。该延迟是实验条件，不代表日常模型耗时；模型自己决定回应或行动。记录只保存公开玩家视图与请求时序，不保存模型私有上下文。

验证真实后台 HTTP 请求仍在进行时提交第二句，并在结算后重新生成末端回合：

```powershell
node --import tsx tests/experiments/dynamic-scheduling.ts --live --interrupt
```

该模式会检查后台取消、已提交的前台表达保留、第二句只提交一次，以及重新生成后仍保留旧回合前缀。它与正常完成的计时报告分开使用新数据目录。

手动试玩请使用新的数据目录：

```powershell
$env:HCW_LOCAL_MODEL = 'gemini-3.8-flash'
$env:HCW_LOCAL_ENDPOINT = 'http://127.0.0.1:8045/v1/chat/completions'
$env:HCW_THINKING_LEVEL = 'low'
corepack pnpm@11.7.0 experience:web --pack examples/world-packs/dynamic-scheduling --data-dir output/dynamic-scheduling/manual-dynamic
```

输入 `/act move {"locationId":"location:front-room"}` 走到前室；出现“可以接着说”时可提交下一句。比较原串行路径时使用另一新目录，并加 `--serial-scheduling`。此实验包没有 Activity、变量脚本或自主启动配置，专门验证普通角色反应调度。
