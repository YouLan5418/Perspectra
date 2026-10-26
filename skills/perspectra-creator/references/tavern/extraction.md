# 离线提取器

旧 tavern-to-perspectra 提取器现已随本 Skill 放在 scripts/tavern。Python 3.10+标准库，无需安装包、联网或node_modules；打包版使用程序自带 Python。输入PNG或JSON文件，或仅第一层扫描这两类文件的目录。PNG支持tEXt/zTXt/iTXt，识别V1平铺及V2/V3声明，不声称完整schema认证。

```powershell
& '<程序目录>/runtime/python/python.exe' -B '<skill-root>/scripts/tavern/extract_cards.py' '<输入>' --out '<不存在的输出目录>'
```

脚本不渲染、调用模型、执行代码或编译卡内正则。路径由输入顺序和字节摘要生成，不使用卡名/条目ID。输出目录不得覆盖。每输入的绝对来源和SHA-256在manifest中；PNG验证块边界/CRC/IHDR/IEND/尾部，保留非IDAT块原始base64载荷。

仅当另有目标源码仓库时追加 `--project-root '<源码目录>'`，读取静态常量做建议性预检；程序解压目录不含这些源码，不能假装它是项目根目录。

```text
manifest.json
001-<摘要>/
  container.json
  summary.json
  payload-000.json         每个容器载荷原始解码字节，含语义相同的双块
  variants/000/
    payload.json           解码后原始字节，未知/重复字段及换行可回查
    card.json              格式化JSON，非标准键保留
    summary.json           身份、文本大小、扩展线索及来源
    capacity.json          启用情况、常驻量、二级键、位置/深度与大小单位
    target-preflight.json  提供project-root才生成，源码常量及静态风险
    entry-index.json       数组索引、ID、标题、关键词、开关、完整配置
    entries/0000.json      单条完整字段，文件名按数组索引
    scripts/0000.json      助手脚本完整对象，未知配置保留
    scripts/0000.txt       脚本正文供静态审阅，不执行
    regex/0000.json        完整正则配置，包含replaceString
```

相同对象的双块只需分析一个variant，但每个原始payload都保留来源；差异载荷全部保留，manifest标needs_review，不自动选。重复JSON键、未知格式、异常条目给警告。缺卡载荷、损坏容器或格式错误为error，返回1；其余成功结果保留。取summary时不要忽略warnings或把部分成功当完整成功。

扫描只提供EJS/宏/URL/助手脚本的静态线索和配置分布，不执行推导。缺失enabled/constant保留missing，不自动当true/false；null可能继承原酒馆配置。动态拼接地址可能未完整展开；URL不是可达/资源已随卡提供的证明。未知PNG块只保存，不猜含义。

`scripts`检索助手树内含content字符串的对象；嵌套文件夹与未知包装仍留在card.json，单独导出不证明它是可执行脚本。正则完整对象独立导出；不要只审findRegex而漏掉替换模板、placement、disabled及深度条件。其他位置的脚本、宏或运行时函数调用需继续静态检索完整载荷；`_.get`等函数名本身不能证明是EJS。EJS标记仅按`<%`识别。

容量以Unicode码点、JavaScript UTF-16单元、UTF-8字节分别报告。一级/二级关键词、probability和useProbability保留原值，缺字段不猜默认。position采用已知Tavern惯例解释：有效extensions.position优先，否则识别顶层before_char/after_char；其中4表示atDepth，另读depth/role。顶层与扩展不同常是兼容编码，不直接判坏卡。深度999、深度0、作者注释前后等须结合实际酒馆版本、扫描设置与上下文验证，不机械转成Perspectra楼层。

目标预检只读取已知路径中的数字乘积常量，不执行源码；每项记录文件、行号、SHA-256。缺文件或表达式变动标unresolved，不能沿用旧值。它不覆盖所有运行限制，也不构造迁移产物。逐条原文超限按enabled分列，EJS长度不代表展开后长度；单条未超限仍可能超出整轮知识预算。总量需在创作者选定受众、条件和优先级后，检查实际接收者的选中/跳过条目，不能仅把全部常驻文本相加宣布失败。

默认输入最多256MiB、解码/解压文字最多128MiB，超限明确失败，不截断后冒充完整。不支持APNG动画语义、CHARX/ZIP、JPEG/WebP卡封装或YAML，遇到这些说明需要单独解析并保留原件。

提取是作者级资料，不放frontend、公共站点、Skill安装包或默认Git提交；脚本不承诺剔除卡内凭据。分享只选必要且可公开的重创产物。
