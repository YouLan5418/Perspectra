# Windows x64 便携测试包构建

2026-10-24 起，本轮只构建 Perspectra 程序，不附带试玩包。版本读取根 `package.json`（当前 0.3.5），随包 `worldpack.cmd --version` 使用同一版本；2026-10-29 起 Launcher 的 package.json、Tauri 配置与 Cargo 包版本也统一为根版本（2026-10-30 起 0.3.5）。历史 test3 记录见 docs/current/studies。以下从仓库根目录执行。构建机需要现有 pnpm/Cargo/Node；玩家机不需要这些开发工具。

## 素材

- Node：构建机当前 Windows x64 Node v24.14.1，复制其 node.exe；许可证缓存为 `.tmp/portable-release-assets/NODE-LICENSE.txt`（Node 官方 v24.14.1 LICENSE）。记忆 Core 和 E5 编码由随包 Node worker 与 `onnxruntime-node` 提供，不复制 Python 解释器或 Python 源码。
- Node 记忆依赖：`scripts/build/copy-memory-runtime.mjs` 将 Core/E5 worker 打包到 `runtime/memory-core/node`，并按构建机 `process.platform/process.arch` 复制 `onnxruntime-node`、`onnxruntime-common` 与 CPU 原生库。该通用复制器跟随当前构建机平台；本便携脚本单独只接受 Windows x64。
- WebView2：Microsoft Fixed Version 154.0.4258.62 x64，完整展开到 `.tmp/portable-release-assets/webview2`，目录中必须有 msedgewebview2.exe。保留发行包原有文件。
- CRT：非调试 x64 `Microsoft.VC145.CRT` 的十个 DLL，当前核对的 DLL 文件版本为 **14.50.35719.0**（旧构建记录的 14.50.35710 是旧标签，不能代替文件版本），缓存为 `.tmp/portable-release-assets/msvc-crt`，复制到 Launcher 与 Node 目录。可用 `PERSPECTRA_BUILD_CRT_DIR` 指定相同素材目录，不从 System32 取文件。许可缓存为 `.tmp/portable-release-assets/MSVC-RUNTIME-LICENSE.docx`，来源 [运行库许可](https://visualstudio.microsoft.com/license-terms/vs2026-ga-visualcpp-v14-redist-runtime/)。
- E5：先运行 `node scripts/setup-memory-assets.mjs` 准备六个本地文件；脚本只用于开发／发行准备，运行时不会下载。打包时按根部 `packages/memory-core/e5-assets.json` 校验 SHA-256，再复制到 `runtime/models/e5-small`。资产实际仓库是 Xenova/multilingual-e5-small，原始模型是 intfloat/multilingual-e5-small。
- 模型说明缓存：`.tmp/portable-release-assets/E5-MODEL-CARD.md`、`E5-BASE-MODEL-CARD.md`。

来源：[WebView2 分发](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution)、[ONNX 模型](https://huggingface.co/Xenova/multilingual-e5-small/tree/761b726dd34fb83930e26aab4e9ac3899aa1fa78)、[Node 许可证](https://github.com/nodejs/node/blob/v24.14.1/LICENSE)。

本机 2026-10-24 恢复：从保留的 `D:/DeepSeek Harness/Perspectra-0.1.0-test1-win-x64` 只复制完整 `runtime/webview2`、根目录十个 CRT DLL、`runtime/NODE-LICENSE.txt` 和 licenses 内上述三份许可／模型说明到对应缓存；未复制旧游戏内容或实例。WebView2 主程序和 vcruntime140.dll 的微软 Authenticode 状态为 Valid，旧 Node 与本机 Node 的 SHA-256 相同。具体恢复来源、时间与实物版本记在被 Git 忽略的 `.tmp/portable-release-assets/asset-provenance.json`。其他构建机需自行准备相同来源素材，不依赖该本机路径。

## 命令

只检查创作 CLI 时，不必先准备 Python、E5、WebView2 和 Tauri EXE：

```powershell
node scripts/release/verify-worldpack-cli.mjs
```

此命令在新临时目录创建 CLI、Node 与 jieba-wasm 的隔离布局，并在空 PATH、源码外工作目录中实际运行 `worldpack.cmd`。覆盖版本、帮助、校验、编译、概要、适配、本地数据库初始化，以及参数、源格式、引用和缺失目录错误；还验证校验不会执行玩法脚本。产物和夹具目录写在末尾 JSON 的 `root`、`evidenceDirectory`。可传已构建程序根目录，改为检查实际发行载荷：`node scripts/release/verify-worldpack-cli.mjs <程序目录>`。此检查不是可公开分发的完整程序包，也不代替完整宿主或真实体验验收。

同一构建函数还复制仓库 `skills/perspectra-creator` 到程序根目录的 skills，排除 `.py`、Node 测试文件、Python 缓存及 Git Bash 重定向遗留的空 nul 文件；源目录保留原样。Skill 的静态酒馆卡提取器使用随包 Node，不执行原卡脚本。运行 `node scripts/release/verify-creator-skill.mjs <完整程序目录>`，使用实际随包 Node 检查脚手架拒绝覆盖、合成卡片 PNG／JSON 提取与容量报告、预设模板和 CLI；同时在空 PATH 下用真实宿主离线推演随 skill 的手写活动，检查低代码草稿导出后能重开编辑。本项回归仅用合成测试材料与脚本模型。输出 sourceDirectory 可作为后续 `verify-portable.mjs` 的外部源包参数，检查宿主扩展与包推荐预设启动；夹具不进入程序载荷。Skill 的 Markdown 结构校验不能代替这些可执行检查。

只核对本次宿主与 Core 目录迁移时，可运行 Node 隔离布局检查。它在全新的 `.tmp/core-layout-*` 目录分别验证 TypeScript 源码、仓库 cwd 下无 `PERSPECTRA_RUNTIME_ROOT` 的 bundled backend、隔离 Node runtime；每种布局都会启动默认 Core HTTP Host、实际调用 Core worker 和本地 E5 CPU worker。检查不调用外部模型，隔离布局只复制 Node worker、原生 ONNX 依赖和六个模型资产；通过不代表 Tauri 窗口、完整便携包或干净系统验收。

```powershell
corepack pnpm@11.7.0 launcher:build
corepack pnpm@11.7.0 desktop:build
node scripts/release/verify-core-layout.mjs
```

完整便携包仍使用以下命令和上方所列全部素材：

```powershell
corepack pnpm@11.7.0 check
corepack pnpm@11.7.0 launcher:check
corepack pnpm@11.7.0 --filter @perspectra/launcher tauri build --no-bundle
node scripts/release/build-portable.mjs dist/portable/Perspectra-0.3.5-win-x64
node scripts/release/verify-portable.mjs dist/portable/Perspectra-0.3.5-win-x64 .tmp/portable-0.3.5-smoke examples/world-packs/prototype-g1 offline
node scripts/release/archive-portable.mjs dist/portable/Perspectra-0.3.5-win-x64
```

输出目录必须不存在；验收数据目录必须全新。`verify-portable.mjs` 用构建机 esbuild 生成前端比对值，再规范化内嵌脚本的局部变量名，避免源码加载器或整包符号重命名导致无意义差异；HTML/CSS 和可观察字符串仍参加比对。它不会给玩家增加开发依赖。第三个参数是另行准备的源包目录，验收夹具不会被加入程序载荷；检查程序包没有 `examples` 或 Python runtime，校验 Node worker/平台原生文件与六个 E5 哈希，使用随包 node.exe 执行真实 CPU E5 编码，再运行随包 CLI、载入／实例／Core 生命周期和前端一致性。以上命令末尾 `offline` 跳过真实模型连接，报告明确标注；去掉它会请求本机 8046/gemini-3.7-flash，需服务可用。它不代替界面试玩、完整玩法或干净系统验收，也不再验收官方试玩包序章。

Windows 原生启动另行验证：2026-10-24 复现工作区 candidate4 的 Perspectra.exe 继承 Low Mandatory Level，启动返回 101，WebView2 报 0x800700AA；同一 ZIP 在普通用户目录重新解压后，EXE 摘要不变，原生窗口及完整界面可打开。因此不能只在工作区内运行宿主脚本就算原生启动通过。完成本地 ZIP 后，还应在普通用户目录完整解压，以独立测试数据启动 Perspectra.exe，确认可见窗口和界面初始化，再关闭诊断实例。不要为通过检查修改工作区范围的安全权限、删除 WebView 缓存或操作玩家存档；源码开发沿用 launcher:desktop 的正常用户 Cargo 输出目录。普通目录启动通过仍不是干净 Windows 或真实玩法验收。

压缩前将本轮真实验收结果写入包根目录 `验收记录.md`；归档脚本拒绝缺少记录、存在链接或已有 ZIP 的目录。不得使用临时带调试参数的 Tauri 配置构建最终 EXE。

包中不复制源码工作树、私人实例、试玩包或测试数据。根目录提供 `worldpack.cmd`、`创作校验.md`、`使用说明.md`，runtime 内含其捆绑入口与依赖。build-info.json 记录是否有试玩包、CLI 入口、源提交及构建时工作树是否有改动；工作树有改动时不能把 sourceCommit 当作完整源码快照。Rust 清单由目标平台 cargo metadata 离线生成，包含构建相关依赖；它是随包许可资料，不表示完整法律审查。

## 随包文档清单

2026-10-29 对照 build-portable.mjs、build-worldpack-cli.mjs 与 archive-portable.mjs 核对。比如创作者在没有源码的电脑上让 AI 制作钥匙交接，程序包要提供操作说明和完整 Skill，使 AI 能从包内找到格式、模板与校验步骤；源码调研、架构历史不参与这个流程。本次仅同步文档，没有生成新的程序包。

| 包内位置 | 来源与用途 | 怎样进入程序包 |
| --- | --- | --- |
| 使用说明.md | scripts/release/README.zh-CN.md；启动、模型、保存与权限 | build-portable.mjs 复制 |
| 创作校验.md | scripts/release/CREATOR.zh-CN.md；CLI、构建识别、创作与验收范围 | build-worldpack-cli.mjs 复制 |
| skills/perspectra-creator/ | 完整 Skill：SKILL.md、references、scripts、assets、agents；离线创作参考与模板 | build-worldpack-cli.mjs 整目录复制，排除 `.py`、Node 测试文件、Python 缓存及 nul 文件；不能只带 SKILL.md |
| 反馈模板.md | scripts/release/feedback-template.zh-CN.md；复现信息与隐私提示 | build-portable.mjs 复制 |
| 干净系统验收.md | scripts/release/clean-windows-checklist.zh-CN.md；测试版验收步骤，不代表已经通过 | build-portable.mjs 复制 |
| 验收记录.md | 本次实际构建、自动检查、原生启动、真实试玩及未测范围 | 验收后写到包根目录；archive-portable.mjs 要求存在，不能沿用旧包结论 |
| build-info.json | 构建时间、版本、sourceCommit、sourceDirty、CLI／Skill 入口及运行环境身份 | build-portable.mjs 生成，随包保留 |
| licenses/ 与 runtime 内许可证 | Node／原生依赖、WebView2／CRT、记忆组件和模型相关许可资料 | 按现有构建脚本复制或收集，随对应运行环境保留 |

仓库的 docs/current/guides/world-pack-authoring.md 是带源码、示例和专题链接的创作总入口；不应单独改名复制到包根目录，否则离线阅读会出现断链。当前程序包用创作校验.md 和 Skill 内的 world-pack.md／gameplay.md／presets.md 提供不依赖仓库的创作入口。若以后要求分发完整离线字段手册，需先整理不依赖源码导航的版本并核对全部引用，再纳入构建；当前脚本不会自动复制 docs/current。

本次同步的 web-ui.md、frontend-stage.md、creator-runtime.md、frontend-v1.md 和中英文 PROJECT-STATE 属于仓库技术说明与证据导航，无需逐份放进程序包。保留在仓库即可；其中影响玩家／创作者操作的结论已同步到上表的使用说明、创作校验和 Skill。打包时使用同一工作树的程序与这些文档，并在验收记录说明所用源码和未验证能力；不能仅凭 0.3.1／v5／编译器 0.5.0 相同就宣称完整活动状态调度等能力可用。
