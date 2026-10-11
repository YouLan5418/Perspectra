# 自主目标与并行调度组合实验

保管员独自在工作室，已有目标是把桌上的黄铜钥匙安置到档案室并解除个人保管。玩家和值守者在后室，同行者在前室。保管员不接收这些角色的来去或对白；自己的行动结果仍可见。

实验通过真实试玩运行时提交玩家行动。受控模式验证测量和提交路径；真实模式使用本机 8045 的 gemini-3.8-flash、low thinking，不人为增加等待时间。

~~~powershell
node --import tsx tests/experiments/autonomy-scheduling.ts
node --import tsx tests/experiments/autonomy-scheduling.ts --live
~~~

四组分别是每玩家回合一次自主机会、单回合六次自主机会、混合串行和混合动态。前两组玩家只对自己记笔记，后两组在前后室往返。默认每组六个玩家回合；单回合多机会组只提交一次。可用 --case=mixed-dynamic 等选择一组。

每次创建 output/autonomy-scheduling/controlled-* 或 live-* 新目录。报告包含公开玩家视图、保管员权威行动摘要、外部观察计数、调用时序和模型返回的 usage。不保存原始提示、模型私密推理、完整响应或凭证。Token 估算与服务返回 usage 分列；未返回 usage 的请求不按零成本解释，也不推算金额。

动态组将普通反应、自主机会及后续反应接入同一有界队列，共用并发槽位、地点互斥和前台优先级；三组调用预算独立。加 --staged-autonomy 可对照接入前的分段处理，普通阶段依然动态。目标完成依靠角色判断；当前没有目标完成后自动取消自主机会的机制。

初始四组真实模型结果及完成后的空调用见[基线记录](../../../docs/current/studies/autonomy-scheduling-20261011.md)，接入后的对照和边界回归见[接入记录](../../../docs/current/studies/autonomy-dynamic-dispatch-20261011.md)。
