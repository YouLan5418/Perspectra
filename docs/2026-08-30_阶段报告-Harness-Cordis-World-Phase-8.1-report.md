# Harness / Cordis World Phase 8.1 独立审查加固与 0.3.1 候选报告

> 当前结论：Phase 8.1 已关闭 `v0.3.0` 独立审查确认的权限、确定性、Session 连续性和派生持久化缺口，并形成私有源码 `0.3.1` 本机候选。`v0.3.0` 的既有 Tag 与数据保持不变；远程推送、四格 CI 和 `v0.3.1` annotated Tag 尚待用户执行。

## 1. 报告信息

| 项目 | 内容 |
| --- | --- |
| 报告日期 | 2026-08-30 |
| 不可变基线 | `v0.3.0`，提交 `f79e7c0` |
| 加固规格 | `phase8.1/v0.1` |
| 候选版本 | `0.3.1`，私有源码、stdio only |
| 本机环境 | Windows、Node.js 24.14.1、pnpm 11.7.0 |
| 外部集成 | Harness Bridge、TencentDB、真实模型 API 均保持禁用 |

## 2. 已关闭的问题

### 2.1 参与者与 Director 权限

- 玩家刺激在 Provider 调用前按动作时刻 Scene audience 裁剪为 `full`、`occurrence_only` 或 `none`。
- 同一裁剪结果同时进入 Memory query、Character Context、Provider Request 和相关 Hash，避免只裁 Prompt 而通过 Recall 或 Hash 泄漏。
- Director 只读取当前焦点 Scene 的 `scene_public` 或显式 `director_visible` 来源；私语、直达、自我观察、其他 Scene 和私有认知在候选建立前移除。
- Directive target 必须由目标角色当前焦点 Scene 成员资格的耐久来源证明；Agent 与 Director 分别使用 `schedulableCharacterIds` 和 `directorEligible`。
- 新增独立 canary，覆盖 recipient、bystander、other-scene、Memory、Director bytes、source refs、重启和同键重放。

### 2.2 确定性与注册契约

- Contracts 提供 UTF-16 code unit 比较器；生产代码中 `localeCompare` 与隐式字符串排序已清零。
- Unicode Golden 覆盖中文、组合字符、全角字符、BMP 和辅助平面字符，既有 ASCII Golden 保持不变。
- Provider Quality 阈值、暂停窗口、退避表和 `submit_actions/v2` 限制只从冻结 Registry 常量读取，不再由运行时复制第二套数字。

### 2.3 Session、Clarification 与派生持久化

- 任一已有 `sessionDeliverySeq` 的 Dead Letter 都阻止同 Session 后续项领取，不再只阻止 critical 项；人工重试沿用原序号并恢复连续 cursor。
- Clarification 首次写入在同一 `BEGIN IMMEDIATE` 中检查 Branch 为 active 且 admission open；既有结果在 maintenance、quarantined、archived 状态仍可读取与幂等重放。
- ContextReceipt append 和 ProviderCall prepare 的写入、冲突读取与 Hash 核验分别置于短事务中；双连接测试验证相同内容幂等、分歧内容 fail-closed。
- Checkpoint 的 Memory 水位落后统一返回可重试的 `MEMORY_CATCHUP_FAILED` 标准信封；缺失与两类落后水位均有测试。
- Context Tail 容量为零时明确选择空 Block，并对非法容量 fail-closed。

## 3. 兼容性与不变量

- 不重写任何既有 World Event、Manifest、Authority、Session 或 `v0.3.0` Tag。
- 原先正确的公开 `full` 刺激路径保持原规范值；只有此前越权的受限上下文产生新 Hash。
- World Event Log 仍是世界事实唯一权威；Context、Memory、Provider Quality 与调用账本仍是可验证派生或运维状态。
- 修复没有增加题材 Action、Phase 9 扩展、网络入口或真实 Provider。
- Cache miss、Provider 降级和派生状态变化不得改变权限、裁定结果或世界 Hash。

## 4. 本地提交单元

| 提交 | 单元 |
| --- | --- |
| `a496207` | 冻结 ADR-0073～0075 与 Phase 8.1 加固规格 |
| `5ebf41e` | 参与者刺激与 Director 可见性闭环 |
| `131e5bf` | UTF-16 世界文本确定性排序 |
| `b7033f5` | Provider Policy 读取冻结 Registry 契约 |
| `0b066a1` | Session Dead Letter 序号连续性 |
| `061de90` | Clarification 新写入准入屏障 |
| `96cd842` | ContextReceipt/ProviderCall 派生写事务化 |
| `f24390d` | Memory 错误信封与 Tail 零容量边界 |

## 5. 验证结果

统一门槛为：

```powershell
corepack pnpm@11.7.0 check
```

本机验证覆盖 TypeScript strict、Oxlint、V8 逐文件四项 100%、Phase 0～8 单元/集成回归、P0～P6 专项门和真实子进程硬崩溃矩阵。最终运行结果为退出码 0；覆盖率保持 statements、branches、functions、lines 全部 100%。

## 6. 仍然推迟的内容

- 真实 Token Counter、真实 API Key、HTTPS 和 Harness Bridge；
- Explain 的完整外部身份系统；
- 派生库 Retention、`controllerEpoch` 换代和 Director 身份重构；
- Phase 9 的创作者扩展、Runtime Author、模板/插件能力；
- GitHub 四格 CI 和 `v0.3.1` Tag，它们必须在本地候选推送后由远程证据闭合。

## 7. 发布步骤

1. 推送 `main` 到私有远程；
2. 等待 Windows/Ubuntu × Node 22.19/24 四格 `V0 gates` 全绿；
3. 将远程 Run 链接或截图记录为证据；
4. 在该已验证提交创建 annotated `v0.3.1` Tag 并推送；
5. 不创建 npm 包或 GitHub Release，不启用 Harness/TencentDB/真实模型。
