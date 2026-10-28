# 模型娘狼人杀实验包 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新建独立世界包 `model-girls-werewolf`，玩家与 6 名 AI 角色打 7 人局狼人杀，验证角色间猜忌、信息隔离和跨局记忆。

**Architecture:** 只写包内内容，不改宿主。活动脚本 `scripts/activities/werewolf.js` 采用和[谁是卧底](../../../examples/world-packs/model-girls-sweet-days/scripts/activities/undercover.js)相同的多活动格式（`definition / initialize / policy / resolve / onPublished / schedule / onOutcome`）。白天发言靠 `onPublished` 推进，夜间行动和投票都是活动操作。隐私只用 `public / private / internal` 加上结果的 `audience: 'self' | 'participants'` 来实现。

**Tech Stack:** worldpack-source/v5、包内同步 JS 脚本、Vitest 场景测试（`tests/support/fake-provider.ts`）。

**Spec:** [docs/superpowers/specs/2026-10-28-werewolf-pack-design.md](../specs/2026-10-28-werewolf-pack-design.md)

## Global Constraints

- 不改 `desktop/`、`packages/` 下任何文件；宿主默认预算（4 次 / 90 秒）不改，测试与试玩通过 `playSettings` 调到 `activityOpportunities: 20`、`activityDeadlineSeconds: 600`。
- 包 ID `pack:model-girls-werewolf`，版本 `0.1.0`，`worldpack-source/v5`；活动标识 `werewolf`（由文件名 `scripts/activities/werewolf.js` 得出）。
- 7 人：`character:player` + `character:gpt`、`character:claude`、`character:deepseek`、`character:glm`、`character:gemini`、`character:qwen`；活动 `npcIds` 固定为这 6 人（不超过宿主上限 8）。
- 身份：2 狼人、1 预言家、1 女巫、3 村民，开局在 `initialize` 中用 `Math.random` 随机发（宿主只记录这一阶段的随机数）。
- 女巫解药、毒药各一瓶，同晚只用一瓶，不能自救。投票全部投完后一次性公布，平票无人出局。狼全灭好人胜；存活狼数 ≥ 存活好人数狼胜；夜晚结算后与放逐后各判一次。
- 局末只公布全员身份，不公布夜间过程。
- 角色 `instructions` 只写身份、可用操作、胜利条件，以及“对同伴说话用定向发言，公开发言所有人都能听到”这一事实；不写策略。
- 在基于 `main` 的新分支 `feat/werewolf-pack` 上实施；当前检出里甜蜜日程包的未提交改动不得带入。工作树若与主工作区共用 `node_modules`，不要在其中运行 `pnpm install`。
- 新数据目录启动试玩，不触碰 `D:/worlds`。
- 对外名称：目标参数用显示名枚举 `['玩家', 'GPT', 'Claude', 'DeepSeek', 'GLM', 'Gemini', 'Qwen']`。

## Review Focus

1. **NPC 只提交对白、不提交操作**（夜晚狼只说话不 kill，女巫一直沉默）：回合不应推进，也不应替角色行动；连续处理在预算处停住，可重试或逃生。Task 3 的拒绝测试中加一项：狼只发布对白时 `game.turn` 不变。
2. **玩家已死后输入对白**：活动中玩家普通输入会被宿主 `speak` 定向发给全体参与者，死者发言必须被 `policy` 的 `speech: 'none'` 拒绝。Task 3 中加一项测试。
3. **刀口与毒同一人、或女巫救下刀口**：死讯须正确合并，不能报两次死或救活后仍死。Task 2 的纯函数测试覆盖。
4. **第一夜预言家或女巫已被刀**：同晚环节照常进行（死亡在天亮结算），第二夜才跳过。Task 2 中加一项测试。
5. **投给死者或自己、目标名拼错**：返回 `rejectReason`，事件数不变。Task 3 覆盖。

---

### Task 1: 包骨架与角色

**Files:**
- Create: `examples/world-packs/model-girls-werewolf/`（`worldpack.source.json`、`world.json`、`characters.json`、`locations.json`、`scenes.json`、`entities.json`、`player-slots.json`、`presentation.json`、`cognition.json`、`memory.json`、`reaction.json`、`manifestation.json`、`interactions.json`、`README.md`）
- Create: `examples/world-packs/model-girls-werewolf/scripts/activities/werewolf.js`（占位：只有 `definition`，Task 2 补全）
- Modify: `examples/world-packs/README.md`（加一行新包说明）

**Interfaces:**
- Produces: 7 个角色 ID（见全局约束），唯一地点 `location:living-room`，一个包含全部 7 人的 active 场景；`assetFiles` 包含 `scripts/activities/werewolf.js`。

- [ ] **Step 1: 建分支**

```bash
git switch -c feat/werewolf-pack main
```

把设计文档 `docs/superpowers/specs/2026-10-28-werewolf-pack-design.md` 和本计划从原检出复制过来，一并提交。

- [ ] **Step 2: 写包文件**

以 [ai-girls-hosted-guess](../../../examples/world-packs/ai-girls-hosted-guess) 的最小文件集为模板（不带 documents、markdown、web），角色 portrayal 取自 [model-girls-official/characters.json](../../../examples/world-packs/model-girls-official/characters.json) 的 GPT、Claude、DeepSeek、GLM，复制过来，不引用原路径。新增两人按设计文档的性格写 `summary / speakingStyle / drives / principles`，每人 1–2 条 drive，并沿用现有 agency principle 的写法（“只依据自己的授权经历行动”）。背景设定：六人常在客厅聚会玩桌游。`memory.json` 给 7 人 `standard` profile，attentionTopics 加入“狼人杀”“谁骗过我”“谁投了我”。不设互动绑定、状态脚本和前端。

- [ ] **Step 3: 编译校验**

Run: `corepack pnpm@11.7.0 worldpack validate examples/world-packs/model-girls-werewolf`
Expected: 校验通过，无错误。

- [ ] **Step 4: Commit**

```bash
git add examples/world-packs/model-girls-werewolf examples/world-packs/README.md docs/superpowers
git commit -m "feat(werewolf): add model-girls werewolf pack skeleton"
```

### Task 2: 活动脚本规则

**Files:**
- Modify: `examples/world-packs/model-girls-werewolf/scripts/activities/werewolf.js`
- Test: `tests/scenarios/model-girls-werewolf.test.ts`（本任务先写纯规则部分：通过 `PackActivity` 加载或直接以 `vm` 执行脚本、调用 `activityScript.resolve`。选哪种由实现者参照 [tests/host/pack-activity.test.ts](../../../tests/host/pack-activity.test.ts) 现有写法决定）

**Interfaces:**
- Produces（脚本内部约定，Task 3 的测试与假模型依赖这些键名）：
  - `game.phase`：`'night' | 'day-speak' | 'vote' | 'finished' | 'quit'`
  - `game.public`：`存活`（显示名数组）、`座位`（显示名数组）、`第几天`、`死讯`、`票型`（仅公布后）、`身份公布`（仅局末，`{显示名: 身份}`）、`statusText`、`lastResult`、`规则`
  - `game.private[id]`：`身份`（'狼人'|'预言家'|'女巫'|'村民'）、`提醒`；狼另有 `狼同伴`、`同伴提议`；预言家另有 `验人记录`（数组）；女巫另有 `今晚被刀`、`解药`、`毒药`（布尔）
  - `game.internal`：`身份表`、`夜间`（`{kill, save, poison}`）、`票`、`夜序`
  - 操作 ID：`kill`、`check`、`potion`、`vote`、`quit`；`potion` 参数 `{choice: 'save'|'poison'|'none', target?}`，其余目标参数 `{target: 显示名}`，`vote` 允许 `target: '弃票'`。

- [ ] **Step 1: 写规则测试（纯脚本，不起宿主）**

用固定身份表构造状态（绕过随机：测试直接改 `game.internal.身份表` 与对应 `private`），断言：

```ts
it('witch saving the kill target means nobody dies at dawn', ...)            // 死讯 = '平安夜'
it('poison and kill on different people both die; same person dies once', ...) // 存活人数 -2 / -1
it('witch cannot save herself and cannot use both potions in one night', ...)   // rejectReason
it('seer killed on night one still checks that night, is skipped on night two', ...)
it('ballots stay hidden until the last vote; a tie exiles nobody', ...)          // 中间结果 audience === 'self'，public 无 票型
it('wolves win when alive wolves >= alive villagers; villagers win when no wolf is left', ...)
it('the finished game reveals every role in public and nothing about the nights', ...) // 身份公布 有 7 项；lastResult 不含 验人记录/夜间
```

- [ ] **Step 2: 运行确认失败**

Run: `corepack pnpm@11.7.0 test:related tests/scenarios/model-girls-werewolf.test.ts`
Expected: FAIL（脚本尚未实现 resolve）

- [ ] **Step 3: 实现脚本**

- `definition`：`title: '狼人杀'`，`opening` 一句开场（≤500 字），`npcIds` 为 6 名 NPC，操作 5 个，均 `requiresTurn: true`，`quit` 除外。
- `initialize({playerId, npcIds})`：洗身份、洗座位，`phase: 'night'`，`turn` 为第一个存活狼。
- 夜序：狼（存活者依次）→ 女巫 → 预言家；死亡统一在天亮结算，所以当晚被刀的人仍完成当晚环节；已死的身份在之后的夜晚跳过。
- `policy(view, actorId)`：夜晚只有 `turn` 且身份为狼的人 `speech: 'free'`，其余 `'none'`；白天发言阶段只有当前发言者 `'free'`；投票阶段 `speech: 'none'`；死者始终 `'none'`；`narration` 跟随 speech；`move: false`；`operations` 只给当前回合者对应的那个操作，玩家额外有 `quit`。
- `resolve(state, actorId, operation, parameters, _world, truth)`：夜间与中间票结果 `audience: 'self'`；天亮死讯、放逐结果、局末公布 `audience: 'participants'`。第一名狼 `kill` 只写入同伴的 `同伴提议` 并把回合交给第二名狼；最后提交的狼的目标写入 `internal.夜间.kill`。女巫回合开始前把 `今晚被刀` 写入她的 private。
- `onPublished(state, actorId)`：仅在 `day-speak` 且 `turn === actorId` 时推进到下一个存活发言者；最后一人说完进入 `vote`。夜晚返回 `null`（狼说完仍须提交 `kill`）。
- `schedule` / `onOutcome`：照搬谁是卧底的 `npcToActivate`。
- 发言起点：第 N 天从 `座位` 中第 N-1 位之后的第一个存活者开始。

- [ ] **Step 4: 运行确认通过**

Run: `corepack pnpm@11.7.0 test:related tests/scenarios/model-girls-werewolf.test.ts`
Expected: PASS（7 项）

- [ ] **Step 5: Commit**

```bash
git add examples/world-packs/model-girls-werewolf/scripts tests/scenarios/model-girls-werewolf.test.ts
git commit -m "feat(werewolf): adjudicate nights, votes and victory in the pack script"
```

### Task 3: 宿主场景测试（隔离与完整对局）

**Files:**
- Modify: `tests/scenarios/model-girls-werewolf.test.ts`

**Interfaces:**
- Consumes: Task 2 的键名与操作 ID；`WorldHostCore.create({ packPath, dataDirectory, models, timeoutMs, playSettings: { activityOpportunities: 20, activityDeadlineSeconds: 600 } })`；`runtime.activityAction({ activityKey: 'werewolf', activityId, revision, operation, parameters, requestId })`；`runtime.submit(text)`；`/act speak {"text":…,"scope":"direct","addresseeIds":[…]}` 作为玩家定向发言。
- 假模型：照 [model-girls-undercover.test.ts](../../../tests/scenarios/model-girls-undercover.test.ts) 的 `fixture`，按请求中自己的 `game.private.身份` 与 `game.phase` 决策。狼先 `publish` 一句 `scope: 'direct'` 给 `狼同伴`，再 `perform kill`（目标为 `存活` 中第一个非狼）；预言家 check 第一个未验过的存活者；女巫 `potion none`；白天 `publish` 公开一句；投票投 `座位` 中自己之后第一个存活者。perform 用 `definitionRef: { id: 'activity:<op>', version: 1 }`，`arguments` 带 `activityId`、`revision`。

- [ ] **Step 1: 写测试**

```ts
it('plays a full seven-player game to a winner and reveals roles to everyone', ...)
  // 循环 ≤ 200 步：NPC 回合 request('retry')，玩家按身份提交操作或 submit；结束时 phase === 'finished'，身份公布 有 7 项
it('keeps roles, wolf talk, checks and the witch report with their owners', ...)
  // seen：非狼请求文本不含 '狼同伴'、'同伴提议' 和狼的定向台词原文；非预言家不含 '验人记录'；非女巫不含 '今晚被刀'；任何人都不含 '身份表'、'夜间'
it('refuses out-of-turn, dead-actor and invalid-target operations without new events', ...)
  // 非本人回合、死者 vote、投自己、投死者、目标名错误；每次 events 数不变
it('a wolf who only talks keeps the turn', ...)          // Review Focus 1
it('a dead player cannot speak', ...)                     // Review Focus 2：submit 抛错或被拒，事件数不变
it('a player wolf whispers to the partner only', ...)     // 用 /act speak direct；同伴有观察，其他 NPC 无
it('a second game starts fresh and everyone observed the first reveal', ...)
  // 第一局结束后 start 第二局成功、activity id 不同；读 store 事件确认 6 名 NPC 都收到了第一局公布身份的观察
```

为让玩家必为狼或必为女巫，测试在 `start` 后读到身份不合要求时 `quit` 重开（循环上限 20 次）；不修改宿主随机源。

- [ ] **Step 2: 运行**

Run: `corepack pnpm@11.7.0 test:related tests/scenarios/model-girls-werewolf.test.ts`
Expected: PASS。失败时先判断是脚本问题还是宿主行为与设计假设不符；后者停下来报告，不改宿主。

- [ ] **Step 3: 类型、Lint、格式**

Run: `corepack pnpm@11.7.0 typecheck`，`corepack pnpm@11.7.0 exec oxlint tests/scenarios/model-girls-werewolf.test.ts`，`corepack pnpm@11.7.0 exec prettier --check tests/scenarios/model-girls-werewolf.test.ts`
Expected: 全部通过。

- [ ] **Step 4: Commit**

```bash
git add tests/scenarios/model-girls-werewolf.test.ts
git commit -m "test(werewolf): drive full games through the host with a fake provider"
```

### Task 4: 真实模型试玩与记录

**Files:**
- Create: `examples/world-packs/model-girls-werewolf/PLAYTEST.md`
- Modify: `examples/world-packs/model-girls-werewolf/README.md`（启动命令、预算设置、已知限制）

- [ ] **Step 1: 启动**

```bash
corepack pnpm@11.7.0 experience:web --pack examples/world-packs/model-girls-werewolf --data-dir .tmp/werewolf-playtest-0.1.0
```

在试玩设置里把「活动连续处理机会」设为 20，「活动处理总时限」设为 600。模型使用本机配置，不记录凭证。

- [ ] **Step 2: 打 2 局**

用内置浏览器作为玩家完整打完 2 局，第二局在第一局结束后立即开。每局记录：
- 狼是否在公开发言里说漏身份，或误用公开范围私聊；
- 有无角色引用自己无权知道的信息（他人身份、验人结果、刀口）；
- 怀疑与投票是否援引了真实发生过的发言；
- 被怀疑者是否辩解、是否符合各自性格；
- 第二局是否有人提到第一局；
- 每天耗时与是否撞到预算。

查证方式：对照只读事件查询与各角色收到的观察，不凭屏幕转录下结论。

- [ ] **Step 3: 写 PLAYTEST.md**

区分“自动测试覆盖”“真实试玩看到”“未验证”。如实写失败与卡住的情况。

- [ ] **Step 4: 文档链接检查**

Run: `node scripts/docs/check-links.mjs`
Expected: 本次新增文件无断链（旧研究文件的既有断链不归本任务）。

- [ ] **Step 5: Commit**

```bash
git add examples/world-packs/model-girls-werewolf
git commit -m "docs(werewolf): record the first live playtest"
```
