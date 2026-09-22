# 新原型基线与接手说明

## 基线选择

- 提交：`e682c5cf9c73f801b9de03e281a7bfb192ea71cc`（2026-09-15，fix: drive playtest reactions and normalize input）。
- 分支：`codex/narrative-interaction-prototype`。
- 工作树：`D:/DeepSeek Harness/harness-cordis-world-prototype`。
- 当前开发规则：[AGENTS.md](../AGENTS.md)。当前产品方向：[原型契约](2026-09-19_原型契约-自由叙述与声明式交互-v0.1-report.md)。

选择的是已集成创作者交互扩展、v10 世界与试玩修复的切点。它包含引用文字而非模型计算偏移的输入处理、可达移动目标提示，以及输入后推进反应的试玩修复；尚未进入 scene autonomy/reflection 和 v11 Topology/Performance 扩展。

| 候选 | 判断 |
| --- | --- |
| `993b247` 早期外显表现 | 作为体验对照；缺少后续创作者交互抽象和输入修复，作为工程基线会重复施工 |
| `e682c5c` | 选用；已有交互扩展与试玩链路，保留后续简化空间 |
| `b60e4db` 及后续 | 引入场景自治、反思与更多机制；首轮没有必要带入 |
| merged 的 `a56f2bc` | v11 拓扑和表现平台超出首轮范围，不从最新版本向下拆 |

这不是最小运行时，也没有证据表明该提交已经通过新契约的真实体验验收。原有 Receipt、Hash、兼容和耐久调度仍存在；基线选择只是减少需要拆除的部分。

## 已完成与下一步

基线建立时仅调整工作树和开发门禁。后续已进行 [第一轮上下文呈现实测](PROTOTYPE-PLAYTEST-01.md) 与 [第二轮自由表达实测](PROTOTYPE-PLAYTEST-02.md)。完整 perform → 结果 → 续写循环尚未实现；当前进展与限制以这两份记录为准。

下一步做一个可试玩的纵向切片：两房间、两 NPC、一个关键物品；角色看到可读场景，能自由表达，声明交互经过裁定再续写。按当前契约 G0/G1 记录具体入口、复用模块和存储选择。优先复用既有事件存储与裁定，只在实际阻碍这个闭环的地方删除旧耦合，不预先进行全仓合包、合库或协议重建。

`D:/worlds` 历史数据仅作为只读证据。新实验必须显式指定新数据目录。原工作树及 merged 工作树不变；不要求本树继续运行旧世界。旧测试保留供定位相关行为，后续废弃代码时可一起删除。

## 按风险验证

```powershell
# 默认轻量检查：类型、Lint、核心冒烟；不调用真实模型
corepack pnpm@11.7.0 check

# 仅默认冒烟
corepack pnpm@11.7.0 test

# 按修改文件选择相关测试，必须在命令中填写路径
corepack pnpm@11.7.0 test:related packages/store-sqlite/src/store.test.ts

# 可选旧全量，排除硬终止和性能测试
corepack pnpm@11.7.0 test:legacy

# 仅涉及相应边界时选用；可用 -t 缩小到具体场景
corepack pnpm@11.7.0 test:crash
```

默认 `vitest.prototype.config.ts` 选择角色私有视图隔离、物品交互裁定两组旧测试，并自动发现 `tests/prototype/**/*.test.ts`。这是当前的少量回归底线，不覆盖全部新契约；旧版本断言可以随已明确改变的行为更新。新增功能需补充相关验证，不可仅凭这两组通过宣布完成。

`vitest.config.ts` 保留广泛测试发现，供 `test:related`、旧阶段脚本与显式诊断使用。覆盖率仅作可选诊断，不再设百分比门槛。`test:related` 不带路径会选择全量，日常必须明确路径。CI 收敛为 Windows / Node 24 的轻量 check，不再默认维护多平台版本矩阵。

类型检查和 Lint 暂时仍扫描旧源码与测试；尚未按新运行时依赖拆分。是否进一步缩小，应依据实际阻碍决定，不因历史文件很多就先重做工具链。上述自动化验证均不能证明真实角色自然度或自由叙述一致性；按契约另做连续试玩。
