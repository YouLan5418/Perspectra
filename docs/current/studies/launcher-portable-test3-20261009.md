# Windows x64 便携 test3 构建与验收

构建日期：2026-10-09；文档整理：2026-10-10。版本 0.1.0-test3。核心源码基于已推送提交 23200ed，构建脚本随后加入官方包并更新版本及校验方式。ZIP 已在本机构建并上传 [GitHub 预发布版](https://github.com/YouLan5418/Perspectra/releases/tag/v0.1.0-test3)，未签名。

## 交付物

| 内容 | 本机相对仓库路径 |
| --- | --- |
| 便携目录 | dist/portable/Perspectra-0.1.0-test3-win-x64 |
| ZIP | dist/portable/Perspectra-0.1.0-test3-win-x64.zip |
| SHA-256 | dist/portable/Perspectra-0.1.0-test3-win-x64.zip.sha256 |
| 包内说明 | 开始试玩.md、验收记录.md、验收结果.json、build-info.json |

ZIP 为 518,877,581 字节（约 519 MB），9443 个文件通过 CRC 检查。SHA-256：

```text
9361dc0a3d25e2f54c988535088957adb47bd9e7080f06aee030e889e8dd2dde
```

产物在忽略的 dist 目录，不随源码 Git 提交上传；通过 [Release 附件下载](https://github.com/YouLan5418/Perspectra/releases/download/v0.1.0-test3/Perspectra-0.1.0-test3-win-x64.zip)分发。2026-10-10 核对远端附件，其大小和 SHA-256 与本机产物一致。完整解压后运行 Perspectra.exe，载入 examples/大模型变成美少女了。其他示例为前室与后室、测试示例。

## 已包含

Release Tauri 启动器与当前前端，官方试玩源包，思考强度、120 秒默认反应期限、在场随机调度、上下文呈现优化、节点长期档案快照、单节点分享和末端回合重新生成。Core 保持原有串行观察驱动、授权来源及规则提交机制，没有持续后台自治。

自带 Node v24.14.1、Python 3.12.13、WebView2 154.0.4258.62、MSVC 14.50.35710、离线 E5 量化模型及许可证。玩家不需要开发工具，真实角色对话仍需自己的模型接口与凭证。包内没有私人实例或测试目录。

## 本轮验证

| 检查 | 实际结果 |
| --- | --- |
| 默认源码门禁 | 类型、Lint、41 文件 361 项测试通过；Launcher 类型及 14 项测试通过 |
| 原生构建 | Vue 生产前端与 Tauri release 成功，未使用临时调试配置 |
| 独立原生进程 | 独立数据目录启动，窗口 Perspectra、Responding=true，随后关闭 |
| 精简 PATH 的打包 Node/Core | 官方包载入、创建实例、Core 正常启停 |
| 前端资源 | 宿主、默认 HTML/CSS/JS、官方包 HTML/CSS/JS 与当前源码一致 |
| 固定序章 | 112 次继续、5 条中性玩家表达、providerCalls=0；结尾“你愿意让我们暂时留下来吗？”，phase=free |
| 离线编码 | Python -I -B 运行 Core/E5，输出 [1,384] 且全部有限；三个 CRT DLL 来自包内 Python 目录 |
| 归档 | 禁止链接，ZIP CRC 通过，SHA-256 已生成 |

证据保留于本机 .tmp/portable-test3-official-smoke2/smoke-result.json、python-result.json 与 .tmp/portable-test3-native/data；这些测试数据不随便携包分发。构建方法见[BUILD](../../../scripts/release/BUILD.md)。verify 的 official 参数检查完整序章和自定义前端；offline 参数明确跳过模型连接。

## 未验证范围

本次 8046 真实连接不可用，已在报告标明跳过，没有重测自由阶段模型回应。此前 Gemini 真实玩法样例见[官方包验收](../../../examples/world-packs/model-girls-official/LIVE-VALIDATION.md)，不能当作本轮便携实玩结果。

未重新完成普通玩家完整点击试玩、原生目录选择器、干净 Windows、长时记忆和稳定性验收。原生进程启动正常不等于界面操作验收。没有代码签名、自动更新、完整树分享或跨版本存档迁移保证。

本轮文档整理仅更新源码与操作说明，没有重制上述 ZIP，故其字节数与校验和保持；包内验收记录仍为构建当时版本。先前 test1/test2 报告仅描述旧候选包。
