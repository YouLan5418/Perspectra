# Windows x64 便携测试包构建

2026-10-24 起，本轮只构建 Perspectra 程序，不附带试玩包。版本读取根 `package.json`（当前 0.3.1），随包 `worldpack.cmd --version` 使用同一版本；Tauri 自身应用版本仍由其配置管理。历史 test3 记录见 docs/current/studies。以下从仓库根目录执行。构建机需要现有 pnpm/Cargo/Node；玩家机不需要这些开发工具。

## 素材

- Node：构建机当前 Windows x64 Node v24.14.1，复制其 node.exe；许可证缓存为 `.tmp/portable-release-assets/NODE-LICENSE.txt`（Node 官方 v24.14.1 LICENSE）。
- Python：现有 `.tmp/hindsight-vector-venv/pyvenv.cfg` 的 home 指向独立 CPython 3.12，复制实际文件及基础环境 site-packages，再以 venv 的 site-packages 覆盖。当前 venv 使用 include-system-site-packages=true，numpy/ONNX 等来自基础环境，不能只复制 venv 中的 pip。不要复制 junction 本身。可用 `PERSPECTRA_BUILD_PYTHON_HOME` 指定相同架构且带齐依赖的安装目录。
- WebView2：Microsoft Fixed Version 154.0.4258.62 x64，完整展开到 `.tmp/portable-release-assets/webview2`，目录中必须有 msedgewebview2.exe。保留发行包原有文件。
- CRT：非调试 x64 `Microsoft.VC145.CRT` 的十个 DLL，当前核对的 DLL 文件版本为 **14.50.35719.0**（旧构建记录的 14.50.35710 是旧标签，不能代替文件版本），缓存为 `.tmp/portable-release-assets/msvc-crt`，复制到 Launcher/Node/Python 目录。可用 `PERSPECTRA_BUILD_CRT_DIR` 指定相同素材目录，不从 System32 取文件。许可缓存为 `.tmp/portable-release-assets/MSVC-RUNTIME-LICENSE.docx`，来源 [运行库许可](https://visualstudio.microsoft.com/license-terms/vs2026-ga-visualcpp-v14-redist-runtime/)。
- E5：`.tmp/hindsight-e5-small` 中六个资产；构建时按 desktop/host/memory/python/core/e5-assets.json 校验。资产实际仓库是 Xenova/multilingual-e5-small，原始模型是 intfloat/multilingual-e5-small。
- 模型说明缓存：`.tmp/portable-release-assets/E5-MODEL-CARD.md`、`E5-BASE-MODEL-CARD.md`。

来源：[WebView2 分发](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution)、[uv Python 发行说明](https://docs.astral.sh/uv/concepts/python-versions/)、[ONNX 模型](https://huggingface.co/Xenova/multilingual-e5-small/tree/761b726dd34fb83930e26aab4e9ac3899aa1fa78)、[Node 许可证](https://github.com/nodejs/node/blob/v24.14.1/LICENSE)。

本机 2026-10-24 恢复：从保留的 `D:/DeepSeek Harness/Perspectra-0.1.0-test1-win-x64` 只复制完整 `runtime/webview2`、根目录十个 CRT DLL、`runtime/NODE-LICENSE.txt` 和 licenses 内上述三份许可／模型说明到对应缓存；未复制旧游戏内容或实例。WebView2 主程序和 vcruntime140.dll 的微软 Authenticode 状态为 Valid，旧 Node 与本机 Node 的 SHA-256 相同。具体恢复来源、时间与实物版本记在被 Git 忽略的 `.tmp/portable-release-assets/asset-provenance.json`。其他构建机需自行准备相同来源素材，不依赖该本机路径。

## 命令

只检查创作 CLI 时，不必先准备 Python、E5、WebView2 和 Tauri EXE：

```powershell
node scripts/release/verify-worldpack-cli.mjs
```

此命令在新临时目录创建 CLI、Node 与 jieba-wasm 的隔离布局，并在空 PATH、源码外工作目录中实际运行 `worldpack.cmd`。覆盖版本、帮助、校验、编译、概要、适配、本地数据库初始化，以及参数、源格式、引用和缺失目录错误；还验证校验不会执行玩法脚本。产物和夹具目录写在末尾 JSON 的 `root`、`evidenceDirectory`。可传已构建程序根目录，改为检查实际发行载荷：`node scripts/release/verify-worldpack-cli.mjs <程序目录>`。此检查不是可公开分发的完整程序包，也不代替完整宿主或真实体验验收。

同一构建函数还复制仓库 `skills/perspectra-creator` 到程序根目录的 skills，过滤 Python 缓存。统一 Skill 包含原创世界包、静态酒馆卡迁移和原生预设创作。另运行 `node scripts/release/verify-creator-skill.mjs <完整程序目录>`，使用实际随包 Node 创建源包并检查拒绝覆盖、文档 JSON 和物品脚本模板；随包 Python 提取合成 PNG／JSON 卡，检查脚本与正则原文、容量报告和拒绝覆盖；随包 CLI 校验两种原生预设模板并拒绝交换格式混用、未知字段／宏和未来格式版本，再编译适配世界包。此检查需要完整载荷中的 Python，不使用真实私人卡片，也不执行原卡脚本或真实模型调用。输出 sourceDirectory 可作为后续 `verify-portable.mjs` 的外部源包参数，检查宿主扩展与包推荐预设启动；夹具不进入程序载荷。Skill 的 Markdown 结构校验不能代替这些可执行检查。

只核对本次宿主与 Core 目录迁移时，可先构建源码，再运行隔离布局的离线检查。它在全新的 `.tmp/core-layout-*` 目录验证单次 Python 请求、常驻 worker、本地 E5，以及构建后端在源码仓库、构建产物目录（`dist/backend`）和隔离便携目录三种布局下的默认 Core HTTP 启动。不调用外部模型，也不复制完整 Python/WebView2/CRT；通过不代表 Tauri 界面、完整便携包或干净系统验收。

```powershell
corepack pnpm@11.7.0 launcher:build
corepack pnpm@11.7.0 desktop:build
node --import tsx scripts/release/verify-core-layout.mjs
```

完整便携包仍使用以下命令和上方所列全部素材：

```powershell
corepack pnpm@11.7.0 check
corepack pnpm@11.7.0 launcher:check
corepack pnpm@11.7.0 --filter @perspectra/launcher tauri build --no-bundle
node scripts/release/build-portable.mjs dist/portable/Perspectra-0.3.1-win-x64
node scripts/release/verify-portable.mjs dist/portable/Perspectra-0.3.1-win-x64 .tmp/portable-0.3.1-smoke examples/world-packs/prototype-g1 offline
node scripts/release/archive-portable.mjs dist/portable/Perspectra-0.3.1-win-x64
```

输出目录必须不存在；验收数据目录必须全新。`verify-portable.mjs` 用构建机 esbuild 生成前端比对值，再规范化内嵌脚本的局部变量名，避免源码加载器或整包符号重命名导致无意义差异；HTML/CSS 和可观察字符串仍参加比对。它不会给玩家增加开发依赖。第三个参数是另行准备的源包目录，验收夹具不会被加入程序载荷；检查程序包没有 `examples`，并运行随包 CLI、载入／实例／Core 生命周期、前端一致性及离线编码。以上命令末尾 `offline` 跳过真实连接，报告明确标注；去掉它会请求本机 8046/gemini-3.7-flash，需服务可用。它不代替界面试玩、完整玩法或干净系统验收，也不再验收官方试玩包序章。

Windows 原生启动另行验证：2026-10-24 复现工作区 candidate4 的 Perspectra.exe 继承 Low Mandatory Level，启动返回 101，WebView2 报 0x800700AA；同一 ZIP 在普通用户目录重新解压后，EXE 摘要不变，原生窗口及完整界面可打开。因此不能只在工作区内运行宿主脚本就算原生启动通过。完成本地 ZIP 后，还应在普通用户目录完整解压，以独立测试数据启动 Perspectra.exe，确认可见窗口和界面初始化，再关闭诊断实例。不要为通过检查修改工作区范围的安全权限、删除 WebView 缓存或操作玩家存档；源码开发沿用 launcher:desktop 的正常用户 Cargo 输出目录。普通目录启动通过仍不是干净 Windows 或真实玩法验收。

压缩前将本轮真实验收结果写入包根目录 `验收记录.md`；归档脚本拒绝缺少记录、存在链接或已有 ZIP 的目录。不得使用临时带调试参数的 Tauri 配置构建最终 EXE。

包中不复制源码工作树、私人实例、试玩包或测试数据。根目录提供 `worldpack.cmd`、`创作校验.md`、`使用说明.md`，runtime 内含其捆绑入口与依赖。build-info.json 记录是否有试玩包、CLI 入口、源提交及构建时工作树是否有改动；工作树有改动时不能把 sourceCommit 当作完整源码快照。Rust 清单由目标平台 cargo metadata 离线生成，包含构建相关依赖；它是随包许可资料，不表示完整法律审查。
