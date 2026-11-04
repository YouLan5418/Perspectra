# 插件优先运行时：阶段 9

日期：2026-11-04。分支 codex/plugin-first-next-seams，基线 98df92d。接续[实施方案](../../superpowers/plans/2026-11-04-plugin-first-next-seams.md)。

例如玩家已有喜欢的角色预设与文本规则，只想更换模型发送地址，现在可以启用 [simple-transport](../../../examples/host-plugins/simple-transport.mjs)。它只发送官方准备好的消息、Schema 与生成设置；官方继续执行预设上下文、节点、附加提示、输出和展示规则。原 simple-llm 仍表示完整通道替换，不会被静默包装。

## 已接通

宿主 API 升至 2.3，新增 `ctx.llm.registerTransport`，与 `register` 共用原有单例槽位。完整通道与发送适配器互斥，Cordis 注册仍按插件生命周期回滚；Launcher 从清单 `llmMode: 'transport'` 显示“官方预设 + 插件名”，同一 llm 模块预测冲突。

[官方模型包装](../../../packages/official-llm/src/index.ts)保留准备与文本处理，[transport.ts](../../../packages/official-llm/src/transport.ts)负责调用、超时、记录与失败反馈；预设解析从角色连接中独立复用，没有新增包。发送返回后仍走主干格式、受众、裁定和提交。脚本演出依旧不发送，也不应用模型输出规则。

适配器通过 model 与 schemaMode 声明模型名及标准 Schema 形状，不依赖未使用的官方连接协议。send 收到 messages/schema/generation，不包含原模型连接、Key、原始授权请求对象或检查器。自己的凭证由 secret 配置传入。返回 `{ value, httpStatus? }`，HTTP 错误可携带 httpStatus；官方检查和玩家提示能关联实际适配器与 401 等状态。没有自动回退官方发送。

执行环境记录适配器 ID/版本/公开 identity；存档实际模块记录包含 official-llm 包装与发送适配器。候选重新生成独立打开/关闭发送实例，identity 改变拒绝旧候选。打开适配器后若预设装配失败，会清理该实例。

## 玩家输入与 Core 的实际边界

最初按旧名称把 player-intent/v1 当成模型解释开关，会错误拒绝当前大多数包。读到 [preparePlayerIntent](../../../packages/application/src/player-intent-preparation.ts) 后确认其只产生 directSubmission：当前命令与发言解析不调用模型 dispatch，因此不需要这项启动拒绝。发送模式不提供模型 dispatch，现有宿主回调若请求它会明确报不支持，不会转向原模型。

Core 不走本适配器，继续使用原记忆连接和预算；原决策连接的协议、Key 与思考档位不转交给适配器。本阶段不修改 Core 的传输接口，也不声称一个发送插件已经替换全系统模型调用。

## 检查记录的含义

记录保存实际交给适配器的标准消息、Schema、显式生成设置和模型返回，body.transport 标识该格式；不是最终 HTTP wire。适配器可自行编码、映射消息身份、附加协议字段；这些编码以及它报告的模型名仍由受信任插件负责。未捕获适配器的原始网络包、思考或 usage，不把估算 token 当成供应商账单。

## 验证

冻结生产源码运行完整 `corepack pnpm@11.7.0 check`，176 个文件、1710 项测试全部通过；Launcher 类型检查与 97 项单测通过。原有 Lint 警告保留。12 组离线请求和结果与原基线一致，覆盖默认 OpenAI、Google、Anthropic、预设、Core 注入替身及普通/自主/活动路径。

模型接缝与加载器相关 43 项测试通过，新增覆盖：未使用的官方地址不可用仍能发送、适配器 Schema 不受 Google 配置影响、预设提示与生成参数、输出/展示和检查、401、一次格式修正、脚本绕过、取消、候选实例清理与 identity 拒绝。示例凭证测试按真实装载路径从独立 secrets 参数注入，证明只发送自己的 Key，原模型 Key 不转交，检查记录不落两者。

后端构建通过。desktop-launch 回归补入发送适配器注册与实际模型标识检查，构建模式 1 项通过，验证新注册方法存在于构建后端。它不等于完整便携包、干净系统或 Tauri 窗口验收。

真实短局：[transport-seam-live.ts](../../../tests/experiments/transport-seam-live.ts)加载仓库示例，用 8045 的 gemini-3.8-flash 完成两轮对话及一次重新生成，共 3 次请求、约 15.0 秒。官方目标刻意设为不可用地址，预设提示与生成设置均保留，实际转录中的输出/展示校验标记生效，检查记录正确。生成文件扫描未发现进程中的凭证或官方凭证哨兵。它验证短程连通与规则，不代表角色体验长期稳定或真实 Core 归档验收。

本机证据位于工作树 `.tmp/plugin-first-next/phase9-*.log` 与 `.tmp/plugin-first-next/phase9-live/`。复跑命令：设置进程环境 PERSPECTRA_MODEL、PERSPECTRA_MODEL_ENDPOINT，可选 PERSPECTRA_MODEL_API_KEY，然后运行 `node --import tsx tests/experiments/transport-seam-live.ts <新数据目录>`。不要把凭证放进 URL、identity 或命令参数。

当前已完成源码、自动回归与上述短程验收；没有下载/市场、热更新、新模型网关、数据库或协议迁移。阶段 10～11 尚未实施；阶段 7 的单次晨间无请求观察也未因此被判定解决。
