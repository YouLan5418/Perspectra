# Windows x64 便携测试包构建

候选版本：0.1.0-test1。从仓库根目录执行。构建机需要现有 pnpm/Cargo/Node；玩家机不需要这些开发工具。

## 素材

- Node：构建机当前 Windows x64 Node v24.14.1，复制其 node.exe；许可证缓存为 `.tmp/portable-release-assets/NODE-LICENSE.txt`（Node 官方 v24.14.1 LICENSE）。
- Python：现有 `.tmp/hindsight-vector-venv/pyvenv.cfg` 的 home 指向 uv 管理的独立 CPython 3.12，复制实际文件；再复制此 venv 的 site-packages。不要复制 junction 本身。可用 `PERSPECTRA_BUILD_PYTHON_HOME` 指定相同架构的安装目录。
- WebView2：Microsoft Fixed Version 154.0.4258.62 x64，完整展开到 `.tmp/portable-release-assets/webview2`，目录中必须有 msedgewebview2.exe。保留发行包原有文件。
- CRT：MSVC 14.50.35710 非调试 `x64/Microsoft.VC145.CRT` 的十个 DLL，缓存为 `.tmp/portable-release-assets/msvc-crt`，复制到 Launcher/Node/Python 目录。可用 `PERSPECTRA_BUILD_CRT_DIR` 指定目录，不从 System32 取文件。许可缓存为 `.tmp/portable-release-assets/MSVC-RUNTIME-LICENSE.docx`，来源 [运行库许可](https://visualstudio.microsoft.com/license-terms/vs2026-ga-visualcpp-v14-redist-runtime/)。
- E5：`.tmp/hindsight-e5-small` 中六个资产；构建时按 experiments/hindsight-core/e5-assets.json 校验。资产实际仓库是 Xenova/multilingual-e5-small，原始模型是 intfloat/multilingual-e5-small。
- 模型说明缓存：`.tmp/portable-release-assets/E5-MODEL-CARD.md`、`E5-BASE-MODEL-CARD.md`。

来源：[WebView2 分发](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution)、[uv Python 发行说明](https://docs.astral.sh/uv/concepts/python-versions/)、[ONNX 模型](https://huggingface.co/Xenova/multilingual-e5-small/tree/761b726dd34fb83930e26aab4e9ac3899aa1fa78)、[Node 许可证](https://github.com/nodejs/node/blob/v24.14.1/LICENSE)。

## 命令

```powershell
corepack pnpm@11.7.0 check
corepack pnpm@11.7.0 launcher:check
corepack pnpm@11.7.0 --filter @perspectra/launcher tauri build --no-bundle
node scripts/release/build-portable.mjs dist/portable/Perspectra-0.1.0-test1-win-x64
node scripts/release/verify-portable.mjs dist/portable/Perspectra-0.1.0-test1-win-x64 .tmp/portable-smoke-new
node scripts/release/archive-portable.mjs dist/portable/Perspectra-0.1.0-test1-win-x64
```

输出目录必须不存在；验收数据目录必须全新。verify 使用本机 8046/gemini-3.7-flash，包含一次真实连接请求，需服务可用。它不代替界面试玩或干净系统验收。

压缩前将本轮真实验收结果写入包根目录 `验收记录.md`；归档脚本拒绝缺少记录、存在链接或已有 ZIP 的目录。不得使用临时带调试参数的 Tauri 配置构建最终 EXE。

包中不复制源码工作树、私人实例或测试数据。Rust 清单由目标平台 cargo metadata 离线生成，包含构建相关依赖；它是随包许可资料，不表示完整法律审查。
