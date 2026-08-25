# ADR-0054：World Pack 来源、编译、信任与版本

- 状态：Accepted
- 日期：2026-08-25
- Extends：ADR-0025、ADR-0026、ADR-0034、ADR-0037、ADR-0053
- 上位契约：[通用内容架构总纲 §5](../spec/general-content-architecture-v0.1.md#5-world-pack-来源编译与版本)

## 背景

V0 的 WorldSpec 能证明 Manifest/Genesis 的确定性，但不足以承载多个文件、长文本、素材、创作者诊断和参考内容。若直接把来源目录当运行时输入，世界会受文件系统变化影响；若允许脚本、隐式文件发现或外部路径，Pack 会越过现有权限与重放边界。

## 决定

1. 创作者编辑显式清单驱动的来源目录；结构化内容使用严格 JSON，长文本使用 UTF-8 Markdown，可选素材为 presentation-only 不透明字节。
2. 根清单必须列出全部文件。禁止 glob、隐式递归、目录逃逸、外部路径、脚本、函数、网络端点、Secret 和自动插件下载。
3. Markdown 只归一化 CRLF/LF，不做 Unicode normalization；JSON 继续使用 `world-json/v1`。路径大小写碰撞在所有平台 fail-closed。
4. `WorldPackCompiler` 严格执行 Schema、引用图、插件锁、限制、默认值物化、稳定排序和 Canonical Hash，输出单一不可变 `worldpack.json` envelope，再适配既有 WorldSpec/Manifest/Genesis 编译链。
5. Pack 身份为 `packId + packVersion + packHash`。同 id/version 异 hash 返回 `PACK_VERSION_DIVERGED`；激活锁定 compiler contract、canonical version、limits profile、plugin hashes、Manifest 和 Genesis。
6. active World 永不重读 source 目录。preview/test 创建临时 World；production 内容更新创建新 World。Phase 7 不支持继承、热更新、fork 换 Pack 或迁移。
7. Pack 是不受信任数据，插件代码由 Host 安装、审核和 allowlist。`authorOnly` 只是运行时可见性，不是加密。
8. Compiler implementation SemVer、compiler contract、source schema、compiled envelope、Pack、World/Manifest 和项目候选版本是独立版本轴。Compiler 实现从 `0.1.0` 起步，不从 Phase 7 的 `0.2.0` 或 Pack 版本推导。

## 后果

- 创作者可以拆分内容并保留可读 Markdown，同时运行时仍只消费一个可哈希产物。
- 同一 source/compiler 在 Windows 与 Linux 必须产生相同 canonical bytes 和 packHash。
- 创作便利不能绕过 Manifest、Registry、Capability 或 World Event 权威。
- 未来 GUI 只能调用同一 Compiler API，不建立第二套内容语义。

## 验证

- 路径逃逸、符号链接逃逸、大小写碰撞、非法 Unicode、未知字段、缺失/循环引用和超限全部 fail-closed。
- CRLF/LF、文件枚举顺序和平台差异有精确 Golden bytes/hash。
- 编译后删除或修改 source 不改变已激活 World。
- 同 id/version 异 hash、插件 hash 漂移和未注册插件均在激活前拒绝。
