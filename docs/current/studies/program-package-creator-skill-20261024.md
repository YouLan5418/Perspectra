# 程序包、随包 CLI 与创作 Skill：2026-10-24 本机验收

发行补记：用户确认后，candidate4 原始 ZIP、SHA-256 与验收记录已上传至 [v0.3.1-test1 预发行版](https://github.com/YouLan5418/Perspectra/releases/tag/v0.3.1-test1)，旧 test3 保留。远端附件大小 521,587,384 字节，GitHub 返回的 ZIP digest 与下文 candidate4 摘要一致；isDraft=false、isPrerelease=true。公开中英文 README 已由单独提交 `66470571a78b7f512872daa8196727818eadec31` 更新，远端 main SHA 已核对，该提交只含两个 README。以下各候选“未上传”的文字保留为上传前的历史记录，不表示当前发行状态。

宣传截图补记：在当前官方默认前端上，用已有 Claude／GPT／DeepSeek 立绘、客厅日夜背景和官方试玩包原序章台词制作三人同框取景。精选三张原生 PNG 均为 1920×1080，未后期拼贴或调用真实模型，不读取私人存档；这些是开发中内容的演出展示，不是实时模型对话或程序预装游戏。文件、来源与摘要在 `output/playwright/promo-20261024`，精选原图包为 `output/playwright/Perspectra-trio-promo-20261024.zip`，三张图与说明／清单共 5 文件，ZIP CRC 通过；未将宣传素材附入程序发行包或上传为试玩包。浏览器截图检查不扩大上述程序与真实体验验收范围。

原生启动补记：用户直接运行工作区 candidate4 时无窗口，本机复现退出码 101，错误为 WebView2 0x800700AA。icacls 显示 EXE 与随包 WebView2 继承 Low Mandatory Level。将已发布原 ZIP 在普通用户目录完整解压后，EXE SHA-256 仍为 `eadeb47cf05fab92617670124705d43a0d52a50a70c945031c066a31af2d0c7c`，原生窗口持续运行，用户确认完整启动器界面已显示。隔离诊断实例随后关闭，同一普通目录副本已不带测试数据覆盖地重新启动，存在原生窗口及随包 Node 子进程。原候选目录仅增加一个本机快捷方式指向这个副本，不将用户路径快捷方式加入发行 ZIP，也未改系统安全权限、原配置或存档。已发布 ZIP 字节与摘要未变化；这次补齐的是本机原生启动检查，干净 Windows、完整点击和真实模型长时体验仍未验收。

例如创作者让同行者私下知道一封信，再允许拿起钥匙交给玩家：本轮用随包 Skill 在独立目录生成源包，加入私有知识和作者物品模板，先调用随包 CLI，再从打包后的 Launcher 后端载入并启动 Core。本轮未发送真实角色模型请求，因此只证明源包和宿主路径可用，不证明角色会自然保守秘密或正确选择交给谁。

## 交付物与来源

本轮首个通过离线检查的候选目录为 `dist/portable/Perspectra-0.3.1-win-x64-candidate2`，随后更新图标的 candidate3 见下节。两者包含正式 Tauri EXE、游戏宿主、记忆运行环境、许可、worldpack.cmd 和 `skills/perspectra-creator`，没有 examples、预装试玩包、实例或原始角色卡。它们是本地候选，尚未上传新 Release；历史 test3 不因此更新。

本地 ZIP 为同路径加 `.zip`，521,325,494 字节，9400 文件 CRC 全部通过；旁边有 `.zip.sha256`。SHA-256：`c887278d48ef0b12d5ede706e8e39d323a5c2c952bd68b67a7fb7c3dcf6e3332`。该归档包含明确列出门禁失败与未测范围的验收记录，不表示已获公开发行验收。

### 随后替换启动器图标

用户提供的 1254×1254 PNG 原样保存在 `apps/launcher/src-tauri/icons/icon.png`，SHA-256 为 `431c0e85e2b1b736338d003dfac5e7f4f376e1dee8ca8fa234c7025304a9d4fb`。仅用 Tauri 图标工具转换尺寸及格式，没有重绘或去背景；Windows ICO 含六个尺寸，PNG／ICNS 与浏览器 favicon 同步更新。

原先只换 ICO 后增量构建仍嵌入旧资源，已在 build.rs 声明图标目录为构建依赖并重建。将新 EXE 复制到未缓存的路径后提取图标，32×32 与生成 PNG 逐像素一致；Vite 生产 favicon 与 public 源文件摘要一致。代码与素材说明见[启动器 README](../../../apps/launcher/README.md#启动器图标)。这不表示原生窗口的全套点击流程或真实角色体验重新通过。

图标更新另生成 `dist/portable/Perspectra-0.3.1-win-x64-candidate3`，保留 candidate2 及上述历史摘要；candidate3 的 `验收记录.md` 和 ZIP 校验文件独立记录这次变更。

candidate3 已再次用新的 Skill 源目录通过随包 CLI、载入／新实例／Core 启停、前端比对和离线 E5 `[1,384]` 有限向量及包内 CRT 检查，数据在 `.tmp/portable-0.3.1-candidate3-smoke`。本次图标替换未重跑全仓测试，先前记录的格式门禁与一次活动测试不稳定结论仍保留。

candidate3 ZIP 为 521,545,177 字节，9400 文件 CRC 通过；SHA-256：`ad7ae0dc60f04bccf8b941667701e006c6c444cf35d15e0267af8a9dc78bbb97`，另有同目录 `.zip.sha256` 文件。该候选仍未公开上传。

### candidate4：统一酒馆卡迁移与预设创作

统一的 [perspectra-creator](../../../skills/perspectra-creator/SKILL.md)实际收录旧 tavern-to-perspectra 的提取器、容量分析、四份参考流程和 20 项 Python 测试，不依赖另外安装旧 Skill。打包模式改用随包 Python 和空白源包脚手架，不假定有仓库、全局 Node／Python 或可复制的试玩包。原卡脚本、EJS 和正则仅作为数据提取与审阅；必要玩法按当前扩展点重写。

同一入口新增原生预设创作指南、包推荐与命名预设库模板。CLI 进程增加 `preset validate <file> [--pack]`，直接复用原生 RolePreset／预设库导入校验；没有新增预设格式或自动酒馆兼容引擎。世界包 validate 仍不加载预设扩展，需独立校验。较早的 0.3.1 候选无此命令，Skill 要求实际确认 --help。

本次通过：类型检查，改动文件 Lint／格式检查，Skill 结构检查，20 项提取／容量测试，5 文件共 58 项 CLI／预设相关回归。实际 candidate4 在源码外中文空格目录、空 PATH 下完成脚手架、合成 PNG／JSON 卡提取、脚本正文与正则替换串保留、容量报告及拒绝覆盖；两种预设模板通过，交换封装误作包推荐、未知字段／宏、未来交换版本被拒绝。所有卡片均为合成样本，没有转换私人卡片或执行原卡代码。

本地目录 `dist/portable/Perspectra-0.3.1-win-x64-candidate4` 保留 candidate3 的正式新图标 EXE，并重新构建 CLI 和统一 Skill。它用本次生成且带 model-preset.json 的源目录，通过载入／新实例／Core 启停、前端比对与离线 E5 `[1,384]` 有限输出、包内 CRT 检查；证据在 `.tmp/portable-0.3.1-candidate4-smoke`，Skill 夹具在 `D:/DeepSeek Harness/.tmp/perspectra-cli-tests/Perspectra 创作验证 btPlc1`。夹具不进入程序载荷。本次没有重跑全仓回归或真实模型，之前的格式门禁与活动测试不稳定记录继续保留。

candidate4 ZIP 为 521,587,384 字节，9412 文件 CRC 全部通过，SHA-256：`bbfe12fda796d0288450b6e0285065cfeb0f84a86944d25ce719c9b4504c70ce`，同目录 `.zip.sha256` 可核对。最终随包 Skill 的 18 个文件与仓库副本摘要一致，包内 EXE 与 candidate3 摘要一致。跨包依赖改用既有公开包入口后，已重新通过类型／边界检查和实际随包 Skill／CLI 检查；最终 Skill 夹具为 `D:/DeepSeek Harness/.tmp/perspectra-cli-tests/Perspectra 创作验证 1jx6uX`。归档仅供本地审阅，未上传发布。

build-info.json 记录根 package.json 版本 0.3.1、源提交 `048e98f5df0cd7920edba599bb8d26deed8e99ea` 与 sourceDirty=true；提交号不能单独代表本轮未提交源码。Tauri 的内部应用版本仍为 0.1.0，不把它当作程序载荷版本。

| 素材 | 本次证据 |
| --- | --- |
| WebView2 154.0.4258.62 | 从保留的本机 test1 完整运行时恢复；主程序微软 Authenticode 为 Valid |
| 十个 CRT DLL | 从同一旧包的重分发 DLL 恢复；十个签名均 Valid，实际版本 14.50.35719.0，纠正旧元数据标签 |
| Node v24.14.1 | 与旧包 Node 的 SHA-256 相同，恢复其原许可；不另下载或运行安装器 |
| Python 3.12.13 | 复制基础环境及 venv 覆盖；保留 --system-site-packages 所需依赖 |
| E5 / 许可 | 使用已有受校验的六项模型资产，恢复 Node、MSVC 和 E5 说明；重新生成 255 项 Rust 依赖许可清单 |

素材的本机来源保存在 `.tmp/portable-release-assets/asset-provenance.json`，不要求其他创作者有这个路径。构建接法见[构建说明](../../../scripts/release/BUILD.md)，作品与程序包分开分发。

## 实际检查

| 检查 | 结果与边界 |
| --- | --- |
| 正式 Tauri build --no-bundle | 成功生成 EXE，沿用正式配置；未进行原生窗口点击验收 |
| 类型、宿主边界、Lint | `check` 在这些阶段通过；后续格式门禁失败，不能宣称全量 check 通过 |
| 全仓格式 | 三个未改动文件不符合现有 Prettier：interaction-runtime/src/index.ts、memory/src/hybrid-tokenizer.ts、memory/src/index.ts；本轮未顺带整理 |
| 默认回归 | 148 文件、1375 项：1374 通过，活动主持用例一次未推进到预期玩家回合 |
| 活动复核 | 失败用例单独通过；整个 pack-activity.test.ts 33 项随后通过。不能据此删除全量失败记录或确认根因 |
| launcher:check | 44 项通过 |
| 随包 CLI | 源码外、空 PATH、中文／空格目录：版本、帮助、校验、编译、适配、概要、本地初始化、错误退出码与诊断通过；验证未执行玩法资产脚本 |
| Skill | 结构检查通过；实际随包 Node 运行脚手架，拒绝覆盖、无效 ID、文档认知／私有知识示例和物品脚本编译适配通过 |
| 打包宿主 | 使用上述生成源目录，全新实例载入、创建、Core 启停、创作者页面和默认前端比对通过 |
| 离线记忆 | E5 输出 `[1,384]` 且有限；Python 实际加载包内三个 CRT DLL，未下载模型或依赖 |
| 文档链接 | 本次修改页无新增断链；既有两份研究文档仍有 97 处失效链接，19 个历史本地产物缺失另计 |

本机宿主和编码证据位于 `.tmp/portable-0.3.1-candidate2-smoke/smoke-result.json` 与 `python-result.json`；Skill／CLI 各次独立夹具目录在相应脚本 JSON 输出中。夹具不加入程序包。

## 这次修正的打包问题

旧脚本未收录 CLI，固定复制三个试玩包；现在复用[已有 CLI](../../../packages/world-pack/process/cli-entry.ts)打包并复制创作 Skill，移除试玩包复制。Skill 是作者工具，未新增宿主协议、插件层或角色控制机制。

完整离线检查发现当前 venv 依赖基础 Python 的 site-packages，而旧脚本会丢掉它，导致 numpy 缺失。初始候选因此未通过；candidate2 已修正并重新验证。前端模板使用 function.toString()，源码加载器及整包构建的局部符号重命名会影响逐字比较；验收现在按同一 esbuild 目标构建，并规范化内嵌脚本局部名称，继续比较 HTML/CSS 和可观察字符串。没有修改玩家运行协议来适配检查。

## 尚未验收

本轮没有调用真实模型，没有新的角色行为或自然度结论；没有干净 Windows、原生界面完整操作、30 分钟连续试玩和自动化 Agent 使用 Skill 的独立决策验收。CLI 的 test 仍只编译适配，不执行声明断言；宿主启动不证明玩法动作与隐私叙述均正确。全量格式问题与一次活动回归失败仍需在公开发行前明确处理，不把本地候选写成全门禁通过。

复现命令见[构建说明](../../../scripts/release/BUILD.md)、[Skill 检查](../../../scripts/release/verify-creator-skill.mjs)与[程序包检查](../../../scripts/release/verify-portable.mjs)。
