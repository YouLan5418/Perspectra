# 受信任活动专属舞台

例如遗迹战斗显示血量与技能，计数实验显示计数与操作；宿主仍提供“切回默认界面”和强制退出。两者共享同一注册、授权、传输和 perform 路径。世界包不能上传 HTML/JS、远程模块或声明新权限来取得舞台代码执行权。

## 注册和输入

投影复用已有 `GameplayDefinition.playerView`，随模块注册和卸载；没有新增 Cordis 服务或第二套玩法投影注册表。输入新增 `activities`：仅所属模块、当前激活且玩家参与的活动，经 `ActivityStateRules.scoped` 授权，含 public、玩家自己的 private 和当前在场参与者 ID；没有 internal、其他角色 private 或世界真值。

模块可返回一个 `stage`：

```ts
playerView: ({ activities = [] }) => {
  const activity = activities[0]
  if (!activity) return {}
  return { stage: {
    renderer: 'stage-lab.counter',
    activityKey: String(activity.activityKey),
    activityId: String(activity.id),
    revision: Number(activity.revision),
    payload: { title: '登记实验', count: 0 }, // 实际实现从授权 public 白名单读取
  } }
}
```

B8 的既有模块调用边界隔离投影异常。展示校验器检查有限 JSON、65,536 字符 payload 上限及标识；所属活动/id/revision 不匹配时拒绝该模块展示。Host 转发时再次与当前前台活动匹配，仅一个匹配结果可用。其他模块的展示和通用操作不受失败模块影响。

可信宿主代码将 `ActivityStageRenderer` 列表交给 `createHostServer` 最后一个可选参数。官方组装的默认列表为 `officialStageRenderers`；代码样例见 [第二活动夹具](../../../tests/support/activity-stage-fixture.ts)。登记包含 id、moduleId、style、create(root)。id 重复或无效在服务器开始服务前失败。浏览器同时校验 renderer ID 和投影所属 moduleId，防止其他模块冒用已登记的官方渲染器。

factory 是编译进既有默认静态资产的自包含函数，不允许捕获 Node 闭包依赖；不是从包加载脚本，也不用 eval。实例的 `update(payload, context)` 仅收到有限 payload、当前活动已提供操作、busy/阅读/反馈与受控 perform/read；不收到完整 PlayerView 或 Core 引用。需要清理临时监听器时实现 dispose。渲染器可信，不是第三方脚本安全沙箱；继续使用原 iframe CSP 和网络限制。

## 生命周期与回退

- 每个 HTTP 服务固定一份渲染器资产列表；模块投影继续使用现有实例注册生命周期。模块卸载后不再产出 stage，客户端清除实例。
- 新活动实例或渲染器变更销毁旧渲染实例；暂停、结束、失效、切回默认均撤销旧回调。更新绑定活动 ID、修订号和末端候选，旧操作不能越界；重复点击有本地门禁，服务端仍最终验证。
- 未登记 ID、模块不匹配、投影失效、渲染抛错均回退通用卡片。渲染失败在当前展示绑定内保持关闭；暂停／恢复、重新进入或换绑定可重试。
- 默认舞台 main DOM 不重建，保留草稿和阅读状态；专属舞台覆盖时 main inert，返回时恢复焦点。宿主工具栏在 iframe 外。
- HostState 不再有 battle；通用 PlayerView 使用 `activityStage` 或显式 null。服务器→Host→MessagePort 两次 delta 都传递清除；SDK 合并时删掉清空字段，后续 full fetch 也不恢复旧舞台。

## RPG 与验证夹具

RPG `content.ts` 用 playerView 产生通用 stage；`battle-presentation.ts` 和 `stage-renderer.ts` 位于 RPG 包。通用 SDK、WorldHostCore、默认模板不再认识 RPG 类型、技能或模式。原 `officialRpgBattleView` 仍是 RPG 内部白名单投影，不是独立 Host 注册途径。

计数实验是测试侧受信任原生活动，拥有自己的声明、操作、状态和 playerView；不是把 RPG payload 改名，也没有使用 TRPG GM 数据。可复制其模式接入另一种本地可信活动，但本批不提供世界包任意 UI 加载器。

这次修改触及 Core 的**只读展示输入与校验**，没有改变权威裁定、世界事务、调度或存档服务；RPG 结算文件和持久数据版本保持原值。测试与浏览器实际范围见[交接记录](../../superpowers/plans/2026-11-16-activity-stage-registration.md)。

## 试玩

在仓库根目录、Node 24／pnpm 11.7.0：

```sh
corepack pnpm@11.7.0 exec tsx tests/experiments/activity-stage-preview.ts rpg
corepack pnpm@11.7.0 exec tsx tests/experiments/activity-stage-preview.ts lab
corepack pnpm@11.7.0 exec tsx tests/experiments/activity-stage-preview.ts fallback
```

每次只运行一条，打开打印的 URL。rpg 可打一回合；lab 点击“增加计数”，切回默认卡片继续，再打开专属界面；fallback 故意令渲染器抛错，默认卡片仍可增加计数。Ctrl+C 清理临时 SQLite。当前云容器需设置 COREPACK_HOME=/tmp/perspectra-corepack。不接触计费模型。

2026-11-16：`official-cards.table` 作为另一可信内置渲染器在相同登记清单装配；仅接收卡牌插件的授权 playerView，操作继续经过公共 perform。详见[卡牌指南](cards.md)。
