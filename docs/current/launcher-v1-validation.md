> 本文为第一阶段 Mock 验收；后续真实运行验收见 [Core 接入记录](launcher-core-integration.md)。

# Launcher V1 原生验证记录

| 属性 | 内容 |
| --- | --- |
| 日期 | 2026-10-06 |
| 范围 | 第一阶段 Mock Launcher，实际 Tauri / Windows WebView2 |
| 结论 | 本轮范围通过，未发现需修改运行时代码的缺陷 |
| 工具链 | Rust/Cargo 1.99.0 stable x86_64-pc-windows-msvc；Tauri 2.12.1；WebView2 154.0.4258.53 |
| 交付程序 | apps/launcher/src-tauri/target/debug/perspectra-launcher.exe，默认配置重建完成 |
| 未覆盖 | 真实 Core、真实模型、包解析、存档持久化、安装包及操作系统 DPI 缩放 |

## 1. 实测方式

通过 [Playwright WebView2 CDP](https://playwright.dev/docs/webview2) 连接实际 Tauri 程序。确认页面 URL 是 http://tauri.localhost/，资源来自编译后的内置前端，未使用 Vite 页面。普通环境变量没有开启调试接口，因此使用 .tmp/launcher-native-verify/tauri-test.json 为测试构建临时设置 additionalBrowserArgs。

原生文件对话框通过 Windows 自带 UI Automation 定位本次验证进程的模态窗口，再操作已定位的 Win32 控件。未安装 OpenReverse，也未操作其他应用或历史试玩数据。文件只选取新建的 .tmp 测试对象。

## 2. 验证结果

| 场景 | 观察与证据 | 结果 |
| --- | --- | --- |
| 原生页面 | 主界面、全部入口与图标正常；Tauri 本地资源 URL | 通过 |
| 模型映射 | 默认、角色组、专属模型可选，保存后显示启用映射；默认关闭 | 通过 |
| 历史保留 | 第 80 轮创建新故事线后，原主线第 284 轮仍可选 | 通过 |
| 示例导入 | 创建新的本地实例，显示分享来源与第 173 轮；原实例保留 | 通过 |
| 导出范围 | 完整树预览显示当前实例三条故事线、四个历史节点 | 通过 |
| 设置取消/应用 | 取消不保留草稿；应用保留本次会话设置，模型空缺时可通过设置恢复 | 通过 |
| 无模型启动 | 选择暂不配置后继续按钮禁用；恢复配置后可用 | 通过 |
| 密钥展示/存储 | 输入框为 password；测试占位值不进入 localStorage/sessionStorage；测试后清空 | 通过 |
| Core 模拟状态 | 继续后变成模拟运行，结束后回到待启动；未启动真实 Core | 通过 |
| 包状态 | 无法运行示例禁用启动；降级示例允许启动 | 通过 |
| 原生文件取消 | 真正的 Windows 选择对话框出现；取消后返回 Launcher，无错误提示 | 通过 |
| 原生文件选择 | 选择“雪夜旅店 示例.json”；中文、空格及扩展名正确返回 | 通过 |
| 原件保护 | 所选 .tmp 文件的 SHA256 前后相同；仅显示文件名，不显示完整私人目录 | 通过 |
| 权限拒绝 | 调用未授权 plugin:dialog&#124;save 被拒绝；未增加保存或文件写入权限 | 通过 |
| 窗口与键盘 | WebView 1180/800/600px 宽度布局无水平溢出；弹窗、历史节点及 Escape 可用 | 通过 |
| 退出 | 主窗口正常关闭，应用及其 WebView2 浏览器子进程退出 | 通过 |
| 控制台 | 页面交互及原生文件选择无 console error/warning | 通过 |
| 默认程序复核 | 不带临时配置重建成功；启动退出正常；19327 测试端口关闭，WebView2 参数无 remote-debugging | 通过 |

窗口尺寸检查通过 CDP 改变 WebView viewport，未将其表述为操作系统 DPI 或所有原生窗口缩放组合验收。密钥检查使用明确的假测试值，未使用真实凭证；Web 存储检查不构成对任意自由文本凭证泄露的保证。

## 3. 本地复现证据

当前机器保留：

- .tmp/launcher-native-verify/tauri-test.json：仅测试使用的 Tauri 配置。
- .tmp/launcher-native-verify/interactions.js：在原生 WebView 上执行的完整交互。
- .tmp/launcher-native-verify/boundaries.js：文件名、配置、密钥及权限边界检查。
- .tmp/launcher-native-verify/file-dialog.ps1：绑定本次进程的文件对话框操作。
- output/playwright/launcher-native-main.png：原生 WebView 主界面。
- output/playwright/launcher-native-storyline.png：原生 WebView 故事线。
- output/playwright/launcher-native-file-selection.png：选中文件后的 Launcher 界面。
- output/playwright/launcher-native-narrow.png：窄 viewport 布局。
- .playwright-cli/：快照及控制台日志。

这些路径是忽略的本地验收产物，未作为生产功能提交。原生对话框的证据是实际窗口定位、取消/选择返回与最终页面断言，不是模拟文件路径注入。

```powershell
# 临时 CDP 配置验收构建（配置不提交）
corepack pnpm@11.7.0 --filter @perspectra/launcher tauri build --debug --no-bundle --config .tmp/launcher-native-verify/tauri-test.json

# 使用测试程序启动后，通过以下入口操作实际 WebView
npx --yes --package @playwright/cli playwright-cli -s=perspectra-native attach --cdp=http://127.0.0.1:19327
npx --yes --package @playwright/cli playwright-cli -s=perspectra-native snapshot
npx --yes --package @playwright/cli playwright-cli -s=perspectra-native run-code --filename=.tmp/launcher-native-verify/interactions.js

# 完成后 detach、关闭测试进程，再重建交付程序
corepack pnpm@11.7.0 --filter @perspectra/launcher tauri build --debug --no-bundle
```

本轮仅更新文档，新增本地验收脚本和截图；无运行时业务修改，没有因工具连接问题加入生产调试接口。前端严格类型检查随最终原生重建再次通过；先前的 6 项 Launcher 测试与仓库 196 项测试未重复运行。真实 Core 和模型玩法仍未验证。

## 4. 接受的限制

文件选择已验证，但不会读取或载入所选文件内容；随后仍由用户选择 Mock 包预览。导入、导出和启动都按第一阶段约定演示流程；实际游戏包、可继续的存档、模型连接和 Core 进程尚未实现。验证通过指当前 GUI 骨架可用，不表示真实游戏已经可运行。
