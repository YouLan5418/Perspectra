# Node Core 记忆迁移（未切换生产）

## 2026-11-17：本机对照与整理阶段

例如角色听到“我不确定他来了”，Node Retain 仍保存完整否定与不确定性；模型不能只截取“他来了”。玩家说“已经开门成功”也不能覆盖规则给出的 rejected 结果。经历分组引用原 Atom，主观认识保留支持与反证，不改写原始经历。

从 `codex/node-core-memory` 接入主线 `main` 工作树 `D:/DeepSeek Harness/Perspectra-composable-impl`。原 `Perspectra V1` 工作树及其中未提交内容保持不动。以下结果替代旧云端的“资产不可得”阻塞，旧记录保留其当时范围。

本轮新增：

- `src/node/archive.ts` 移植 Source / Atom / 聚合证据校验和 Host 行动投影；复用现有 WorldJson、角色 ID 和地址，没有新建 provider、存储格式或迁移协议。
- `src/node/episodes.ts` 移植 Retain / Group / Consolidate，保留原提示词及 utility prompt 缩减。模型调用作为函数注入，尚未接通生产模型传输。
- `src/node/retain-prefix.ts` 移植按完整 Source 分批、旧 Atom 前缀复用和 1–4 个并发整理；失败停止分配新批次，并等待已开始调用结束再拒绝，不产生部分成功档案。
- `episodes-oracle.py` / `episodes-parity.ts` 使用原 Python 实现与固定模型答案对照非空档案、实际提示词和错误路径，不用远端模型或假向量替代 E5 验收。

已实际验证：

- 本机 Node 24.14.1；CPU ORT Node 1.22.0 / Python 1.22.1；六项固定资产通过编码器哈希校验。
- E5 12 输入（中英、别名、否定、组合 Unicode、空串、长串及跨批），query / passage token ID 精确一致；最大坐标误差均为 **0**，同侧及 query→passage 全候选排序一致。修复 Windows oracle 缺少显式 UTF-8 标准输入导致的错误。
- 整理 17 项 Python / Node 对照全部一致，包含完整原始提示字符串（含 JSON 空格）、支持／反证更新、旧前缀复用、角色／分支／未来来源拒绝及证据篡改；输入档案未被修改。独立审查发现并修复前导换行导致首句被误丢弃的问题，新增了对应实体线索回归。
- 独立临时目录真实执行 Windows x64 CPU E5 推理，384 维及归一化通过；缺资产拒绝通过，未复制 Python。esbuild 使用 `write: false` 后由父进程写出，适配本机临时目录 ACL。此结果只证明编码器布局，不是完整 Host 发行包。
- Node 单测与现有 Host 记忆回归最终复跑：4 文件 **45 项通过**（E5 7 项、新整理 8 项、原 Host 30 项），不将中间复跑重复相加。
- 原 Python 记忆桥接 28 项全部通过；显式设置 `HCW_HINDSIGHT_ONNX_DIR` 为本机资产目录，原有两个默认资产定位失败已消除。
- 类型检查、定向 Lint、格式及宿主边界检查通过。文档链接检查仍报告 103 条已有错误；用 HEAD 版认知文档只读替换对照后，诊断数量与内容完全不变。本轮新增链接有效；没有扩大为历史研究文档清理。
- 独立审查报告的唯一 P2（前导空白丢首句）已修复；审查者独立确认两句、实体及 Atom 顺序，并复跑 17/17 对照通过，未发现其他 P1/P2。此结论限于当前整理阶段。

报告保存在忽略目录 `.tmp/node-memory/{e5-parity,episodes-parity,layout}.json`。复现：

```powershell
node --import tsx experiments/node-memory/e5-parity.ts .tmp/hindsight-vector-venv/Scripts/python.exe .tmp/hindsight-e5-small
node --import tsx experiments/node-memory/episodes-parity.ts .tmp/hindsight-vector-venv/Scripts/python.exe
node --import tsx experiments/node-memory/check-layout.ts .tmp/hindsight-e5-small
```

**生产边界尚未切换**：默认 provider、Recall、Delivery、索引构建、模型协议／重试、Host／Launcher 装配仍为 Python。新整理阶段尚未接入真实记忆模型或完成角色试玩；新旧档案／故事树恢复及 runtime identity 兼容性仍未验收。不能移除 Python、重发便携包或承诺旧存档可重开。

下一阶段继续移植 alias/query/retrieval projection 与现行 quality Recall、候选准入和 minimal Delivery；不要把历史 graph/temporal 实验变体重新接回默认路径。完整非空 build / recall、权限与前缀、故事分叉／恢复和 Node-only 打包验证完成后，再切换生产入口。

## 第一里程碑历史记录

基线 `8c6a33f03e444275e031870656ee98d5da150942`，独立工作区 `/workspace/Perspectra-node-memory`，本地分支 `codex/node-core-memory`。当前是可审查的离线编码器实现和对照工具，**不是已完成的 Python 移除补丁**。默认长期记忆仍走原实现；不要用本批替代玩家运行包或给旧存档作迁移承诺。

## 已落地

- `packages/memory-core/src/node/e5.ts`：固定本地资产六项 SHA-256；固定 revision `761b726dd34fb83930e26aab4e9ac3899aa1fa78`，query/passage 前缀、256 token 上限、批量 8；按 Python Unicode 码点长度分批并恢复输入次序；masked mean 和 L2。严禁运行时下载，不接受哈希不符的模型。Hindsight MIT 移植归属及原许可证保留。
- `e5-worker.ts` / `e5-client.ts`：重计算在独立 Node worker；一个进行中请求、取消终止线程、超时、关闭、错误不带私密文本/路径。线程环境不继承模型密钥。并未注册为新的记忆 provider。
- `@huggingface/tokenizers@0.2.0` 和 `onnxruntime-node@1.22.0` 精确锁定。ONNX 安装脚本禁用，因为 CPU 绑定已经随 npm 包提供；不下载可选 CUDA。Python oracle 仍用仓库要求的 ORT 1.22.1，这个补丁版本差异必须由数值对照确认。
- `e5-oracle.py` 调用现有 vendored encoder；`e5-parity.ts` 检查中文、别名、否定、Unicode、空串、长文本、跨批：token IDs 必须精确；最大坐标误差不超过 `2e-5`；同侧与真实 query→passage 全候选排序必须相同。公差目前是预先设定的验收线，**尚未测出满足**，不应自动放宽。
- `check-layout.ts`：将 worker 由 esbuild 打包，外置原生 ORT 并复制 CPU 依赖到独立临时目录，不复制 Python 文件。确认 Linux 原生绑定实际加载，随后因缺资产按预期拒绝。Windows x64 的 `.node` / DLL 只检查存在，未执行。

## 真实阻塞和结果

2026-11-16 从官方 Hugging Face 仓库读取固定 revision，第一个 `config.json` 即被云代理拒绝：`Tunnel connection failed: 403 Forbidden`。经批准执行同一下载仍为相同结果。没有改用镜像、其他 revision、远端向量接口或假向量。工作区没有找到既有 E5 资产。

官方 npm / PyPI 依赖安装成功，Python oracle 环境在忽略目录 `.tmp/oracle-venv`。Node 24.19.0 / pnpm 11.7.0；Linux CPU ORT 原生导入版本为 1.22.0。

检查记录（`.tmp/node-memory/`）：

- frozen-lockfile 离线安装通过；Typecheck 通过；Lint 退出 0（保留已有警告）；生产边界通过 447 文件。
- `corepack pnpm@11.7.0 test:related tests/host/core-worker.test.ts tests/host/core-memory.test.ts packages/memory-core/src/node/e5.test.ts`：3 文件、37 项通过，22.20 秒。新 7 项中包含分批/池化、资产篡改拒绝、缺资产worker、进行中取消/并发、推理失败 Tensor 释放。合成张量和 busy worker 只证明局部算法/生命周期，不证明 E5 向量等价。
- Python 原桥接回归 `test_core_bridge.py`：28 项中 26 通过、2 项因 tokenizer.json 缺失报错；不是 TS 回归，也没有过滤这两项。
- `e5-parity.ts` 实际启动后因本地资产缺失失败，未产生成功 parity 报告。未测 token 精确性、真实向量、排名、非空档案完整新旧 golden。
- 隔离 CPU 布局小样通过；没有完成整个 Host/Launcher 的 Node-only 装配、真实 E5 推理或便携发行验收。

## 实际调用链及剩余迁移

`core-provider.ts::coreMemoryProvider` 保留 `official-memory-core` 身份和 `ctx.memory` 契约，组装 `coreRunnerGroups`。`CoreMemoryAdapter.project` 对授权档案请求 `recall`（当前默认 `deliveryMode: minimal`）；后台整理从已授权来源调用 `build`，带可复用的 retainedPrefix。`python-worker.ts` 为 recall 保持惰性进程，为 build 使用一次性进程，按模型配置分组。

Python `core_bridge.dispatch_operation`：

1. build：检查 Source → `retain_prefix` / `episode_core.retain` 选择原文 Atom → group Episode → consolidate Observation → 时间/活动绑定与完整验证 → alias/retrieval projection → E5 index。
2. recall：验证档案、scope 与角色 → 授权 query projection → BM25 / E5 / 实体臂及既有 RRF → candidate admission → minimal delivery。不得把历史实验里的旧 graph/temporal 变体当作新的默认算法。
3. reproject：桥接支持的档案派生重投影入口；当前 TS `CoreMemoryAdapter` 没有调用它，研究/离线桥接入口仍需迁移覆盖。

`snapshotArchives` / `restoreArchives` 已在 TS 侧；恢复不应该调用 build。Python 的 Source/Atom/Episode/Observation 验证、模型协议/重试/解析、检索与交付仍未移植，因真实 E5 parity 尚未建立，没有提前更换默认路径。后续还需 Node-only 默认 Host/Launcher 的非空 build/recall、角色私密/来源前缀、同历史分叉恢复和整树导入验收。

**兼容性尚未验收**：虽然 provider 和档案校验代码未改，`tail-runtime-identity.ts` 会散列 `pnpm-lock.yaml`，本批依赖变化已可能改变 runtime identity。不能据“未改档案格式”声称旧档可直接重开；后续必须明确处理同历史安全重建/身份迁移，不能放宽已有检查。

目前 `copy-memory-runtime.mjs`、便携构建及原 provider 仍保留 Python，不将未验证的小样伪装成完整运行时。CI/CD、GitHub、私人世界包和其他工作区没有修改。

## 继续验证

在具备固定资产的云环境运行，不需要用户 Windows 或付费 API：

```sh
# 用原官方 setup 下载；仅开发准备允许下载，生产编码器永不下载。
HCW_HINDSIGHT_ONNX_DIR="$PWD/.tmp/hindsight-e5-small" .tmp/oracle-venv/bin/python packages/memory-core/python/core/setup-vector.py
node --import tsx experiments/node-memory/e5-parity.ts .tmp/oracle-venv/bin/python .tmp/hindsight-e5-small
node --import tsx experiments/node-memory/check-layout.ts
```

需先让云任务能够访问官方固定资产，或将该六项原始资产安全提供给云任务并全部通过已有哈希。不得只提供“同名模型”替代。

参考：[ONNX Runtime 官方 Node 安装](https://onnxruntime.ai/docs/get-started/with-javascript/node.html)、[Hugging Face 官方 tokenizer.js](https://github.com/huggingface/tokenizers.js)。当前 tokenizer 兼容性仍待 oracle 验证。

独立 GPT-6.1 Sol 审查与复审：修复推理失败时 Tensor 释放、补 query→passage 排序对照及进行中取消/并发测试；复审通过。审查者独立重跑 7 项测试和隔离布局通过，未声称真实 E5 等价或完整迁移。
