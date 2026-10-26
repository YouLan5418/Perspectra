# 按卡涉及的能力核查

本页仅供另有源码环境时按需读取，是检索路线而非永久能力清单。路径相对目标 Perspectra 仓库，移动后用 rg --files 定位；先读当地 AGENTS、README、项目状态、现行契约、架构入口和世界包指南。只有打包版时使用本 Skill 的源包／玩法／预设参考、目标 CLI 和实际宿主，也可以进行转换；未核对的高级能力应标为未知，不能因缺源码就宣称全部支持或一律禁止创作。

| 体验 | 优先查看 | 核查要点 |
| --- | --- | --- |
| 人物/信息差 | `packages/application/src/character-turn.ts`、`packages/agents`、`examples/world-packs/model-girls-dinner/cognition.json` | 按谁构建Context、初始认知的来源、谁能收到秘密 |
| 作者知识 | `desktop/host/pack-knowledge.ts`、`tests/scenarios/pack-story-slice.test.ts` | audience→when→关键词→预算，扫描输入、正文是否插值 |
| 长期记忆 | `desktop/host/memory/core-memory.ts`、`docs/current/architecture/cognition-memory.md` | 原生/Core入口、授权Source、整理/召回、分支前缀、成本 |
| 物品/交互 | `desktop/host/pack-status.ts`、`examples/templates/item-rules.js`、`packages/kernel/src/rulebook.ts` | 候选过滤和执行重查、可达/归属、受众、原子提交、实际安装能力 |
| 变量/任务/时间 | `examples/world-packs/status-market`、`tests/host/pack-status-runtime.test.ts` | schema对象/数组、truth/known/current、policy/resolve/onRoundEnd、失败不提交与一次领奖 |
| 活动/演出 | `desktop/host/pack-activity.ts`、`pack-activities.ts`、官方包活动示例 | 实际hook、成员/操作限制、public/private/internal、状态同事务、暂停恢复 |
| 条件剧情 | `WorldHostRuntime` autoStart链、`tests/scenarios/activity-auto-start.test.ts` | 检查时机、一次一场、资格、notice与观察的区别 |
| 自主行动 | `pack-autonomy.ts`、`world-runtime.ts`、`tests/scenarios/character-autonomy.test.ts` | 触发、独立预算、区域/白名单、场外机会、取消 |
| 预设/风格 | `packages/provider-chat/src/preset*.ts`、`docs/current/model-presets.md` | 节点位置、宏、文本规则阶段/限制、不改受控动作 |
| 前端 | `docs/current/guides/web-ui.md`、`pack-frontend.ts`、`frontend-adapter.ts`、`packages/frontend` | SDK实际view/actions/perform、当前optionId、参数、沙箱/网络 |
| 专属模型 | `desktop/model-connections.ts`、`desktop/host/role-providers.ts`、`world-runtime.ts` | decision/memory路由、凭据留宿主 |
| 存档分支 | `desktop/story-nodes.ts`、`docs/current/storylines.md`及测试 | 节点保存/恢复内容，不当成章节导演 |

上表未写目录的宿主文件以`desktop/host/`为根。只复制当前源格式且当前宿主可编译的示例；`tavern-social`等可能是不能运行的历史材料。命令/格式从当前package.json、schema、示例读取。

常见误判：

- 启用不等于本轮注入，常驻仍可能含EJS条件；null可能继承，不能改为false。两向递归限制分开看。
- 当前知识匹配不能默认等价酒馆regex、二级键或楼层扫描；条件只能读取接收者授权信息。
- owner=public、alwaysKnown、playerTruth与公开静态资源是不同边界，逐项核实。已知值可能过时，执行拒绝理由也不能泄露秘密。
- 对象状态不是绕过物品/位置权威事件的捷径；不要混放不同受众的字段。
- 存在created事件不等于作者可动态创建NPC；远程通信实验不等于默认宿主安装；同场private不是异地消息。
- `preset:import`处理的是模型预设，不是整张角色卡；短文本规则也要核查阶段语义。
- 同时核查文件字节、单值、条目、脚本输入输出、单次变化、模型预算，不只看条目数。
- 作者状态键和操作ID不是任意JavaScript属性名。先读`pack-status.ts`实际命名校验；例如当前采用小写连字符，`key-returned`可用而`keyReturned`和`key_returned`都不合法。配置条件、初始化和resolve中的引用须一起更新，不能仅依赖WorldPack编译发现此类错误。

## 目标宿主预检清单

以下是2026-10-22当前源码的检索快照，不是永久规格；每次转换重新确认声明及消费点。提取器只自动读取其中部分常量，剩余项须定向读源码。

| 边界 | 本次源码快照 | 核查位置 |
| --- | --- | --- |
| 知识 | 4096条、每条256关键词、每关键词512 UTF-16单元、整轮65536 UTF-16单元、配置1MiB UTF-8 | `pack-knowledge.ts`常量、load/select；单条长于本包maximumCharacters时加载即报错，用`scripts/split-knowledge.mjs`拆分；按优先级整条跳过仍可能令低优先级条目本轮进不去 |
| 文档/包 | 文档4096、单Markdown256KiB、单JSON1MiB、源总量16MiB、单asset8MiB | `world-pack/src/schema.ts`、`compiler.ts`；字节与字符不可混用 |
| 状态 | 64状态、32操作；源码256KiB UTF-8（含拼合的包内插件模块）；调用输入/输出1MiB UTF-8；单值规范JSON16384 UTF-16单元，总值524288单元；单次物品效果至多8项 | `pack-status.ts`parse、call、validateValue、reduce、parseItemChanges；实际值并非按字节计 |
| 活动 | 16操作、8 NPC；opening500 UTF-16单元；源码262144字节，通常调用输入/输出65536 UTF-16单元，simulate输入另有较高限额；VM100ms | `pack-activity.ts`constructor、load、call、simulate；不能拿simulate预算套普通hook |
| 预设 | 64提示节点，单节点32000、附加prompt 16000、总提示64000 UTF-16单元；32文本规则，替换正文4000单元 | `provider-chat/src/preset.ts`及runtime；位置是beforeContext/afterContext，不支持任意消息楼层 |
| 世界初始化 | 恰好一个PlayerSlot；角色controller为manual/scripted | `world-pack/src/compiler.ts`、`contracts.ts`，不要猜narrator类型 |

`base:take/drop/give`不应从旧演示照搬；检查当前注册，参考`examples/templates/item-rules.js`重写作者物品操作。模板是例子，不是唯一允许的实现。Interaction、Activity与状态操作分别确认入口、候选和执行，不能只发现一个类型名就判已接通。

documents的audience与usage分别检查：`director_visible/author_only`被schema接受不代表有导演消费者；当前知识注入消费`world_context/portrayal`及public/character_private，memory_seed另走初始观察。`playerTruth`会把真值送到玩家浏览器，隐藏控件不能保密。不要把私密文件登记成可公开下载的静态资源。

`status.updated`已在当前全局注册表；不能笼统声称启用状态就破坏所有旧存档。新实验仍用新目录，内容/schema/编译身份改变是否可加载需实测，不承诺迁移兼容。

证据格式用`文件:行号/函数 + 本轮检查 + 未验证`。引用历史试玩保留模型/范围；后续修复只有源码与测试时不能声称真实体验已修复。
