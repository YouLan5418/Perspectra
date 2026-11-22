# 直接写源包，也能交给作者接着做

比如作者改了同伴的称谓，想让你补一段有两个选择的交接剧情。先识别正在使用的作品目录和活动键。保留人物 ID、既有分支 ID、作者改过的称谓和画布布局。角色名可以改，脚本里的动态 ID 引用要单独检查。

## 直接写文件

运行 skill 的 `scripts/create-world.mjs` 后，源目录本身即可继续创作。用文本编辑工具直接写 v5 清单引用的 JSON、Markdown、JS。脚手架本身只依赖 Node 标准库；有系统 Node 时可直接用 `node`。只有文件工具时，按该脚本里的 `documents` 对象逐文件写实际 JSON，替换变量，保留每个文件各自的 schemaVersion。基础字段、物品、接收者和私有认知见[源包与人物](world-pack.md)。

- 开局选一个玩家槽，绑定的角色为 manual。每个角色至多一个 initialLocationId。一个地点至多绑定一个未关闭场景，active 场景至少有一名参与者，且参与者都在该地点。无人地点可只写地点记录，或将空场景的 lifecycle 设为 created。增加角色时一并补 cognition、memory，进场者还要加入 scene.participantIds。
- 若主线用手写活动，先取随 skill 的[可运行活动](../assets/inspect-activity.js)，改写开场、选项与后果，保存为 `scripts/activities/<key>.js`，加入清单 `assetFiles`，合并 `"plugins":{"pack-scripts":{}}`。名称只用小写字母开头的字母、数字和连字符。活动按钮可开始该段，结束后可继续自由互动。要在首次输入后自动开场，需按[活动](gameplay.md#活动)写 autoStart。长期进度使用包的跨活动状态；受众与活动内显示分别检查。
- 需要物品时，`entities.json` 的一条起始记录可写 `{"entityId":"entity:note","name":"交接单","kind":"document","locationId":"location:start"}`。需要拿取时再接入[物品操作](../assets/status-items.js)，填写 ITEM_RULES 中确实允许的 ID，并登记脚本。物品出现在列表里与玩家能否执行拿取是两件事。
- 作者可用「作品总览 → 手写活动脚本」打开源码。作者想在画布上改选项时，采用下一节的低代码图。编辑器只把自身可无损还原的生成脚本当成低代码，不会把任意 JS 反编译成图。

## 与编辑器协作

下列命令前缀为 `worldpack.cmd editor`。每个请求都是 UTF-8 JSON 文件。先查 `overview <作品>`、`records <作品>`、`open <作品>`。角色、地点等候选用 `candidates`，基础引用用 `references`，活动条件和结果的引用用 `activity-references`。这些查询和编辑器使用相同的稳定 ID。

新建图用 `save <作品> <请求文件>`。下面这份请求可以原样运行，再改成作者的故事。

```json
{
  "base": null,
  "graph": {
    "key": "handover", "title": "交接", "opening": "到了换班时间，桌上留着一封信。",
    "choices": [
      {"id":"read","label":"读信","condition":{"kind":"always"},"result":"你记下了来信里的约定。","speech":"","next":"end"},
      {"id":"ask","label":"询问同行者","condition":{"kind":"present","ref":"character:companion"},"result":"你转向同伴，等对方回应。","speech":"这封信是给谁的？","next":"end"}
    ]
  }
}
```

每个选项要有 id、label、condition、result、speech、next；没有玩家台词时 speech 填空字符串。next 只接受 `"end"`（结束活动）与 `"stay"`（留在活动重新计算候选）。要做「询问后才能读信」，先给 `rule-save <作品> <请求>` 一份世界变量声明：

```json
{"kind":"variable","base":null,"row":{"key":"asked","label":"已问过信件","type":"boolean","initial":false}}
```

在上例 ask 分支中设 `"next":"stay"` 并加 `"effect":{"kind":"world","ref":"asked","value":true}`，在 read 分支中设 `"condition":{"kind":"world","ref":"asked","value":true}`。只在本场使用的进度可改用活动 variables 和 local 引用。多条件用一层 `{"kind":"all","conditions":[{"kind":"held","ref":"entity:note"},{"kind":"world","ref":"asked","value":true}]}`；all、any 至少两项，成员是具体条件。复杂的嵌套判断可分成有意义的步骤，或写普通脚本。

条件控制选项，不会自动限制活动入口。比如所有选项都要求船员在场，玩家在别处仍可能打开活动却没有可选项。给这种活动保留一个可用的结束选项，或者用手写 canStart 约束入口。在原地点和异地各试一次；需要返回原进度时走宿主的暂停／继续，next 不接受 suspend。

编辑已有图时，`base` 为最近一次 `open` 返回的原图，`graph` 为修改后的完整副本。保留不涉及的 choices、variables、layout。布局项用 id 定位，title 声明组，parent 指向上层。字段冲突时重读草稿并合并。`record-save` 类似，提交 `{kind,id,base,values}`，base 是读到的 values，新的 values 可只列改动字段。作者继续使用同一源目录；活动画布可重新读取外部保存的草稿，其他页面可重新打开核对。

没有编辑器 CLI 也可以把上例的 **graph 对象本身** 写到 `creator-activities/handover.json`，作者用图形工作台打开后即可编辑并导出。它是作者草稿；运行时载入的是实际活动脚本。需要立即可玩的直接交付走上一节，或用图形工作台导出源包。避免在同一目录给同一个键同时新建手写脚本和图草稿。

对草稿用 `play <作品> <请求>`，例如 `{"key":"handover","choice":"read"}`。用 `export <作品> <不存在的新目录>` 将草稿生成可玩的 v5 源目录；也可用图形工作台「导出源包」。对**导出的目录**重新运行 validate、test、simulate，重新 open 检查图仍可编辑。保留作者工作目录，向作者说明修改哪个地点、哪个角色、哪一分支，以及接下来打开哪个目录。导出只携带清单与支持的资源，验收剧本可另行交付。
