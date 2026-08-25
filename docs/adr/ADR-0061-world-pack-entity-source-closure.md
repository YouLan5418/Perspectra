# ADR-0061：World Pack 通用实体来源闭环

- 状态：Accepted
- 日期：2026-08-25
- Extends：ADR-0054、ADR-0060
- 上位契约：[Phase 7 实施规格 §8](../spec/phase-7-implementation-v0.2.md#8-酒馆社交参考-pack)

## 背景

Phase 7 要求参考 Pack 使用 Core `take` 验证连续交互，但最初的 `worldpack-source/v1` 文件清单遗漏了实体来源入口，适配器因此只能生成空 `entities`。若测试或组合根在编译后手工插入实体，酒馆就不再能证明“创作者只修改内容文件”。

## 决定

1. `worldpack-source/v1` 根清单增加必填 `entityFiles`，显式列出零个或多个严格 JSON 实体文档。
2. 实体文档固定为 `worldpack-entities/v1`，每个实体只包含 `entityId`、`locationId` 和 `kind`；不得包含脚本、规则或题材语义。
3. Compiler 稳定合并、排序并校验唯一 ID 与 Location 引用，把实体物化进 `worldpack/v1` compiled content，再交给既有 WorldSpec/Genesis `entity.upsert` 路径。
4. Core `take` 继续是唯一裁定者。Pack 不能定义新的实体行为。
5. Phase 7 尚未形成 `0.2.0` 候选或 Tag，因此更新 P7.1/P7.2 开发期 Golden；`v0.1.0` 的 Manifest、Event、Hash 与既有世界不变。

## 后果

- 酒馆中的可取得物品完全来自创作者内容文件，不建立手工 Event 或第二事实源。
- 来源清单仍然无隐式发现，路径、大小、引用和 Canonical Hash 不变量不变。
- 将来若实体需要新行为，必须通过独立的注册 Rulebook/插件版本实现，不能扩张本来源结构绕过裁定。

## 验证

- 空实体列表、多个文件稳定排序、重复 ID、未知 Location、未知字段和超限矩阵均有测试。
- 参考酒馆从 source 编译、激活后，玩家可通过通用 `/take` 取得实体。
- `v0.1.0` 全部 Golden 与 P0～P6 回归保持通过。
