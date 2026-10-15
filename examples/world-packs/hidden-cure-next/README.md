# 自主行动闭环与动态博弈：D / E

沿用[被隐瞒的治疗方案](../hidden-cure/README.md)。三个成年角色、三个地点，使用现有普通场景、原生记忆、自主机会、动态调度及 base:take/drop/give；没有 Activity、变量或 NPC 行动脚本。

- D1：竞争者的宽泛调查目标。
- D2：取得档案室摘要并带回旅馆的明确目标。
- D3：与 D2 完全相同的内容包；正式 NPC 调度前，玩家合法移动、拿取、返回，建立摘要不在原处的条件。
- E：同样先由玩家拿走摘要；增加教会的银露材料与档案室的备用材料，各一份普通物品。拿取与交付不代表完成治疗、拥有患者或取得患者授权。

[内容生成器](../../../tests/experiments/hidden-cure-next-content.ts)可重新从原包生成四个子目录。它只修改目标、资源及相同的交互白名单。准备阶段通过 WorldApplication 的规则路径提交玩家操作，没有直接写入世界事件或角色认知；正式实验后不暂停 NPC、不替 NPC 选择动作。D3/E 的三个准备操作不计入正式回合，日志独立保留其裁定和完整事件前缀。

在仓库根目录执行：

```powershell
corepack pnpm@11.7.0 test:related tests/prototype/hidden-cure.test.ts tests/prototype/hidden-cure-next.test.ts tests/prototype/character-autonomy.test.ts tests/prototype/dynamic-scheduling.test.ts tests/prototype/character-visible-items.test.ts --fileParallelism=false
node --import tsx tests/experiments/hidden-cure-next.ts
node --import tsx tests/experiments/hidden-cure-next.ts
node --import tsx tests/experiments/hidden-cure-next.ts --case=E
python tests/experiments/hidden-cure-next-audit.py output/hidden-cure-next/live-实际目录
node --import tsx tests/experiments/hidden-cure-format-audit.ts output/hidden-cure/live-vuTX5e
```

默认每次运行 D1/D2/D3 各 8 回合；E 单独运行 12 回合，先审阅 D 再启动。每次新建数据目录。模型固定 `gemini-3.8-flash`，本机 `http://127.0.0.1:8045/v1/chat/completions`，low，与 A/B/C 相同预算；服务不可用则记录失败，不换模型。D 的玩家输入是预定自语，只有推进自主机会的作用。E 玩家策略只接受 PlayerView：在合法现场交付原件、说明亲读证据、通过公开地图循序寻找人物或资源，实际材料操作也从当前授权选项中选择；不读取作者位置、NPC 请求或全世界快照。

`record.json` 包含逐调用真实请求、发送 Schema、提案、usage、延迟，以及逐回合权威动作/裁定、三方各自认知、玩家授权投影与策略依据。`transcript.md` 只列提交事件；`audit.json` 重放物品状态、核查受众及记忆来源，E 另验证玩家操作来自当时 UI 权限。字段齐全或机械检查通过不能证明角色动机自然、目标可靠完成；语义审阅见[实测报告](../../../docs/current/studies/hidden-cure-action-loop-20261011.md)。

日志包含作者有权审阅的私密内容，不能当作玩家画面或角色输入。没有保存凭证、认证头或模型隐藏推理。格式审计只重放历史提案并检验 Schema，不生成或提交新 NPC 表达。
