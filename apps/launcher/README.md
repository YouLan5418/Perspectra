# Perspectra Launcher

Tauri 2 + Vue 3 本机启动器。当前已接通 v5 世界包目录、独立实例、OpenAI 兼容、Anthropic 和 Google 模型接口、Core 记忆、系统浏览器游戏页、停止与继续、前端授权、角色预设、完整节点保存与故事线分叉。单节点导出导入、末端回合重新生成和四档思考强度已接入。

## 源码开发

在仓库根目录运行：

```powershell
corepack pnpm@11.7.0 install --frozen-lockfile
corepack pnpm@11.7.0 launcher:desktop
corepack pnpm@11.7.0 launcher:check
corepack pnpm@11.7.0 --filter @perspectra/launcher tauri build --no-bundle
```

开发机需要 Node、仓库依赖、Rust/Cargo、Windows 构建工具，以及 [Core 记忆环境](../../experiments/activity-memory/README.md) 的 Python/E5。`launcher:dev` 仅运行浏览器 Mock 展示，不能启动真实 Core。

## Windows x64 便携候选版

便携包在 EXE 同级 `runtime` 中自带 Node、Python、E5、固定 WebView2 和 C++ 运行库，玩家无需安装开发工具。正式构建缺少运行依赖时明确报错；源码回退仅用于 debug。

当前 test3 候选 ZIP 已上传到 [GitHub 预发布版](https://github.com/YouLan5418/Perspectra/releases/tag/v0.1.0-test3)。构建素材与命令见 [构建说明](../../scripts/release/BUILD.md)，实际验证与剩余门禁见 [验收记录](../../docs/current/studies/launcher-portable-test3-20261009.md)。本机隔离 PATH 的验证不等于干净 Windows 系统验收。

## 使用

首次从“模型设置”选择接口协议，配置对应的完整请求地址、模型和需要的 API Key，测试连接后应用。再从“载入游戏包”选择含 worldpack.source.json 的 v5 目录，创建实例并开始游戏。

本机验证使用过 `http://127.0.0.1:8046/v1/chat/completions` 与 `gemini-3.7-flash`，请按自己的服务修改。连接测试不保证模型稳定遵循角色输出协议。API Key 仅在本次会话保留；数据目录在设置中显示。关闭 Launcher 会停止它启动的 Core。

保存完整节点后，停止游戏即可从历史节点分叉；新线路恢复节点当时的长期档案与授权原文，校验时间和来源边界，不触发模型重建；无档案的旧节点保留授权原文。前端默认沙箱，受信任模式需要明确授权。更多操作见 [试玩说明](../../scripts/release/README.zh-CN.md)。

- [真实接入与历史验收](../../docs/current/launcher-core-integration.md)
- [故事线](../../docs/current/storylines.md)
- [角色预设](../../docs/current/model-presets.md)
- [前端授权](../../docs/current/frontend-authorization.md)
- [第一阶段 Mock 交付说明](../../docs/current/launcher-v1.md)

## 当前界面

左侧为可收起的游戏列表，左下固定模型设置、角色预设和全局设置；右侧为小封面与标题、实例选择、启动卡片及配置卡片。载入游戏包入口固定在右上方，右侧内容独立滚动；启动时保留既有编辑和切换限制。浅色为白灰与蓝色，深色为黑灰，可在全局设置选择浅色、深色或跟随系统主题；数据目录可选择并在重启后切换，旧目录保留、不自动迁移。

颜色、字体与圆角统一在 `src/style.css` 中定义；预设、请求检查等组件的 scoped CSS 复用这些变量。外观参考 [CC Switch 的主题变量](https://github.com/farion1231/cc-switch/blob/main/src/index.css)与[侧栏布局](https://github.com/farion1231/cc-switch/blob/main/src/components/shell/Sidebar.tsx)，使用本项目既有 Vue/Tailwind/Reka 组件实现。

本次 UI 验证包含 Launcher 类型检查、单元测试和 Vite 生产构建，以及浏览器 Mock 中的选游戏、创建实例、启动/停止、运行中禁用、弹窗与侧栏收起、800×640 和窄屏布局。预设弹窗和真实模式卡片使用浏览器内示例状态检查外观，未进行本轮原生窗口和真实 Core 的完整试玩；test3 已包含此版界面；此次便携原生进程启动正常，完整点击试玩仍未重新验收。

### 模型思考强度

实例“模型 → 修改”提供关闭、低、中、高，下次启动生效，仅用于角色决策与结果续写。部分 Gemini 不支持完全关闭；网关可能改写参数，未将全部供应商档位视为真实验收完成。详见[当前运行时](../../docs/current/architecture/runtime.md#角色思考强度)。

### 游玩参数

游戏详情“游玩配置 → 运行参数”按包保存输入/发布字符上限、反应周期预算与超时（默认 120 秒），Activity 和 Core 记忆设置置于高级区。该包所有实例下次启动生效，运行中禁止修改；模型生成 Token 等参数继续使用角色预设。全局设置另提供默认游戏前端字号、行距和自动跟随偏好。[默认值、范围与验证](../../docs/current/launcher-play-settings-audit.md#8-本轮实现)。
