# 插件优先运行时：阶段 11

日期：2026-11-04。基线 `be622498`，分支 `fix/activity-notice-and-revision`。对应[阶段 11 计划](../../superpowers/plans/2026-11-04-plugin-first-next-seams.md#9-阶段-11默认组合与玩法服务分开交付)。

例如作者把一个依赖设备服务的插件放在列表前面，设备插件放在后面：现在装载结束后会检查消费者是否真的启动，缺服务或互相等待时显示具体依赖名，不能把未执行的插件记作已生效。已有异步初始化仍按设置顺序完成，保持先注册者占用单例接缝的行为。

## 默认组合

[official-bundle](../../../desktop/official-bundle.ts)现在集中声明官方默认 Provider、决策组合和世界服务打开顺序。`installOfficialBundle` 通过现有 `ctx.scheduler`、`ctx.characterLoop`、`ctx.memory`、`ctx.decisions` 的 register／effect 填充空缺，第三方已注册的实现保留，官方注册也随 Cordis 根释放。Core 工厂只在没有替代记忆时调用。没有第二个服务容器，也没有合并 Launcher／游戏与内核的 Cordis 生命周期。

直接调用 WorldHost 的测试、透视与宿主扩展复用 `composeWorldSeams` 的相同选择和排序；它不模拟另一个注册容器。无记忆配置的直接入口继续使用 official-memory-none，正常 Launcher／源码入口提供的 Core 工厂不变。模型通道依赖入口持有的凭证与检查回调，仍在每世界打开时由组合工厂装配，使用公开的 Provider.open；没有把凭证加入 WorldServices，也没有提前注册一个缺配置的模型实例。默认顺序为模型、规则、记忆、决策、调度、角色循环。

宿主负责构造世界能力、打开／关闭实例和提交事实，不再在各个 open 方法里补记忆、角色循环或官方决策步骤；调度器打开失败时保留既有官方回退。显式 decisionOrder 省略的扩充步骤不会在世界打开时补回。

## 依赖与诊断

加载器沿用 Cordis 的 inject、Fiber.await、state 与 dispose。Cordis 4.0.1 的 await 等待当前转换，却允许返回稳定的 PENDING；原来只 await 一次会漏报依赖缺失。现在在所有插件登记后再次等待并核对状态，失败的插件回滚自己的注册，因依赖退出而失活的消费者也不能计为安装成功。诊断使用现有 apply 原因与宿主生成的 detail，不回显配置或模块异常正文。缺服务与循环等待合并描述，不根据不完整的清单猜测依赖图。

三种关系保持分开：`requiresPlugins` 是包对插件 ID／版本的要求，Cordis inject 是服务就绪条件，decisionOrder 是决策材料的执行顺序。Launcher 模块页继续展示清单预测、冲突和上次运行结果，存档 plugin-set 记录实际 Provider。没有增加热卸载、HMR 或插件下载。

## 玩法替换需求核对

| 实现 | 当前消费者／已有开放能力 | 独立替代者与处理 |
| --- | --- | --- |
| 活动 | WorldGameplay、活动机会桥、包内 schedule／onOutcome | 未发现独立替代者；保留活动规则，机会经 scheduler |
| 状态 | WorldGameplay、规则层、状态操作、授权 contextSources.status | 未发现独立替代者；不公开存储、不改包脚本 |
| 通信 | WorldGameplay 的短信规则与玩家操作 | 未发现独立替代者；保留通信授权和规则 |
| 知识 | WorldGameplay、contextSources.knowledge、官方／focused-knowledge 决策步骤 | 已能替换材料选择步骤；没有替换知识存储与包协议的实际需求 |
| 自主配置 | PackAutonomy、机会桥、scheduler 与行动限制 | 已能替换机会策略；没有替换作者配置协议的实际需求 |

依据[WorldGameplay](../../../desktop/host/world-gameplay.ts)及已有示例核对。本轮交付默认组合与依赖诊断；没有迁出这些玩法，不宣称整个默认游戏的玩法已全部插件化。未来每迁一项仍需实际替代者、兼容范围和独立验收。

## 验证

新增[组合测试](../../../tests/desktop/plugin-composition.test.ts)覆盖后续服务激活前置消费者、缺服务、互相等待、官方步骤注册、显式省略以及异步初始化的优先级。12 组离线请求、转录与行动结果和阶段 10 基线一致；Launcher 类型检查及 98 项单测通过。后端构建和构建模式的 3 个外部插件启动用例通过，覆盖普通、自主与活动。`corepack pnpm@11.7.0 check --maxWorkers=2` 的生产边界、类型、Lint、格式检查通过；181 个文件中 177 个通过、4 个失败，1743 项中 1735 通过、4 失败、4 项原有跳过。失败仍为阶段 10 已复现的 Windows 授权、Python 节点分享、进程依赖提示和隔离目录启停超时；没有新增失败或跳过。保留原有 Lint 警告。宿主 API 沿用 2.4，未新增包、持久化格式或模型协议。

没有可用模型凭证，真实模型自然度、Core 长期整理、Tauri 和完整便携包未验收。阶段 10 已确认的 Windows 授权、Python 环境和隔离目录启停限制继续保留，不通过跳过用例或改断言掩盖。

文档链接检查相较修改前没有新增诊断，现有历史断链保留。

本轮新日志与数据在 `.tmp/phase11/`，不读取历史试玩数据。源码公开能力和自动化检查不等于真实体验验收。
