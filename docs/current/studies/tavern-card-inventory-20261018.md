# 酒馆角色卡元数据清单（2026-10-18）

记录 `Tavern Card/` 下两张新增卡的元数据与容量事实。**只记结构、计数与标题，不记正文、人设文本或脚本源码**——卡片自身声明了传播限制，正文不入库。

第三张（鸣潮 `WuWa Solaris-3 MVU Edition`）的结构分析在[能力对照](tavern-card-port-capability-20261018.md)，此处不重复。

## 来源与解析方式

- 卡都是 `chara_card_v3`：PNG 的 `tEXt` 块里放 base64 编码的 JSON。读块、解码、统计，全程不执行卡内脚本、不渲染卡内 HTML。
- 解码后的 JSON 留在本机临时目录，不进仓库；需要复核时用[卡探针](../../../tests/experiments/tavern-card-probe.ts)重新生成。
- 探针同时给出这些结构与宿主上限的差距，见各节末尾。

## 一、两卡并排

| | 创世回廊6.0 | Ark·Endfield v0.7 |
| --- | --- | --- |
| 文件 | `大型开放世界.png` 14,797,418 B | `Ark·Endfield_v0.7.png` 2,416,663 B |
| PNG 尺寸 | 512×768，8bit RGBA | 512×768，8bit RGBA |
| 卡 JSON | 4,975,026 字符（4.74 MiB） | 272,882 字符（0.26 MiB） |
| 世界书 | 739 条 / 3,769,134 字符 | 93 条 / 178,609 字符 |
| 启用比例 | 177/739（24%） | 91/93（98%） |
| 正则脚本 | 15 条 → 20 条文本规则 | 无 |
| 玩法脚本 | 7 个（2 内联 + 5 CDN 存根） | 无 |
| 开局 | first_mes + 1 条占位 | 4 条（0 / 说明型） |
| 特殊字段 | `odysseia_trace` 加密载荷 | 无 |

## 二、创世回廊6.0

### 2.1 容器

| 项 | 值 |
| --- | --- |
| 文件 SHA-256（前 16 位） | `537203ea52a17a15` |
| 块序列 | `IHDR`(13) · `IDAT`(735,956) · `tEXt:ccv3`(14,061,072) · `trAc`(304) · `IEND` |
| 数据块 | 只有 `ccv3`，**没有 `chara`**；尾部无附加数据 |
| 解码 | base64 → 4,975,026 字符 JSON |

图像只占 5%，其余 95% 是世界书与脚本。

### 2.2 卡片元数据

| 字段 | 值 |
| --- | --- |
| spec / version | `chara_card_v3` / 3.0 |
| name | 创世回廊6.0 |
| creator | 空 |
| character_version | 5.3 |
| create_date | 2026-06-07T16:55:02.891Z |
| creator_notes | `请勿在墙内平台和QQ群传播讨论`（15 字） |
| first_mes | `【封面】`（4 字占位符，由正则渲染） |
| alternate_greetings | 1 条，4 字占位 |
| tags | 空 |
| description / personality / scenario / mes_example / system_prompt | 全空 |

### 2.3 扩展字段

| 键 | 内容 |
| --- | --- |
| `world` | `创世回廊6.0`（外链世界书名，与内嵌同名） |
| `depth_prompt` | `{prompt:"", depth:4, role:"system"}` |
| `talkativeness` / `fav` | `"0.5"` 类值 / `false` |
| `regex_scripts` | 15 条，见 2.5 |
| `tavern_helper` | `scripts` 7 个、`variables.start_presets`（`encoded_preset_storage` → 解码为 `{"presets":[]}`，机制在、内容空） |
| `odysseia_trace` | `{v:1, kid:"v1", nonce, ciphertext(243 字符)}`，加密载荷，疑似溯源/水印；未尝试解密 |

### 2.4 世界书

| 指标 | 值 |
| --- | --- |
| book name | 创世回廊6.0 |
| 词条 | 739 条，正文合计 3,769,134 字符（3.59 MiB） |
| 启用 / 停用 | 177 / 562（停用合计 3.23 MB，启用仅 373 KB） |
| 常驻 / 关键词触发 | 109 / 610（932 个唯一关键词） |
| 单条最大 | 1,082,855 字符（`沃恩德副本`，默认停用） |
| 注入位置 | `after_char` 637 / `before_char` 102 |
| 其他 | `use_regex` 739/739；`selective` 660；`secondary_keys` 0；depth 4 占 719 条 |

**结构：按模块分组的可选内容库。** 562 条停用词条不是废弃内容，而是按需开启的副本／地图／种族／地区，用 36 个 `--/xxx开始`、`--/xxx结束` 标记分段，区块名包括：附加角色、都市、地海、大明志异、琥珀之剑（地理／种族／势力）、Mod。

最大的六个模块（全部默认停用）：沃恩德副本 1,082,855、惊悚乐园副本资料 574,168、诡秘副本 553,232、地图静态资料-都市龙族 128,810、SAO 楼层资料 88,970、龙族副本资料 84,496。

融合的 IP 包括 DNF、NGNL、龙族、SAO、诡秘之主、惊悚乐园、琥珀之剑、大明志异，也含鸣潮角色（达妮娅、卡提希娅、爱弥斯）。

### 2.5 正则脚本（15 条 → 20 条规则）

宿主校验器接受（20 ≤ 32 上限），但四条替换文本超长会被跳过：

| 规则 | 替换文本长度 | 作用 |
| --- | --- | --- |
| `正文美化` | 263,733 | 正文 HTML 渲染 |
| `行动选项美化` | 19,139 | 选项按钮渲染 |
| `封面` | 18,124 | 内联 HTML 封面（含 Google Fonts 外链） |
| `开局` | 4,593 | HTML 壳，加载 `build.html` |

状态栏规则只有 157 字符，因为它是个加载器：

```js
$('body').load('https://cdn.jsdelivr.net/gh/tangquanghuy/dnf@latest/dist/V20261015/bottom-status-bar.html?V=1')
```

### 2.6 玩法脚本（7 个）

| 脚本 | 大小 | 性质 |
| --- | --- | --- |
| `MVU_ZOD` | 25,139 | MVU 的 zod 图式，13 个根变量 |
| `创意工坊` | 39,158 | Tampermonkey 风格用户脚本，iframe 内嵌外部工坊页 |
| `var_update` | 95 | CDN 存根 → `MagVarUpdate@beta` |
| `辅助计算脚本` | 100 | CDN 存根 |
| `外置状态栏` | 102 | CDN 存根 |
| `小手机脚本` | 95 | CDN 存根 |
| `格式修复` | 91 | CDN 存根 |

五个存根全部指向 `cdn.jsdelivr.net/gh/tangquanghuy/dnf@latest/dist/<日期>/...`，**卡内没有这些逻辑的源码**；`创意工坊` 指向 `https://cloudflare-workshop.saugrodep.workers.dev/?embed=1`。

MVU 根变量 13 个：世界信息、任务列表、附近的人、羁绊列表、队友成长、人物、核心资产、种族棋子收藏、末日时钟、传闻、战斗、当前事件、系统配置。`好感度`（-100~100）只出现在 `bondSchema` 的 19 个字段之一。

### 2.7 与宿主上限对照

用[卡探针](../../../tests/experiments/tavern-card-probe.ts)实测：

| 检查 | 结果 |
| --- | --- |
| 文档数 ≤ 4096 | ✅ 739 |
| 单条 ≤ 65,536 字符（整条投递） | ❌ 6 条超限，永远交付不了 |
| 单个 Markdown ≤ 256 KiB | ❌ 3 条装不进一个文件 |
| 关键词 ≤ 256 个／每个 ≤ 512 字符 | ✅ |
| 常驻合计 ≤ 单次预算 65,536 | ❌ 78,159 字符（119%） |
| 正则 → 文本规则 ≤ 32 条 | ✅ 20 条（但 4 条替换超 4,000 字符） |

## 三、Ark·Endfield v0.7

### 3.1 容器

| 项 | 值 |
| --- | --- |
| 文件 SHA-256（前 16 位） | `b517510d19315092` |
| 块序列 | `IHDR`(13) · `IDAT`(843,131) · `tEXt:chara`(786,720) · `tEXt:ccv3`(786,720) · `IEND` |
| 数据块 | `chara` 与 `ccv3` 完全相同 |
| 解码 | base64 → 272,882 字符 JSON |

### 3.2 卡片元数据

| 字段 | 值 |
| --- | --- |
| spec / version | `chara_card_v3` / 3.0 |
| name | Ark·Endfield |
| creator / character_version | 均为空 |
| create_date | 2026-02-01T00:11:23.374Z |
| creator_notes | 空 |
| first_mes | **空字符串** |
| alternate_greetings | 4 条：1,047 / 2,032 / 2,253 / 21 字符（末条是"释放你的想象力…"引导语） |
| description 等主提示字段 | 全空 |

### 3.3 扩展字段

只有 `world`（`Ark·Endfield_v0.7`）、`depth_prompt`、`talkativeness`、`fav`。**没有 `regex_scripts`，`tavern_helper` 的 scripts 与 variables 都是空的**——纯声明式卡。

### 3.4 世界书

| 指标 | 值 |
| --- | --- |
| 词条 | 93 条，正文合计 178,609 字符（0.17 MiB） |
| 启用 / 停用 | 91 / 2 |
| 常驻 / 关键词触发 | 2 / 91（220 个唯一关键词） |
| 单条最大 | 8,412 字符（`[角色]:庄方宜`） |
| 注入位置 | `before_char` 87 / `after_char` 6 |

词条用统一前缀分类：`[角色]:` 41、`[种族]:` 38、`[设定]:` 4、`[组织]:` 4、`[地点]:` 4、`[强调]:` 1、无标签 1。

最大的六条：庄方宜 8,412、诀 7,709、提弗洛斯 7,355、梨诺 6,739、卡缪 6,561、汤汤 5,584——都是一人称的角色卡条目（基本信息／外貌／经历）。

### 3.5 与宿主上限对照

全部通过：文档 93 ≤ 4096、单条 8,412 ≤ 65,536、单文件合规、关键词形状合规、常驻合计 3,704 字符（5.7% 预算）。没有脚本与正则需要迁移。

## 四、保留的原始数据

| 位置 | 内容 | 是否入库 |
| --- | --- | --- |
| `Tavern Card/*.png` | 原始卡（含正文） | 本机保留，未提交 |
| 本机临时目录的解码 JSON | 完整 `ccv3` JSON | 否 |
| [卡探针](../../../tests/experiments/tavern-card-probe.ts) | 可复跑的解析与对照 | 已入库（不含卡数据） |

复跑：

~~~powershell
node --import tsx tests/experiments/tavern-card-probe.ts "Tavern Card/大型开放世界.png"
node --import tsx tests/experiments/tavern-card-probe.ts "Tavern Card/Ark·Endfield_v0.7.png"
~~~

## 五、未验证与限制

- 只解析了 `tEXt` 里的卡数据；没有执行任何卡内脚本，也没有解析 `odysseia_trace` 的密文。
- 没有验证这些卡在酒馆里的实际运行效果，无法判断某个模块是否真的能被正确开关。
- `start_presets` 解码后是空数组，不能据此推断作者是否另有预设分发。
- 创世回廊的五个 CDN 存根指向 `@latest`，**同一张卡在不同时间可能加载到不同代码**；仓库里没有任何记录能锁定当时的实际脚本。
- 没有验证 4 万字级条目在真实会话里的召回命中率（宿主按关键词子串匹配，命中后整条投递）。

## 六、版权与用途

- 创世回廊的 `creator_notes` 明确要求不要扩散；其正文融合了大量他人 IP。
- Ark·Endfield 基于既有作品设定，未标注作者与授权。
- 两张卡都只用于本机能力评估；本页只记录结构与计数，不复制正文，不产出可发布内容。
