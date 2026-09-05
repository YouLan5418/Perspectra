# 主线真实模型体验入口

> 手动实验，不是正式 Provider 产品接口，也不是 P9 Release 完成声明。模型只能提案；Renderer 的真实 wire bytes 保存在本机实验 sidecar，生产 Model Profile 仍未正式表达这些模型与采样参数。不要把该入口用于真实用户数据。Harness / TencentDB 仍禁用。

## 合并与当前范围

2026-09-05：`main` 从 `c2b3141` 快进到 P9 当前基线 `7a912cf`，包含 57 个提交；保留 qwen、phase9b 与实验分支，无远程推送、无 Tag。

本次额外从 `experiment/ollama-qwen35-4b` 移植：慢响应下整 wave claim 续期修复（原 `af09af4`），紧凑 Renderer、说话者归属/发言时机提示和测试、本地 Ollama 单输入实验、Flash 三轮体验入口。未将旧实验分支整体覆盖到主线；主线的调度/行政/备份改动保持。

按用户决定暂停长历史优化，保留[测量结果](2026-09-05_测试报告-P9C.6长历史基准-report.md)为未完成项。合并不等于 P9C.6 / P9C.7 或跨平台发布门槛已完成。

## 本地 Ollama

先启动 Ollama 并确保已下载 `qwen3.5:4b`，在仓库根目录运行：

```powershell
corepack pnpm@11.7.0 experience:ollama
```

默认输入为“Bob，你迟到了。Alice，你怎么看？”。也可直接运行脚本传入一条自定义文本：

```powershell
node --import tsx tests/experiments/ollama-qwen35-4b.ts 'Alice，你现在最担心什么？Bob，你有什么打算？'
```

每次启动创建新的临时世界，处理一次玩家输入及其有界 NPC 反应；**不是同库连续输入壳**。默认使用 compact Context；本地入口目前沿用基础 compact 提示，未启用 Flash 的额外 turn-taking 提示。默认仅访问 `http://127.0.0.1:11434`，不得重定向到远程服务。

结果和请求/响应保存在 `.tmp/ollama-qwen35-4b-时间戳/`，其中可能包含角色私有上下文。原始文件只留本机，不应提交、分享或当作玩家视图。

## DeepSeek Flash 三轮体验

启动进程必须能读取已配置的 `DEEPSEEK_API_KEY`，不要把 Key 写入仓库或发到聊天中。入口固定调用既有实验模型 `deepseek-v4-flash`，不会自动换模型或重试收费请求。

```powershell
$env:HCW_FLASH_PROMPT='turn_taking'
corepack pnpm@11.7.0 experience:flash
```

这是明确的外部 API 调用，会把雨夜同行测试 Pack 的已裁剪角色上下文发送至 DeepSeek。三条固定玩家输入在同一持久世界运行，最多 30 次调用、6 分钟接纳预算、每次 HTTP 超时 30 秒；失败或歧义后停止后续新调用、不自动重发，已在途请求仍可能结束。正常完成后重启并重放三条输入，验证新 Provider 调用为 0、Head 不变。该命令不是无人值守 CI 测试。

当前本机进程、User、Machine 三处均未发现 `DEEPSEEK_API_KEY`，所以本轮没有发起 Flash 请求，也没有验证模型远端可用性。以前的成功不能替代本轮证据。

## 本次主线实测：Evidence → Finding → Path

- **E-001**：运行 `node --import tsx tests/experiments/ollama-qwen35-4b.ts`，本机证据目录 `.tmp/ollama-qwen35-4b-2026-09-05T09-50-24-988Z/`。玩家输入 accepted；6 次模型返回（Root 2 次，两个 reaction wave 共 4 次）；最终 `headSeq=78, tick=3`，Cycle 以 `deadline_reached` 收口。模型单次耗时约 6.6～26.1 秒；本轮同时运行回归测试，不作为独立性能基准。
- **F-001（E-001）**：正式世界管线可以承接本地模型与多 wave，慢响应没有造成 claim 过期提交失败；这不意味着所有超时/异常都已验证。
- **F-002（E-001）**：重复发言仍明显，Alice 在后续 wave 将 Bob 的第一人称经历当作自己的经历。真实模型体验尚未达标；本轮不是知识泄漏修复验收，也没有用提示词掩盖问题。
- **Path**：保留本次基础提示结果作为对照；在凭证可用后用 Flash 的 ownership_clear / turn_taking 做同世界多轮观察，优先核对身份归属、自然停止和玩家插话，再决定最小修改。不先扩建记忆架构或继续十万条历史优化。

本文按 docs-generator 的渐进披露和证据链组织。原始模型响应不收入 Git，文档只记录聚合结果和可复现路径。

本机完整 `pnpm check` 退出码 0：81 个文件、868 项 coverage 测试通过，生产四项覆盖率均为 100%，P0～P6、3 项 P8 查询基准及 33 项子进程硬崩溃测试通过。真实模型调用仅手动执行，不进入 CI；远程 CI 本轮未执行。
