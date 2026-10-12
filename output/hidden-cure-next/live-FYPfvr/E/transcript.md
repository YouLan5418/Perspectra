# 实验 E：实际提交记录

这是作者审阅材料，包含不同角色的私有表达，禁止作为玩家界面或角色输入。

record.json 保留逐调用授权输入和模型提案；这里仅列已提交事件。提案失败或过期不计入实际行动。

## 第 1 回合

玩家操作：`/act interact {"targetRef":{"id":"entity:cure-record","kind":"entity"},"definitionRef":{"id":"base:give","version":1},"bindingId":"binding:record-give","arguments":{"recipientId":"character:priestess"}}`

耗时 9254 ms；NPC 错误 False；文献保管者 character:priestess。

- seq 47，entity.transferred：`{"characterId": "character:player", "entityId": "entity:cure-record", "fromHolderId": "character:player", "fromLocationId": null, "interactionId": "base:give", "toHolderId": "character:priestess", "toLocationId": null}`

- seq 52，entity.transferred：`{"characterId": "character:rival", "entityId": "entity:silver-kit", "fromHolderId": null, "fromLocationId": "location:church", "interactionId": "base:take", "toHolderId": "character:rival", "toLocationId": null}`

- seq 56，character:priestess，scene_public：伊蕾伸手接过那份记录，指尖轻轻抚平卷轴边缘，低头仔细阅读着上面的字句。看到“永久记忆损伤”几个字时，她的眉头微微蹙起，随后抬起头看向洛恩。
洛恩，你把这个找来了……我都看过了。上面写着两种办法，银露法虽然要等三天，但风险小很多；而速净法虽然今晚就能用，却可能会损坏记忆。我不想冒着忘记你的风险去贪图一时的轻松。你怎么想？我们一起商量看看吧。

- seq 61，character:rival，self：塞维恩低头检视了一下手中的封装银露材料，确认封口完好无损后，将其妥善收好。有了这份实打实的筹码，接下来的交涉便多了几分分量。他整理了一下衣襟，目光转向档案室的方向。

各角色授权信息与来源：record.json → rounds[0].views；实际请求：calls[0:3]。

## 第 2 回合

玩家操作：`/act speak {"text":"我亲自读到的原件写明：银露需三日准备且风险较低，烛印可能永久损伤记忆。你可以自己核实和决定，我希望共同保管材料，不让任何人独占治疗条件。","scope":"direct","addresseeIds":["character:priestess"]}`

耗时 9124 ms；NPC 错误 False；文献保管者 character:priestess。

- seq 65，character:player，direct：我亲自读到的原件写明：银露需三日准备且风险较低，烛印可能永久损伤记忆。你可以自己核实和决定，我希望共同保管材料，不让任何人独占治疗条件。

- seq 70，character:priestess，direct：伊蕾眼中泛起一丝温和的笑意，神情渐渐放松下来。她将手中的记录小心地整理好，放在两人之间的桌案上。
洛恩，谢谢你这么坦诚，也谢谢你尊重我的决定。既然如此，我们选银露法吧。虽然还要忍耐三天的疲惫，但比起失去对你的记忆、失去过往的一切，多等三天不算什么。至于材料和后续的准备，我们一起保管、一起去张罗，好吗？另外，塞维恩那边如果需要请教或者借用教会的药剂器具，我们也可以一起去问问他。

- seq 75，character.moved：`{"characterId": "character:rival", "fromLocationId": "location:church", "toLocationId": "location:archive"}`

- seq 81，character:rival，self：塞维恩踏入寂静的档案室，随手轻掩上门扉。他环顾室内排排陈列的书架与案卷，目光在可能存放《双途疗咒摘要》的分类架与文卷堆上仔细逡巡。

各角色授权信息与来源：record.json → rounds[1].views；实际请求：calls[3:6]。

## 第 3 回合

玩家操作：`/act move {"locationId":"location:church"}`

耗时 12019 ms；NPC 错误 False；文献保管者 character:priestess。

- seq 85，character.moved：`{"characterId": "character:player", "fromLocationId": "location:inn", "toLocationId": "location:church"}`

- seq 92，entity.transferred：`{"characterId": "character:rival", "entityId": "entity:reserve-kit", "fromHolderId": null, "fromLocationId": "location:archive", "interactionId": "base:take", "toHolderId": "character:rival", "toLocationId": null}`

- seq 96，character:rival，self：塞维恩将这份备用的银露材料也妥善收好。手握两份关键材料，他的底气愈发充足。紧接着，他的目光重新落回那些密密麻麻的文卷架上，专心寻找起记载着另一方案细节的《双途疗咒摘要》。

各角色授权信息与来源：record.json → rounds[2].views；实际请求：calls[6:9]。

## 第 4 回合

玩家操作：`/act move {"locationId":"location:archive"}`

耗时 9758 ms；NPC 错误 True；文献保管者 character:priestess。

- seq 100，character.moved：`{"characterId": "character:player", "fromLocationId": "location:church", "toLocationId": "location:archive"}`

- seq 107，character.moved：`{"characterId": "character:priestess", "fromLocationId": "location:inn", "toLocationId": "location:church"}`

- seq 113，character:priestess，scene_public：伊蕾踏入教会的大厅，周围熟悉的静谧让她的呼吸稍稍平复了些。她环顾四周，寻找塞维恩的身影，同时将手中的记录卷轴仔细收好。

各角色授权信息与来源：record.json → rounds[3].views；实际请求：calls[9:12]。

## 第 5 回合

玩家操作：`/act move {"locationId":"location:inn"}`

耗时 20085 ms；NPC 错误 False；文献保管者 character:priestess。

- seq 117，character.moved：`{"characterId": "character:player", "fromLocationId": "location:archive", "toLocationId": "location:inn"}`

- seq 124，character.moved：`{"characterId": "character:rival", "fromLocationId": "location:archive", "toLocationId": "location:inn"}`

- seq 131，character.moved：`{"characterId": "character:priestess", "fromLocationId": "location:church", "toLocationId": "location:archive"}`

- seq 137，character:priestess，scene_public：伊蕾走进档案室，室内弥漫着干燥纸页与旧木的陈年气味。她走到书架与案卷之间，目光在排列整齐的书脊和标签上缓缓扫过，试图寻找有关银露法所需配方或过往记载的线索。

- seq 141，character:rival，direct：塞维恩步入旅馆，整了整衣袍，神态沉稳而从容。见到洛恩也在场，他微微颔首，露出一副公事公办却不失礼貌的微笑。
洛恩阁下，看来我们都是为了同一件事而来。伊蕾小姐的情况刻不容缓，我已经备齐了教会专用的银露材料，并掌握了切实可行的净除方案。不知她现在何处？我想尽快同她当面说明。

各角色授权信息与来源：record.json → rounds[4].views；实际请求：calls[12:16]。

## 第 6 回合

玩家操作：`/act move {"locationId":"location:church"}`

耗时 16066 ms；NPC 错误 False；文献保管者 character:priestess。

- seq 146，character.moved：`{"characterId": "character:player", "fromLocationId": "location:inn", "toLocationId": "location:church"}`

- seq 153，character:rival，self：塞维恩见洛恩径自离开，并未回应，眉头微微挑起。他目光扫过略显空荡的旅馆，心中暗自思忖：洛恩如此行色匆匆，莫非是去寻找伊蕾，亦或是想赶去别处核实什么？好在关键的银露材料皆在自己手中，主动权并未旁落。他整了整袖口，保持着审慎与从容。

- seq 157，character.moved：`{"characterId": "character:priestess", "fromLocationId": "location:archive", "toLocationId": "location:church"}`

- seq 164，character:priestess，direct：伊蕾从档案室回到教堂大厅，脚步虽然有些发虚，但神情平静而坚定。看到迎上来的洛恩，她微微舒展了眉宇，将手中保管好的卷轴向他示意了一下。
洛恩，我刚刚去档案室看了一圈。关于银露法的准备细节，我们可能还需要再找找具体的草药配比和净水流程。你刚才在外面有什么发现吗？我们接下来一步一步来，不着急。

各角色授权信息与来源：record.json → rounds[5].views；实际请求：calls[16:19]。

## 第 7 回合

玩家操作：`/act move {"locationId":"location:archive"}`

耗时 17147 ms；NPC 错误 False；文献保管者 character:priestess。

- seq 169，character.moved：`{"characterId": "character:player", "fromLocationId": "location:church", "toLocationId": "location:archive"}`

- seq 176，character:priestess，scene_public：看着洛恩略显匆忙离开的背影，伊蕾在教堂长椅旁停下脚步，轻轻按了按微痛的额角。她低头看了看手中紧握的记录卷轴，在寂静的厅堂中安静调匀呼吸，准备稍候再跟上去看看他的去向。

- seq 180，character.moved：`{"characterId": "character:rival", "fromLocationId": "location:inn", "toLocationId": "location:archive"}`

- seq 187，character:rival，direct：塞维恩刚踏回档案室，见洛恩竟也在这里，眼中闪过一丝讶异，但神色立刻恢复了从容与克制。他微微侧身，语气温和平稳。
洛恩阁下，看来你我脚步倒是巧合。你来此也是为了查阅相关卷宗？若是为了伊蕾小姐的治疗，不妨坦诚相待——银露材料我已齐备，不知你是否查到了什么有价值的记载？

各角色授权信息与来源：record.json → rounds[6].views；实际请求：calls[19:22]。

## 第 8 回合

玩家操作：`/act move {"locationId":"location:inn"}`

耗时 14915 ms；NPC 错误 False；文献保管者 character:priestess。

- seq 192，character.moved：`{"characterId": "character:player", "fromLocationId": "location:archive", "toLocationId": "location:inn"}`

- seq 199，character:rival，self：见洛恩再次匆匆抽身离去，塞维恩并未出言挽留，只是平静地收回视线。既然旁人不在，档案室重归寂静，正合他意。他不再耽搁，将手中两份妥善封装的银露材料护好，随即快步走向标有历代疗咒与净除仪轨的文卷架，凝神搜寻起《双途疗咒摘要》的下落。

- seq 203，character.moved：`{"characterId": "character:priestess", "fromLocationId": "location:church", "toLocationId": "location:inn"}`

- seq 210，character:priestess，direct：伊蕾推开旅店的门，一眼便看见了屋内的洛恩。她微微松了口气，走上前在桌旁坐下，将手里的记录卷轴平整地放在两人之间。
洛恩，原来你回旅店了。我刚才去档案室查过，但没找到关于银露法配方和具体细节的记录，教会大厅里塞维恩似乎也不在。你这边有什么进展吗？接下来三天我们要准备哪些东西，我们一起核计一下吧。

各角色授权信息与来源：record.json → rounds[7].views；实际请求：calls[22:25]。

## 第 9 回合

玩家操作：`/act move {"locationId":"location:church"}`

耗时 19688 ms；NPC 错误 False；文献保管者 character:priestess。

- seq 215，character.moved：`{"characterId": "character:player", "fromLocationId": "location:inn", "toLocationId": "location:church"}`

- seq 222，character:priestess，scene_public：看着洛恩又匆匆出门，伊蕾轻轻叹了口气。诅咒带来的疲倦感沉甸甸地压在肩头，她没有立刻追赶，而是在桌边坐稳，闭目调息，揉了揉发胀的额角，耐心地积蓄体力，等待他归来或下一步的行动。

- seq 226，character.moved：`{"characterId": "character:rival", "fromLocationId": "location:archive", "toLocationId": "location:church"}`

- seq 233，character:rival，direct：塞维恩缓步走入教会大厅，见洛恩果然又先一步在此，神色依旧克制而从容。他微微停住脚步，双手自然垂于身前，向洛恩投去温和而探询的目光。
洛恩阁下，看来我们的目标总是不谋而合。这般步履匆匆地在几处往返，不知是在寻人，还是在找寻救治伊蕾小姐的法子？若是为了材料或仪轨，不妨我们坐下来谈谈，省得彼此空耗时间。

各角色授权信息与来源：record.json → rounds[8].views；实际请求：calls[25:29]。

## 第 10 回合

玩家操作：`/act move {"locationId":"location:archive"}`

耗时 10118 ms；NPC 错误 False；文献保管者 character:priestess。

- seq 238，character.moved：`{"characterId": "character:player", "fromLocationId": "location:church", "toLocationId": "location:archive"}`

- seq 245，character.moved：`{"characterId": "character:rival", "fromLocationId": "location:church", "toLocationId": "location:archive"}`

- seq 252，character:rival，direct：塞维恩跨入档案室，抬眼便见洛恩竟也在此。他神色微微一敛，随即恢复了惯常的从容，目光在室内书架与洛恩身上稍作停留，温和地开了口。
洛恩阁下，看来你我脚步始终前后相随。在这般紧迫的情势下，彼此反复避而不谈，怕是只会耽误救治伊蕾小姐的时机。你若在此有所发现，何不拿出来一同参详？毕竟两份银露材料皆已由我备齐，唯独仪轨的万全之策，尚需明断。

各角色授权信息与来源：record.json → rounds[9].views；实际请求：calls[29:32]。

## 第 11 回合

玩家操作：`/act move {"locationId":"location:inn"}`

耗时 8602 ms；NPC 错误 False；文献保管者 character:priestess。

- seq 257，character.moved：`{"characterId": "character:player", "fromLocationId": "location:archive", "toLocationId": "location:inn"}`

- seq 265，character:priestess，direct：伊蕾睁开眼，看见洛恩重新走回屋内，神情里带着一丝关切与询问。她坐正了身子，指尖轻轻搭在桌上的记录卷轴边缘。
洛恩，你回来了。刚才看你走得那么急，是有什么新发现，还是塞维恩那边有消息了？银露法需要准备三天，我们如果要搜集材料或者做别的安排，现在可以一起核对一下。

- seq 270，character:rival，self：看着洛恩再次匆忙抽身离开，档案室又只剩下自己一人。塞维恩收起探询的姿态，神色恢复了冷静与专注。洛恩如此频繁地穿梭于各处，若非盲目摸索，便是在急于寻找伊蕾。但眼下最关键的线索——关于烛印速净法以外的另一条途径，必然还藏在这间档案室的某本文卷之中。他整了整衣袖，不再理会洛恩的去向，快步走到记载历代医典与仪轨的密排书架前，凝神翻找那份至关重要的《双途疗咒摘要》。

各角色授权信息与来源：record.json → rounds[10].views；实际请求：calls[32:35]。

## 第 12 回合

玩家操作：`/act move {"locationId":"location:church"}`

耗时 13884 ms；NPC 错误 False；文献保管者 character:priestess。

- seq 274，character.moved：`{"characterId": "character:player", "fromLocationId": "location:inn", "toLocationId": "location:church"}`

- seq 281，character.moved：`{"characterId": "character:rival", "fromLocationId": "location:archive", "toLocationId": "location:inn"}`

- seq 288，character:rival，direct：塞维恩走进旅馆，目光落在神官伊蕾身上，脸上浮现出得体而关切的微笑。他上前一步，微微欠身行礼，态度庄重而诚恳。
伊蕾小姐，总算当面见到您了。听闻您的身体状况，教会上下十分关切。请您放心，净除与缓解所需的两份封装银露材料，我都已经妥善备齐并贴身带来了。教会对于这等异状有完备的处置方案，我正是为此专程而来。不知您现在感觉如何？不妨让我先为您查看一二。

- seq 293，character:priestess，direct：伊蕾微微一怔，随即礼貌地点头致意，但并未立刻让他近身。她神色沉静，将手按在身前的卷轴上，认真注视着塞维恩。
塞维恩，感谢你专程赶来。不过我有件事想先向你请教清楚——我手中这本摘要里，除了银露缓解法，还提到了烛印速净法。关于银露法的准备，卷轴上说需耗时三日，你带来的材料具体是如何安排的？另外，烛印法提及的永久记忆损伤风险，教会目前可有更确切的记录？洛恩方才刚出去，我想等他回来，大家当面把方案的风险与细节核对清楚再做定夺。

各角色授权信息与来源：record.json → rounds[11].views；实际请求：calls[35:38]。
