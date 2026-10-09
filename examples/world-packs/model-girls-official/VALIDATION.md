# 验证记录 · 2026-10-09

- `corepack pnpm@11.7.0 check`：41 个文件、352 项默认测试通过，类型检查与 lint 通过。
- 最后活动通知显示调整后重新运行 typecheck、lint 及官方包回归：10 项通过。
- `worldpack validate examples/world-packs/model-girls-official`：valid，pack:model-girls-official@0.1.0。
- `node --import tsx tests/experiments/official-demo.ts`：112 次正式表达、5 条玩家表达、零角色 provider 调用，最终 free；事件与转录保存在独立 .tmp/official-demo-1791492878441。
- 真实浏览器／真实网页宿主／末端回合包装：开始、继续、跳过全部演出、自由控件及页面重载通过。重启同一测试实例仍停在最终收留问题；页面历史 113 条（112 条表达＋1 条游戏开始通知），5 条玩家表达。
- 修复实测宿主浮层遮挡和轮询重开 SQLite 写连接导致的快进断连；没有用模拟自由回应绕过问题。
- `node scripts/docs/check-links.mjs`：12 页、216 个本地链接及模块地图通过。该检查不替代正文语义核对。
- `corepack pnpm@11.7.0 desktop:build`：通过。未制作或发布新的便携发行包。

网页截图位于仓库 output/playwright/official-demo-free.png。测试使用独立实例及故意不可用的模型地址，没有读写历史 D:/worlds 数据。

初次开发检查时没有可用真实服务，以上项目尚未验收。用户随后开启 8046，关键真实场景样例与新增数值 schema 修复见 [LIVE-VALIDATION.md](LIVE-VALIDATION.md)。正式美术、音乐与完整演出镜头尚未制作。
